// How the demo's customers answer: a rating distribution centred on the
// operator's quality (skewed to Excellent / Very Good, a little NA, Fair /
// Poor with the required comment and follow-up options) and the participant
// flow itself — the link from the invitation e-mail, the OTP from the OTP
// e-mail (`revealOtp`), the form, autosave and submit — all through the
// invitations and assessments services so every event and e-mail happens.
import type { RequestContext } from '../../core/auth/session.js';
import { formFromStakeholderForm, formFromTree, formQuestionPlaces, type AnswerInput, type AssessmentForm } from '../../modules/assessments/assessments.form.js';
import type { Rating } from '../../modules/assessments/assessments.model.js';
import { patchAnswers, patchSelfAnswers, submit, submitSelf } from '../../modules/assessments/assessments.service.js';
import type { SurveyType } from '../../modules/cycles/domain/types.js';
import { invitationsConfig } from '../../modules/invitations/invitations.config.js';
import type { InvitationDto } from '../../modules/invitations/invitations.schemas.js';
import { listInvitations } from '../../modules/invitations/invitations.service.js';
import { participantStatus, requestOtp, verifyOtp } from '../../modules/invitations/participant.service.js';
import { listNotifications } from '../../modules/notifications/notifications.service.js';
import { getFormForStakeholder, getSurveyTree } from '../../modules/surveys/surveys.service.js';

import { GENERIC_LOW_COMMENTS, LOW_RATING_COMMENTS, POSITIVE_COMMENTS, SELF_COMMENTS } from './names.js';
import type { Rng } from './prng.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

// --- answers ------------------------------------------------------------------

export interface RatingProfile {
  /** 0 (poor) … 1 (excellent). */
  quality: number;
  /** Per survey head. */
  bias: Partial<Record<string, number>>;
}

/** Shares of Excellent … Poor at the two ends of the quality scale; a profile interpolates between them. */
const POOR_END = [0.04, 0.18, 0.4, 0.26, 0.12] as const;
const EXCELLENT_END = [0.58, 0.3, 0.09, 0.02, 0.01] as const;

function ratingFor(quality: number, rng: Rng): Rating {
  const weights = POOR_END.map((low, i) => low + quality * ((EXCELLENT_END[i] ?? low) - low));
  return (5 - rng.weighted(weights)) as Rating;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export interface AnswerOptions {
  /** Probability of NA per question. */
  naRate: number;
  /** Answer only the first `partial` questions (a form in progress). */
  partial?: number | undefined;
  /** Self-assessments use their own comment pool and never add follow-ups. */
  self: boolean;
}

/** Every answer `patchAnswers` needs for a complete form, with comments and follow-ups where the rules demand them. */
export function generateAnswers(form: AssessmentForm, profile: RatingProfile, rng: Rng, options: AnswerOptions): AnswerInput[] {
  const mood = (rng.next() - 0.5) * 0.24;
  const places = formQuestionPlaces(form);
  const chosen = options.partial === undefined ? places : places.slice(0, options.partial);
  return chosen.map(({ question, category }) => {
    if (rng.chance(options.naRate)) return { questionId: question.id, na: true };
    const quality = clamp(profile.quality + (profile.bias[category.code] ?? 0) + mood, 0.02, 0.98);
    const rating = ratingFor(quality, rng);
    const answer: AnswerInput = { questionId: question.id, rating };
    const low = rating <= 2;
    if (question.commentMode !== 'NONE') {
      if (low || question.commentMode === 'REQUIRED') {
        const pool = options.self ? SELF_COMMENTS : (LOW_RATING_COMMENTS[category.code] ?? GENERIC_LOW_COMMENTS);
        answer.comment = rng.pick(pool);
      } else if (!options.self && rating >= 4 && rng.chance(0.06)) {
        answer.comment = rng.pick(POSITIVE_COMMENTS);
      }
    }
    if (low && !options.self && question.followUp && question.followUp.options.length > 0) {
      answer.followUp = rng.sample(question.followUp.options, rng.int(1, Math.min(2, question.followUp.options.length)));
    }
    return answer;
  });
}

// --- forms -------------------------------------------------------------------

/** The forms of the cycle's pinned survey versions, loaded once per (version, stakeholder type). */
export class FormCache {
  private readonly forms = new Map<string, Promise<AssessmentForm>>();

  customer(surveyId: string, type: 'FF' | 'CB'): Promise<AssessmentForm> {
    return this.load(`${surveyId}:${type}`, async () => formFromStakeholderForm(await getFormForStakeholder(surveyId, type)));
  }

  self(surveyId: string): Promise<AssessmentForm> {
    return this.load(`${surveyId}:SELF`, async () => formFromTree(await getSurveyTree(surveyId)));
  }

  private load(key: string, loader: () => Promise<AssessmentForm>): Promise<AssessmentForm> {
    let form = this.forms.get(key);
    if (!form) {
      form = loader();
      this.forms.set(key, form);
    }
    return form;
  }
}

// --- the participant flow ---------------------------------------------------------

export interface AssessmentBackdate {
  startedAt: Date;
  lastSavedAt: Date;
  submittedAt: Date | null;
}

/** The instants the services stamped with the real clock and the story wants inside the window (see backdate.ts). */
export interface Backdates {
  assessments: Map<string, AssessmentBackdate>;
  invitations: Map<string, { submittedAt: Date }>;
}

export function newBackdates(): Backdates {
  return { assessments: new Map(), invitations: new Map() };
}

export interface ResponseCycle {
  id: string;
  assessmentStart: Date;
  assessmentEnd: Date;
  surveyVersions: Partial<Record<SurveyType, string | null>>;
}

export interface ResponsePlan {
  responseRate: number;
  maxSubmissions?: number | undefined;
  profile: RatingProfile;
}

export interface ResponseResult {
  invited: number;
  submitted: number;
  inProgress: number;
  opened: number;
}

type Outcome = 'SUBMIT' | 'IN_PROGRESS' | 'OPENED' | 'UNTOUCHED';

async function allInvitations(ctx: RequestContext, cycleId: string, acoId: string): Promise<InvitationDto[]> {
  const out: InvitationDto[] = [];
  for (let page = 1; ; page += 1) {
    const result = await listInvitations(ctx, { page, pageSize: 200, cycleId, acoId, sort: 'createdAt' });
    out.push(...result.data);
    if (out.length >= result.meta.total || result.data.length === 0) break;
  }
  return out;
}

/** The raw link token of every invitation e-mail the activation sent, read from the notifications log as a demo operator would. */
async function invitationTokens(ctx: RequestContext, cycleId: string, acoId: string): Promise<Map<string, string>> {
  const tokens = new Map<string, string>();
  for (let page = 1; ; page += 1) {
    const result = await listNotifications(ctx, { page, pageSize: 200, cycleId, acoId, template: 'assessment-invitation', sort: 'createdAt' });
    for (const mail of result.data) {
      const url = mail.vars['url'];
      const marker = '/assess/';
      if (typeof url !== 'string' || !mail.refs.invitationId || !url.includes(marker)) continue;
      tokens.set(mail.refs.invitationId, url.slice(url.lastIndexOf(marker) + marker.length));
    }
    if (result.data.length === 0 || page * 200 >= result.meta.total) break;
  }
  return tokens;
}

function outcomesFor(invitations: readonly InvitationDto[], plan: ResponsePlan, rng: Rng): Map<string, Outcome> {
  const shuffled = rng.shuffle([...invitations].sort((a, b) => a.id.localeCompare(b.id)));
  const submissions = Math.min(Math.round(shuffled.length * plan.responseRate), plan.maxSubmissions ?? Number.POSITIVE_INFINITY);
  const outcomes = new Map<string, Outcome>();
  shuffled.forEach((invitation, index) => {
    if (index < submissions) outcomes.set(invitation.id, 'SUBMIT');
    else {
      const roll = rng.next();
      outcomes.set(invitation.id, roll < 0.2 ? 'IN_PROGRESS' : roll < 0.55 ? 'OPENED' : 'UNTOUCHED');
    }
  });
  return outcomes;
}

/** A moment inside the window, skewed towards its start (most people answer in the first days). */
function momentIn(start: Date, end: Date, rng: Rng): Date {
  const span = end.getTime() - start.getTime();
  return new Date(start.getTime() + Math.pow(rng.next(), 1.6) * span);
}

/**
 * Walks every SENT invitation of the operator through the public flow the
 * plan assigns it: opened (the page), in progress (OTP verified, a partial
 * autosave) or submitted (full form). Timestamps the services stamp with the
 * real clock are collected for the backdating step.
 */
export async function respondToInvitations(
  ctx: RequestContext,
  cycle: ResponseCycle,
  acoId: string,
  plan: ResponsePlan,
  rng: Rng,
  forms: FormCache,
  backdates: Backdates,
): Promise<ResponseResult> {
  const invitations = (await allInvitations(ctx, cycle.id, acoId)).filter((invitation) => invitation.state === 'SENT');
  const tokens = await invitationTokens(ctx, cycle.id, acoId);
  const outcomes = outcomesFor(invitations, plan, rng);
  const windowStart = new Date(cycle.assessmentStart.getTime() + 2 * HOUR);
  const windowEnd = new Date(cycle.assessmentEnd.getTime() - 3 * HOUR);
  const result: ResponseResult = { invited: invitations.length, submitted: 0, inProgress: 0, opened: 0 };
  const { links } = invitationsConfig();

  for (const invitation of invitations) {
    const outcome = outcomes.get(invitation.id) ?? 'UNTOUCHED';
    if (outcome === 'UNTOUCHED') continue;
    const token = tokens.get(invitation.id);
    if (token === undefined) throw new Error(`No invitation e-mail found for invitation ${invitation.id}`);
    const opened = momentIn(windowStart, windowEnd, rng);
    await participantStatus(token, opened);
    result.opened += 1;
    if (outcome === 'OPENED') continue;

    const otp = await requestOtp(token, { now: new Date(opened.getTime() + MINUTE) });
    if (otp.devOtp === undefined) throw new Error('The demo runtime must reveal the OTP (revealOtp) to walk the participant flow');
    const verifiedAt = new Date(opened.getTime() + rng.int(2, 7) * MINUTE);
    const verified = await verifyOtp(token, otp.devOtp, verifiedAt);
    const surveyId = cycle.surveyVersions[invitation.surveyType];
    if (!surveyId) throw new Error(`Cycle ${cycle.id} pinned no ${invitation.surveyType} survey`);
    const form = await forms.customer(surveyId, invitation.customer.type);

    if (outcome === 'IN_PROGRESS') {
      const partial = Math.max(1, Math.round(form.questionCount * (0.3 + rng.next() * 0.4)));
      await patchAnswers(verified.assessmentId, generateAnswers(form, plan.profile, rng, { naRate: 0.04, partial, self: false }));
      backdates.assessments.set(verified.assessmentId, { startedAt: verifiedAt, lastSavedAt: new Date(verifiedAt.getTime() + 9 * MINUTE), submittedAt: null });
      result.inProgress += 1;
      continue;
    }

    await patchAnswers(verified.assessmentId, generateAnswers(form, plan.profile, rng, { naRate: 0.04, self: false }));
    const session = await links.verify(verified.sessionToken, 'participant');
    await submit(session, verified.assessmentId);
    const submittedAt = new Date(verifiedAt.getTime() + rng.int(8, 40) * MINUTE);
    backdates.assessments.set(verified.assessmentId, { startedAt: verifiedAt, lastSavedAt: new Date(submittedAt.getTime() - MINUTE), submittedAt });
    backdates.invitations.set(invitation.id, { submittedAt });
    result.submitted += 1;
  }
  return result;
}

// --- self-assessments ------------------------------------------------------------

/** The operator's own view of itself, a little rosier than its customers', for every survey type it runs. */
export async function submitSelfAssessments(
  acoCtx: RequestContext,
  cycle: ResponseCycle,
  surveyTypes: readonly SurveyType[],
  profile: RatingProfile,
  rng: Rng,
  forms: FormCache,
  backdates: Backdates,
): Promise<number> {
  let submitted = 0;
  for (const surveyType of surveyTypes) {
    const surveyId = cycle.surveyVersions[surveyType];
    if (!surveyId) continue;
    const form = await forms.self(surveyId);
    const rosier: RatingProfile = { quality: Math.min(0.98, profile.quality + 0.1), bias: profile.bias };
    await patchSelfAnswers(acoCtx, cycle.id, surveyType, generateAnswers(form, rosier, rng, { naRate: 0.01, self: true }));
    const dto = await submitSelf(acoCtx, cycle.id, surveyType);
    const submittedAt = momentIn(new Date(cycle.assessmentStart.getTime() + 24 * HOUR), new Date(cycle.assessmentEnd.getTime() - 24 * HOUR), rng);
    backdates.assessments.set(dto.id, { startedAt: new Date(submittedAt.getTime() - 35 * MINUTE), lastSavedAt: new Date(submittedAt.getTime() - MINUTE), submittedAt });
    submitted += 1;
  }
  return submitted;
}
