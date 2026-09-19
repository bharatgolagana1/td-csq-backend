import { Schema, model, models, type Model } from 'mongoose';
import { AssessmentState, AssessorKind, Direction, FormScope, RatingKey } from '@csq/contracts';
import { defineTenantModel, type TenantFields } from '../../kernel/tenancy.js';
import { newId } from '../../kernel/ids.js';
import { ANSWER_TYPES, ASSIGNMENT_STATES, type AnswerType, type AssignmentState } from './assessments.contracts.js';

/**
 * Three collections with three different owners.
 *
 * The instrument is published by ACFI and is the same document for everyone, so
 * it is deliberately NOT tenant scoped: an operator must not be able to author
 * or amend the questions it is graded on, and a per-organisation copy of a
 * national standard would be a copy that can drift. The kernel's identity
 * collections sit outside tenancy for the same kind of reason.
 *
 * Assignments and assessments are tenant scoped and go through the plugin.
 */

/** Mongoose needs the members as plain arrays; the union stays the contract's. */
const DIRECTIONS_ENUM = [...Direction.options];
const RATING_KEYS_ENUM = [...RatingKey.options];
const FORM_SCOPES_ENUM = [...FormScope.options];
const ASSESSOR_KINDS_ENUM = [...AssessorKind.options];
const ASSESSMENT_STATES_ENUM = [...AssessmentState.options];

export interface InstrumentFollowUpDoc {
  code: string;
  prompt: string;
  revealOn: RatingKey[];
  required: boolean;
}

export interface InstrumentQuestionDoc {
  code: string;
  categoryCode: string;
  text: string;
  answerType: AnswerType;
  weightBp: number;
  scored: boolean;
  required: boolean;
  applicableDirections: Direction[];
  options: Array<{ key: string; label: string }>;
  followUps: InstrumentFollowUpDoc[];
}

export interface InstrumentDoc {
  _id: string;
  code: string;
  version: number;
  formScope: FormScope;
  /** Where the questions came from, e.g. the published ACFI survey form. */
  sourceRef: string | null;
  publishedAt: Date;
  questions: InstrumentQuestionDoc[];
}

const OptionSchema = new Schema<{ key: string; label: string }>(
  { key: { type: String, required: true }, label: { type: String, required: true } },
  { _id: false },
);

const FollowUpSchema = new Schema<InstrumentFollowUpDoc>(
  {
    code: { type: String, required: true },
    prompt: { type: String, required: true },
    revealOn: { type: [String], enum: RATING_KEYS_ENUM, required: true },
    required: { type: Boolean, required: true, default: false },
  },
  { _id: false },
);

const QuestionSchema = new Schema<InstrumentQuestionDoc>(
  {
    code: { type: String, required: true },
    categoryCode: { type: String, required: true },
    text: { type: String, required: true },
    answerType: { type: String, enum: [...ANSWER_TYPES], required: true },
    weightBp: { type: Number, required: true, default: 0 },
    scored: { type: Boolean, required: true, default: false },
    required: { type: Boolean, required: true, default: true },
    applicableDirections: { type: [String], enum: DIRECTIONS_ENUM, required: true },
    options: { type: [OptionSchema], default: [] },
    followUps: { type: [FollowUpSchema], default: [] },
  },
  { _id: false },
);

const InstrumentSchema = new Schema<InstrumentDoc>(
  {
    _id: { type: String, default: newId },
    code: { type: String, required: true },
    version: { type: Number, required: true },
    formScope: { type: String, enum: FORM_SCOPES_ENUM, required: true },
    sourceRef: { type: String, default: null },
    publishedAt: { type: Date, required: true },
    questions: { type: [QuestionSchema], required: true },
  },
  { timestamps: true },
);

// one published version per code and scope, and nothing edits it afterwards
InstrumentSchema.index({ code: 1, formScope: 1, version: 1 }, { unique: true });

const INSTRUMENT_MODEL = 'AssessmentInstrument';
const existingInstrument = models[INSTRUMENT_MODEL] as Model<InstrumentDoc> | undefined;

export const InstrumentModel: Model<InstrumentDoc> =
  existingInstrument ?? model<InstrumentDoc>(INSTRUMENT_MODEL, InstrumentSchema);

/** Cached counts, so the worklist does not open every return to draw a bar. */
export interface CompletenessDoc {
  applicableDirections: number;
  answeredDirections: number;
  percentBp: number;
}

const CompletenessSchema = new Schema<CompletenessDoc>(
  {
    applicableDirections: { type: Number, required: true, default: 0 },
    answeredDirections: { type: Number, required: true, default: 0 },
    percentBp: { type: Number, required: true, default: 0 },
  },
  { _id: false },
);

export interface BoundaryDoc {
  wall: string;
  tz: string;
  utc: Date;
}

const BoundarySchema = new Schema<BoundaryDoc>(
  {
    wall: { type: String, required: true },
    tz: { type: String, required: true },
    utc: { type: Date, required: true },
  },
  { _id: false },
);

export interface WindowsDoc {
  samplingOpens: BoundaryDoc;
  samplingCloses: BoundaryDoc;
  assessmentOpens: BoundaryDoc;
  assessmentCloses: BoundaryDoc;
}

const WindowsSchema = new Schema<WindowsDoc>(
  {
    samplingOpens: { type: BoundarySchema, required: true },
    samplingCloses: { type: BoundarySchema, required: true },
    assessmentOpens: { type: BoundarySchema, required: true },
    assessmentCloses: { type: BoundarySchema, required: true },
  },
  { _id: false },
);

export interface AssignmentDoc {
  _id: string;
  cycleId: string;
  acoOrgId: string;
  participationId: string | null;
  assessorUserId: string;
  assessorKind: AssessorKind;
  formScope: FormScope;
  instrumentId: string;
  state: AssignmentState;
  /**
   * The whole window set is copied from the cycle rather than read back on every
   * request: it is what the assessor was told when they were invited, it lets
   * the core ordering predicate check it here, and it keeps the hot path free of
   * a join onto a collection another module owns.
   */
  windows: WindowsDoc | null;
  activeFrom: Date;
  startedAt: Date | null;
  submittedAt: Date | null;
  submissionCount: number;
  currentAssessmentId: string | null;
  completeness: CompletenessDoc;
  closedReason: string | null;
  updatedAt: Date;
}

export const AssignmentModel = defineTenantModel<AssignmentDoc>({
  name: 'AssessmentAssignment',
  definition: {
    cycleId: { type: String, required: true },
    acoOrgId: { type: String, required: true },
    participationId: { type: String, default: null },
    assessorUserId: { type: String, required: true },
    assessorKind: { type: String, enum: ASSESSOR_KINDS_ENUM, required: true },
    formScope: { type: String, enum: FORM_SCOPES_ENUM, required: true },
    instrumentId: { type: String, required: true },
    state: { type: String, enum: [...ASSIGNMENT_STATES], required: true, default: 'PENDING' },
    windows: { type: WindowsSchema, default: null },
    activeFrom: { type: Date, required: true },
    startedAt: { type: Date, default: null },
    submittedAt: { type: Date, default: null },
    submissionCount: { type: Number, required: true, default: 0 },
    currentAssessmentId: { type: String, default: null },
    completeness: { type: CompletenessSchema, default: () => ({}) },
    closedReason: { type: String, default: null },
  },
  configure: (schema: Schema<AssignmentDoc & TenantFields>) => {
    // one assessor is asked once per cycle and terminal; a second invitation is
    // the same invitation, which is what makes the create route idempotent
    schema.index({ orgId: 1, cycleId: 1, acoOrgId: 1, assessorUserId: 1 }, { unique: true });
    schema.index({ orgId: 1, assessorUserId: 1, state: 1 });
    schema.index({ orgId: 1, cycleId: 1, acoOrgId: 1, assessorKind: 1 });
    schema.index({ orgId: 1, cycleId: 1, participationId: 1 });
  },
});

export interface StoredFollowUpAnswerDoc {
  code: string;
  value: string;
  updatedAt: Date;
  updatedBy: string;
}

export interface StoredDirectionalRatingDoc {
  direction: Direction;
  rating: RatingKey;
  options: string[];
  followUps: StoredFollowUpAnswerDoc[];
  updatedAt: Date;
  updatedBy: string;
}

export interface StoredAnswerDoc {
  questionCode: string;
  ratings: StoredDirectionalRatingDoc[];
  comment: string | null;
  updatedAt: Date;
}

const FollowUpAnswerSchema = new Schema<StoredFollowUpAnswerDoc>(
  {
    code: { type: String, required: true },
    value: { type: String, required: true },
    updatedAt: { type: Date, required: true },
    updatedBy: { type: String, required: true },
  },
  { _id: false },
);

const DirectionalRatingSchema = new Schema<StoredDirectionalRatingDoc>(
  {
    direction: { type: String, enum: DIRECTIONS_ENUM, required: true },
    rating: { type: String, enum: RATING_KEYS_ENUM, required: true },
    options: { type: [String], default: [] },
    followUps: { type: [FollowUpAnswerSchema], default: [] },
    // per leaf, because two tabs merge per leaf and support has to be able to
    // answer who changed this without an event log
    updatedAt: { type: Date, required: true },
    updatedBy: { type: String, required: true },
  },
  { _id: false },
);

const AnswerSchema = new Schema<StoredAnswerDoc>(
  {
    questionCode: { type: String, required: true },
    ratings: { type: [DirectionalRatingSchema], default: [] },
    comment: { type: String, default: null },
    updatedAt: { type: Date, required: true },
  },
  { _id: false },
);

export interface AssessmentDoc {
  _id: string;
  assignmentId: string;
  cycleId: string;
  acoOrgId: string;
  participationId: string | null;
  assessorUserId: string;
  assessorKind: AssessorKind;
  formScope: FormScope;
  instrumentId: string;
  state: AssessmentState;
  answers: StoredAnswerDoc[];
  /** Bumped on every accepted save. The autosave loop writes against it. */
  revision: number;
  startedAt: Date;
  lastSavedAt: Date;
  submittedAt: Date | null;
  /**
   * Set to the assignment id while this return is the open draft and unset the
   * moment it stops being one, so the unique partial index below is what decides
   * a race between two tabs both opening the form, not the handler.
   */
  openDraftKey: string | null;
  /**
   * Set on submission for a customer or external assessor, who answers once.
   * Left null for SELF, whose assessments are unlimited.
   */
  exclusiveSubmissionKey: string | null;
  completeness: CompletenessDoc;
  updatedAt: Date;
}

export const AssessmentModel = defineTenantModel<AssessmentDoc>({
  name: 'Assessment',
  definition: {
    assignmentId: { type: String, required: true },
    cycleId: { type: String, required: true },
    // the shape below the tenant column is what the scoring module reads
    // straight out of this collection, so these names are its contract too
    acoOrgId: { type: String, required: true },
    participationId: { type: String, default: null },
    assessorUserId: { type: String, required: true },
    assessorKind: { type: String, enum: ASSESSOR_KINDS_ENUM, required: true },
    formScope: { type: String, enum: FORM_SCOPES_ENUM, required: true },
    instrumentId: { type: String, required: true },
    state: { type: String, enum: ASSESSMENT_STATES_ENUM, required: true, default: 'DRAFT' },
    answers: { type: [AnswerSchema], default: [] },
    revision: { type: Number, required: true, default: 0 },
    startedAt: { type: Date, required: true },
    lastSavedAt: { type: Date, required: true },
    submittedAt: { type: Date, default: null },
    openDraftKey: { type: String, default: null },
    exclusiveSubmissionKey: { type: String, default: null },
    completeness: { type: CompletenessSchema, default: () => ({}) },
  },
  configure: (schema: Schema<AssessmentDoc & TenantFields>) => {
    schema.index({ orgId: 1, assignmentId: 1, state: 1 });
    schema.index({ orgId: 1, cycleId: 1, acoOrgId: 1, state: 1 });
    schema.index({ orgId: 1, assessorUserId: 1, state: 1 });
    schema.index(
      { orgId: 1, openDraftKey: 1 },
      { unique: true, partialFilterExpression: { openDraftKey: { $type: 'string' } } },
    );
    schema.index(
      { orgId: 1, exclusiveSubmissionKey: 1 },
      { unique: true, partialFilterExpression: { exclusiveSubmissionKey: { $type: 'string' } } },
    );
  },
});
