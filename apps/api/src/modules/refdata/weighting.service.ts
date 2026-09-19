import type { WeightingProfile as CoreWeightingProfile, QuestionSpec } from '@csq/core';
import { directionsFor, type FormScope } from '@csq/contracts';
import { conflict, fail, notFound } from '../../kernel/errors.js';
import { WeightingProfileModel, type WeightingProfileDoc } from './refdata.models.js';
import { readSnapshot } from './questionBank.service.js';
import { BP_TOTAL, WeightTable, type SnapshotContent } from './refdata.contracts.js';
import type { z } from 'zod';

/**
 * Weights in basis points, never percentages. A category at 33.33 percent and
 * a category at 3333 basis points are the same number until three of them have
 * to add up exactly, and then only one of them does.
 *
 * The profile names the exact snapshot it weights. Weights that float free of
 * an instrument cannot be checked against anything, and a score whose weights
 * cannot be reproduced is not a score anyone can defend.
 */

const SCOPES: readonly FormScope[] = ['INTERNATIONAL', 'DOMESTIC'];

export interface WeightingProfileView {
  profileId: string;
  code: string;
  version: number;
  title: string;
  basis: 'EQUAL' | 'CONFIGURED';
  state: WeightingProfileDoc['state'];
  snapshotId: string;
  notes: string | null;
  publishedAt: string | null;
  weights: z.infer<typeof WeightTable> | null;
}

function toView(doc: WeightingProfileDoc): WeightingProfileView {
  const parsed = WeightTable.safeParse(doc.weights);
  return {
    profileId: doc._id,
    code: doc.code,
    version: doc.version,
    title: doc.title,
    basis: doc.basis,
    state: doc.state,
    snapshotId: doc.snapshotId,
    notes: doc.notes,
    publishedAt: doc.publishedAt ? doc.publishedAt.toISOString() : null,
    weights: parsed.success ? parsed.data : null,
  };
}

export async function listPublishedProfiles(): Promise<WeightingProfileView[]> {
  const rows = await WeightingProfileModel.find({ state: 'PUBLISHED' }).sort({ code: 1 }).lean().exec();
  return rows.map(toView);
}

/** Only a published profile is visible outside the platform: a draft is not a standard. */
export async function readPublishedProfile(profileId: string): Promise<WeightingProfileView> {
  const doc = await WeightingProfileModel.findOne({ _id: profileId, state: 'PUBLISHED' }).lean().exec();
  if (!doc) throw notFound('No such weighting profile');
  return toView(doc);
}

export async function readProfileForPlatform(profileId: string): Promise<WeightingProfileView> {
  return toView(await requireProfile(profileId));
}

async function requireProfile(profileId: string): Promise<WeightingProfileDoc> {
  const doc = await WeightingProfileModel.findOne({ _id: profileId }).lean().exec();
  if (!doc) throw notFound('No such weighting profile');
  return doc;
}

export async function createProfile(input: {
  code: string;
  title: string;
  basis: 'EQUAL' | 'CONFIGURED';
  snapshotId: string;
  notes: string | null;
}): Promise<WeightingProfileView> {
  // resolving the snapshot first means a profile can never name an instrument
  // that does not exist, which is what makes the gate below able to run at all
  await readSnapshot(input.snapshotId);

  const latest = await WeightingProfileModel.find({ code: input.code })
    .sort({ version: -1 })
    .limit(1)
    .select('version')
    .lean()
    .exec();
  const version = (latest[0]?.version ?? 0) + 1;

  const created = await WeightingProfileModel.create({
    code: input.code,
    version,
    title: input.title,
    basis: input.basis,
    state: 'DRAFT',
    snapshotId: input.snapshotId,
    weights: {},
    notes: input.notes,
  });
  return toView(created.toObject());
}

export async function putWeights(
  profileId: string,
  weights: z.infer<typeof WeightTable>,
): Promise<WeightingProfileView> {
  const current = await requireProfile(profileId);
  if (current.state !== 'DRAFT') {
    throw conflict(`Profile ${current.code} v${current.version} is ${current.state}. Create a new version instead.`);
  }

  const updated = await WeightingProfileModel.findOneAndUpdate(
    { _id: profileId, state: 'DRAFT' },
    { $set: { weights } },
    { new: true },
  )
    .lean()
    .exec();
  if (!updated) throw conflict('The profile changed while it was being saved');
  return toView(updated);
}

export interface WeightProblem {
  path: string;
  message: string;
}

/**
 * The publish gate. It answers one question in full: do these weights describe
 * exactly this instrument, and do they add up. Every problem is reported at
 * once, because fixing a weights table one refusal at a time is how the
 * arithmetic ends up wrong in a different place each round.
 */
export function checkWeights(content: SnapshotContent, rawWeights: unknown): WeightProblem[] {
  const parsed = WeightTable.safeParse(rawWeights);
  if (!parsed.success) {
    return parsed.error.issues.map((issue) => ({
      path: issue.path.join('.') || '(root)',
      message: issue.message,
    }));
  }
  const weights = parsed.data;
  const problems: WeightProblem[] = [];

  for (const scope of SCOPES) {
    const scoped = weights[scope];
    const applicable = content.questions.filter(
      (question) => question.scopes.includes(scope) && question.scored && question.answerType === 'RATING_5',
    );
    if (applicable.length === 0) {
      problems.push({ path: scope, message: 'the instrument has no scored questions on this form' });
      continue;
    }

    const categoriesInUse = new Set(applicable.map((question) => question.categoryCode));

    for (const code of Object.keys(scoped.categories)) {
      if (!categoriesInUse.has(code)) {
        problems.push({ path: `${scope}.categories.${code}`, message: 'no scored question on this form uses it' });
      }
    }
    for (const code of categoriesInUse) {
      if (scoped.categories[code] === undefined) {
        problems.push({ path: `${scope}.categories.${code}`, message: 'carries questions on this form but has no weight' });
      }
    }

    const categoryTotal = sum(Object.values(scoped.categories));
    if (categoryTotal !== BP_TOTAL) {
      problems.push({
        path: `${scope}.categories`,
        message: `category weights total ${categoryTotal} basis points, not ${BP_TOTAL}`,
      });
    }

    const applicableCodes = new Set(applicable.map((question) => question.code));
    for (const code of Object.keys(scoped.questions)) {
      if (!applicableCodes.has(code)) {
        problems.push({
          path: `${scope}.questions.${code}`,
          message: 'is not a scored question on this form',
        });
      }
    }

    const byCategory = new Map<string, number>();
    for (const question of applicable) {
      const weight = scoped.questions[question.code];
      if (weight === undefined) {
        problems.push({ path: `${scope}.questions.${question.code}`, message: 'has no weight' });
        continue;
      }
      byCategory.set(question.categoryCode, (byCategory.get(question.categoryCode) ?? 0) + weight);
    }
    for (const [code, total] of byCategory) {
      if (total !== BP_TOTAL) {
        problems.push({
          path: `${scope}.questions`,
          message: `${code} question weights total ${total} basis points, not ${BP_TOTAL}`,
        });
      }
    }
  }

  return problems;
}

export interface ProfileValidation {
  profileId: string;
  snapshotId: string;
  publishable: boolean;
  problems: WeightProblem[];
}

export async function validateProfile(profileId: string): Promise<ProfileValidation> {
  const profile = await requireProfile(profileId);
  const snapshot = await readSnapshot(profile.snapshotId);
  const problems = checkWeights(snapshot.content, profile.weights);
  return { profileId, snapshotId: profile.snapshotId, publishable: problems.length === 0, problems };
}

export async function publishProfile(
  profileId: string,
  publishedBy: string | null,
): Promise<WeightingProfileView> {
  const profile = await requireProfile(profileId);
  if (profile.state !== 'DRAFT') throw conflict(`Profile is ${profile.state}, not a draft`);

  const snapshot = await readSnapshot(profile.snapshotId);
  const problems = checkWeights(snapshot.content, profile.weights);
  if (problems.length > 0) {
    throw fail('WEIGHTS_DO_NOT_SUM', 'These weights do not describe this instrument', problems);
  }

  await WeightingProfileModel.updateMany(
    { code: profile.code, state: 'PUBLISHED' },
    { $set: { state: 'RETIRED' } },
  ).exec();

  const published = await WeightingProfileModel.findOneAndUpdate(
    { _id: profileId, state: 'DRAFT' },
    { $set: { state: 'PUBLISHED', publishedAt: new Date(), publishedBy } },
    { new: true },
  )
    .lean()
    .exec();
  if (!published) throw conflict('The profile changed while it was being published');
  return toView(published);
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

/**
 * The bridge into the pure scorer. The scoring module asks for these two and
 * never reads a refdata collection itself, so the instrument and its weights
 * reach the pipeline as one consistent pair or not at all.
 */
export function toCoreProfile(profile: WeightingProfileView): CoreWeightingProfile {
  if (!profile.weights) {
    throw fail('INTERNAL', `Weighting profile ${profile.profileId} has no usable weights`);
  }
  return {
    profileId: profile.profileId,
    version: profile.version,
    weightingBasis: profile.basis,
    categoryWeightBp: {
      INTERNATIONAL: { ...profile.weights.INTERNATIONAL.categories },
      DOMESTIC: { ...profile.weights.DOMESTIC.categories },
    },
  };
}

export function toQuestionSpecs(
  content: SnapshotContent,
  profile: WeightingProfileView,
  scope: FormScope,
): Map<string, QuestionSpec> {
  if (!profile.weights) {
    throw fail('INTERNAL', `Weighting profile ${profile.profileId} has no usable weights`);
  }
  const scoped = profile.weights[scope];
  // the directions a form asks for are a property of the form, not of the
  // question, so they come from the contract rather than from the bank
  const directions = directionsFor(scope);

  const specs = new Map<string, QuestionSpec>();
  for (const question of content.questions) {
    if (!question.scopes.includes(scope)) continue;
    specs.set(question.code, {
      code: question.code,
      categoryCode: question.categoryCode,
      answerType: question.answerType,
      weightBp: scoped.questions[question.code] ?? 0,
      scored: question.scored,
      applicableDirections: directions,
    });
  }
  return specs;
}
