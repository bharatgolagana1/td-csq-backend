import type { FormScope } from '@csq/contracts';
import { conflict, notFound } from '../../kernel/errors.js';
import { InstrumentModel, type InstrumentDoc } from './assessments.models.js';
import type { InstrumentQuery, PublishInstrument } from './assessments.contracts.js';

/**
 * The instrument is the form as it was published: the questions, the directions
 * each one is asked in, and the follow-ups a low rating reveals.
 *
 * It is immutable. There is no update path and no delete path, because a return
 * already in progress must keep being answered and scored against exactly the
 * questions it was served. A correction is a new version, which leaves the old
 * one readable for every assessment that points at it.
 *
 * Question weights are relative within their category and the scoring pipeline
 * renormalises them, so they are deliberately not forced to sum to anything
 * here. The weighting profile that must sum is a category-level document and
 * belongs to scoring, not to the runtime.
 */

const DUPLICATE_KEY = 11000;

function isDuplicateKey(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: unknown }).code === DUPLICATE_KEY
  );
}

export interface InstrumentSummary {
  id: string;
  code: string;
  version: number;
  formScope: FormScope;
  sourceRef: string | null;
  publishedAt: string;
  questionCount: number;
  categoryCount: number;
}

export interface InstrumentView extends InstrumentSummary {
  questions: InstrumentDoc['questions'];
}

function toSummary(doc: InstrumentDoc): InstrumentSummary {
  return {
    id: doc._id,
    code: doc.code,
    version: doc.version,
    formScope: doc.formScope,
    sourceRef: doc.sourceRef,
    publishedAt: doc.publishedAt.toISOString(),
    questionCount: doc.questions.length,
    categoryCount: new Set(doc.questions.map((q) => q.categoryCode)).size,
  };
}

export function toInstrumentView(doc: InstrumentDoc): InstrumentView {
  return { ...toSummary(doc), questions: doc.questions };
}

export async function publishInstrument(input: PublishInstrument, now: Date): Promise<InstrumentView> {
  try {
    const created = await InstrumentModel.create({
      code: input.code,
      version: input.version,
      formScope: input.formScope,
      sourceRef: input.sourceRef,
      publishedAt: now,
      questions: input.questions,
    });
    return toInstrumentView(created.toObject());
  } catch (error) {
    if (isDuplicateKey(error)) {
      throw conflict(`${input.code} version ${input.version} for ${input.formScope} is already published`);
    }
    throw error;
  }
}

export async function loadInstrument(instrumentId: string): Promise<InstrumentDoc> {
  const doc = await InstrumentModel.findById(instrumentId).lean().exec();
  if (!doc) throw notFound('No such instrument');
  return doc;
}

export async function readInstrument(instrumentId: string): Promise<InstrumentView> {
  return toInstrumentView(await loadInstrument(instrumentId));
}

export async function listInstruments(query: InstrumentQuery): Promise<InstrumentSummary[]> {
  const filter: Record<string, unknown> = {};
  if (query.formScope) filter['formScope'] = query.formScope;
  if (query.code) filter['code'] = query.code;

  const rows = await InstrumentModel.find(filter).sort({ code: 1, version: -1 }).lean().exec();
  return rows.map(toSummary);
}
