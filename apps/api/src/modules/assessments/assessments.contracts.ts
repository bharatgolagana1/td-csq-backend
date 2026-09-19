import { z } from 'zod';
import { AssessorKind, Direction, FormScope, RatingKey, Ulid, isDirectionValidFor } from '@csq/contracts';

/**
 * Wire shapes for the assessment runtime.
 *
 * The answer document itself is the locked shape from @csq/contracts and is not
 * redefined here. What this file adds is everything around it: the instrument a
 * return is answered against, the assignment that entitles someone to answer,
 * and the patch operations autosave sends.
 */

export const ANSWER_TYPES = ['RATING_5', 'TEXT', 'SINGLE_SELECT'] as const;
export const AnswerType = z.enum(ANSWER_TYPES);
export type AnswerType = z.infer<typeof AnswerType>;

export const InstrumentOption = z
  .object({ key: z.string().min(1).max(80), label: z.string().min(1).max(200) })
  .strict();

/**
 * A follow-up is revealed by the rating given, not by a separate question. The
 * ratings that reveal it are part of the instrument rather than a global rule,
 * because the published forms reveal different prompts at different points.
 */
export const InstrumentFollowUp = z
  .object({
    code: z.string().min(1).max(120),
    prompt: z.string().min(1).max(500),
    revealOn: z.array(RatingKey).min(1).max(6),
    required: z.boolean().default(false),
  })
  .strict();

export const InstrumentQuestion = z
  .object({
    code: z.string().min(1).max(120),
    categoryCode: z.string().min(1).max(120),
    text: z.string().min(1).max(2000),
    answerType: AnswerType,
    /** Only a scored RATING_5 question may carry weight. Checked below. */
    weightBp: z.number().int().min(0).max(10_000),
    scored: z.boolean(),
    /** A question that must be answered before the return may be submitted. */
    required: z.boolean().default(true),
    applicableDirections: z.array(Direction).min(1).max(2),
    options: z.array(InstrumentOption).max(32).default([]),
    followUps: z.array(InstrumentFollowUp).max(16).default([]),
  })
  .strict();
export type InstrumentQuestionInput = z.infer<typeof InstrumentQuestion>;

function duplicates(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const twice = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) twice.add(value);
    seen.add(value);
  }
  return [...twice];
}

/**
 * Publishing an instrument is a one-way act: a published version is never
 * edited, because a return already in progress must keep being scored against
 * the questions it was actually served.
 */
export const PublishInstrument = z
  .object({
    code: z
      .string()
      .min(2)
      .max(60)
      .regex(/^[A-Z0-9][A-Z0-9._-]*$/, 'upper case letters, digits, dot, dash and underscore only'),
    version: z.number().int().min(1).max(10_000),
    formScope: FormScope,
    sourceRef: z.string().min(1).max(200).nullable().default(null),
    questions: z.array(InstrumentQuestion).min(1).max(500),
  })
  .strict()
  .superRefine((value, ctx) => {
    for (const code of duplicates(value.questions.map((q) => q.code))) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['questions'], message: `${code} appears twice` });
    }

    value.questions.forEach((question, index) => {
      const at = (field: string, message: string): void => {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['questions', index, field], message });
      };

      for (const direction of question.applicableDirections) {
        if (!isDirectionValidFor(value.formScope, direction)) {
          at('applicableDirections', `${direction} is not a direction a ${value.formScope} form asks for`);
        }
      }
      for (const direction of duplicates(question.applicableDirections)) {
        at('applicableDirections', `${direction} appears twice`);
      }
      if (question.scored && question.answerType !== 'RATING_5') {
        at('scored', 'only a RATING_5 question can be scored');
      }
      if (question.scored && question.weightBp <= 0) {
        at('weightBp', 'a scored question needs a weight');
      }
      if (!question.scored && question.weightBp !== 0) {
        at('weightBp', 'an unscored question must carry no weight');
      }
      for (const code of duplicates(question.options.map((o) => o.key))) {
        at('options', `${code} appears twice`);
      }
      for (const code of duplicates(question.followUps.map((f) => f.code))) {
        at('followUps', `${code} appears twice`);
      }
      if (question.answerType !== 'RATING_5' && question.followUps.length > 0) {
        at('followUps', 'a follow-up is revealed by a rating, so only a RATING_5 question may declare one');
      }
    });
  });
export type PublishInstrument = z.infer<typeof PublishInstrument>;

export const InstrumentQuery = z
  .object({
    formScope: FormScope.optional(),
    code: z.string().min(1).max(60).optional(),
  })
  .strict();
export type InstrumentQuery = z.infer<typeof InstrumentQuery>;

/**
 * A boundary arrives resolved: the wall time an administrator typed, the zone
 * it was typed in, and the instant it resolved to. The resolution itself is the
 * cycles module's job and is deliberately not repeated here, because two
 * resolvers that drift are worse than one. What this module does instead is
 * check the triple against itself, so an instant that does not actually fall at
 * that wall time in that zone is refused.
 */
const WALL_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;

export const BoundaryInput = z
  .object({
    wall: z.string().regex(WALL_RE, 'must be a local date and time, e.g. 2026-04-12T00:00'),
    tz: z.string().min(3).max(64),
    utc: z.string().datetime({ offset: true }),
  })
  .strict();
export type BoundaryInput = z.infer<typeof BoundaryInput>;

export const WindowsInput = z
  .object({
    samplingOpens: BoundaryInput,
    samplingCloses: BoundaryInput,
    assessmentOpens: BoundaryInput,
    assessmentCloses: BoundaryInput,
  })
  .strict();
export type WindowsInput = z.infer<typeof WindowsInput>;

export const ASSIGNMENT_STATES = ['PENDING', 'IN_PROGRESS', 'COMPLETED', 'DECLINED', 'REVOKED'] as const;
export const AssignmentState = z.enum(ASSIGNMENT_STATES);
export type AssignmentState = z.infer<typeof AssignmentState>;

export const CreateAssignment = z
  .object({
    cycleId: Ulid,
    /** The assessed operator's organisation, which is what scoring rolls up. */
    acoOrgId: Ulid,
    /** One operator may run two terminals in one cycle. Null when it runs one. */
    participationId: Ulid.nullable().default(null),
    assessorUserId: Ulid,
    assessorKind: AssessorKind,
    formScope: FormScope,
    instrumentId: Ulid,
    /** The cycle's windows as the cycle published them. Never needed for SELF. */
    windows: WindowsInput.nullable().default(null),
    /**
     * When this particular assessor may begin, which is not always when the
     * cycle opened: a customer sampled late is invited after assessment has
     * already started, and that is an explicit requirement rather than a fault.
     */
    activeFrom: z.string().datetime({ offset: true }).nullable().default(null),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.assessorKind !== 'SELF' && value.windows === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['windows'],
        message: 'a customer or external assignment is gated on the cycle assessment window',
      });
    }
  });
export type CreateAssignment = z.infer<typeof CreateAssignment>;

export const AssignmentQuery = z
  .object({
    cycleId: Ulid.optional(),
    acoOrgId: Ulid.optional(),
    participationId: Ulid.optional(),
    assessorKind: AssessorKind.optional(),
    state: AssignmentState.optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    /** Ids are ULIDs, so the last id of a page is also its high-water mark. */
    cursor: Ulid.optional(),
  })
  .strict();
export type AssignmentQuery = z.infer<typeof AssignmentQuery>;

export const WorklistQuery = z
  .object({
    cycleId: Ulid.optional(),
    acoOrgId: Ulid.optional(),
    includeFinished: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
  })
  .strict();
export type WorklistQuery = z.infer<typeof WorklistQuery>;

export const ReasonBody = z.object({ reason: z.string().min(3).max(500) }).strict();

export const AssignmentParams = z.object({ assignmentId: Ulid });
export const AssessmentParams = z.object({ assessmentId: Ulid });
export const InstrumentParams = z.object({ instrumentId: Ulid });
export const CompletionParams = z.object({ cycleId: Ulid, acoOrgId: Ulid });
export const CompletionQuery = z.object({ participationId: Ulid.optional() }).strict();
export type CompletionQuery = z.infer<typeof CompletionQuery>;

const questionCode = z.string().min(1).max(120);

/**
 * Autosave sends operations, not the document. A browser tab that PUTs the
 * whole return back erases whatever the other tab typed thirty seconds ago,
 * and an assessor with the form open on a laptop and a tablet is ordinary.
 */
export const AnswerOp = z.discriminatedUnion('op', [
  z.object({ op: z.literal('SET_RATING'), questionCode, direction: Direction, rating: RatingKey }).strict(),
  z.object({ op: z.literal('CLEAR_RATING'), questionCode, direction: Direction }).strict(),
  z
    .object({
      op: z.literal('SET_OPTIONS'),
      questionCode,
      direction: Direction,
      options: z.array(z.string().min(1).max(80)).max(32),
    })
    .strict(),
  z
    .object({
      op: z.literal('SET_FOLLOW_UP'),
      questionCode,
      direction: Direction,
      code: z.string().min(1).max(120),
      /** Empty clears the answer, so a tab that deletes its text is not a no-op. */
      value: z.string().max(2000),
    })
    .strict(),
  z.object({ op: z.literal('SET_COMMENT'), questionCode, comment: z.string().max(2000).nullable() }).strict(),
]);
export type AnswerOp = z.infer<typeof AnswerOp>;

export const AnswerPatch = z.object({ ops: z.array(AnswerOp).min(1).max(200) }).strict();
export type AnswerPatch = z.infer<typeof AnswerPatch>;
