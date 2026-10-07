// Builders for the invitations tests: a small published survey, a cycle
// straight in the database with its participants created by the real cycles
// rules, customers in the directory, and helpers that read what the LOG
// mail transport recorded (the link in an invitation, the code in an OTP).
import type { Types } from 'mongoose';

import { withTransaction } from '../src/core/db.js';
import type { SurveyType } from '../src/core/events.js';
import { idString, newId, toId } from '../src/core/ids.js';
import type { AssessmentFormDto } from '../src/modules/assessments/assessments.schemas.js';
import { CustomerModel } from '../src/modules/customers/customers.model.js';
import { CycleModel } from '../src/modules/cycles/cycles.model.js';
import type { CycleStatus, CycleType } from '../src/modules/cycles/domain/types.js';
import { createParticipants, planParticipants } from '../src/modules/cycles/participants.service.js';
import type { CustomerType } from '../src/modules/invitations/invitations.model.js';
import { NotificationModel, type NotificationDoc } from '../src/modules/notifications/notifications.model.js';
import type { OrganisationDoc } from '../src/modules/organisations/organisations.model.js';
import { createSurveyFromDefinition, getSurveyTree, type QuestionDefinition } from '../src/modules/surveys/surveys.service.js';

export const DAY = 24 * 60 * 60 * 1000;
export const MINUTE = 60 * 1000;

// --- survey -----------------------------------------------------------------

function question(code: string, order: number, overrides: Partial<QuestionDefinition> = {}): QuestionDefinition {
  return {
    code,
    text: `Question ${code}`,
    help: null,
    order,
    weightPct: null,
    mandatory: true,
    commentMode: 'OPTIONAL',
    stakeholderTypes: ['FF', 'CB'],
    followUp: null,
    active: true,
    ...overrides,
  };
}

export interface TestSurvey {
  id: string;
  type: SurveyType;
  /** Active question ids, every one asked of both FF and CB. */
  questionIds: string[];
}

/** Two categories, three active questions (one inactive), optional comments everywhere. */
export async function createTestSurvey(type: SurveyType): Promise<TestSurvey> {
  const survey = await createSurveyFromDefinition({
    code: type,
    name: `${type} test survey`,
    version: 1,
    status: 'PUBLISHED',
    publishedAt: new Date(),
    categories: [
      {
        code: 'INFRA',
        name: 'Infrastructure',
        order: 10,
        weightPct: 50,
        subcategories: [{ code: 'STORAGE', name: 'Storage', order: 1, questions: [question('Q1', 1), question('Q2', 2)] }],
        questions: [],
      },
      {
        code: 'PROC',
        name: 'Processes',
        order: 20,
        weightPct: 50,
        subcategories: [],
        questions: [question('Q3', 1), question('Q.OFF', 2, { active: false })],
      },
    ],
  });
  const id = idString(survey._id);
  const tree = await getSurveyTree(id);
  const questionIds: string[] = [];
  for (const category of tree.categories) {
    for (const item of category.questions) if (item.active) questionIds.push(item.id);
    for (const sub of category.subcategories) for (const item of sub.questions) if (item.active) questionIds.push(item.id);
  }
  return { id, type, questionIds };
}

// --- cycle ------------------------------------------------------------------

export interface TestCycleInput {
  code: string;
  type: CycleType;
  minSampleSize: number;
  status: CycleStatus;
  samplingStart?: Date;
  samplingEnd?: Date;
  assessmentStart?: Date;
  assessmentEnd?: Date;
  surveyVersions?: { DOMESTIC?: string; INTERNATIONAL?: string };
  reminders?: { count: number; everyDays: number };
}

const edge = (at: Date) => ({ wall: at.toISOString().slice(0, 16), utc: at });

/** A cycle straight in the database with its participants created by the real cycles rules. */
export async function createTestCycle(input: TestCycleInput, operators: OrganisationDoc[]): Promise<string> {
  const samplingStart = input.samplingStart ?? new Date(Date.now() - DAY);
  const samplingEnd = input.samplingEnd ?? new Date(Date.now() + 9 * DAY);
  const assessmentStart = input.assessmentStart ?? samplingEnd;
  const assessmentEnd = input.assessmentEnd ?? new Date(assessmentStart.getTime() + 30 * DAY);
  const cycle = await CycleModel.create({
    name: `Cycle ${input.code}`,
    code: input.code,
    type: input.type,
    tz: 'Asia/Kolkata',
    sampling: { start: edge(samplingStart), end: edge(samplingEnd) },
    assessment: { start: edge(assessmentStart), end: edge(assessmentEnd) },
    minSampleSize: input.minSampleSize,
    reminders: { sampling: { count: 3, everyDays: 3 }, assessment: input.reminders ?? { count: 10, everyDays: 2 } },
    participatingAirportIds: [...new Set(operators.map((op) => idString(op.airportId as Types.ObjectId)))],
    participatingAcoIds: operators.map((op) => op._id),
    surveyVersions: {
      DOMESTIC: input.surveyVersions?.DOMESTIC ? toId(input.surveyVersions.DOMESTIC) : null,
      INTERNATIONAL: input.surveyVersions?.INTERNATIONAL ? toId(input.surveyVersions.INTERNATIONAL) : null,
    },
    status: input.status,
    publishedAt: new Date(),
  });
  await withTransaction(async (session) => {
    await createParticipants(cycle._id, planParticipants({ type: input.type, minSampleSize: input.minSampleSize }, operators), session);
  });
  return idString(cycle._id);
}

// --- customers --------------------------------------------------------------

export interface TestCustomerOptions {
  acoId: string;
  airportId: string;
  name: string;
  contactPerson: string;
  email: string;
  type: CustomerType;
  surveyType?: 'DOMESTIC' | 'INTERNATIONAL' | 'BOTH';
}

export async function createTestCustomer(options: TestCustomerOptions): Promise<string> {
  const doc = await CustomerModel.create({
    acoId: toId(options.acoId),
    airportId: toId(options.airportId),
    name: options.name,
    contactPerson: options.contactPerson,
    email: options.email,
    phone: '+919999900000',
    type: options.type,
    surveyType: options.surveyType ?? 'BOTH',
    status: 'ACTIVE',
    tags: [],
  });
  return idString(doc._id);
}

/** One entry of a `sample.locked` payload. */
export function sampleOf(customerId: string, surveyType: SurveyType): { sampleId: string; customerId: string; surveyType: SurveyType } {
  return { sampleId: idString(newId()), customerId, surveyType };
}

// --- what the mail log recorded ---------------------------------------------

const LINK = /\/assess\/([A-Za-z0-9_-]{43})/;

export async function mailsFor(invitationId: string, template?: string): Promise<NotificationDoc[]> {
  return NotificationModel.find({ 'refs.invitationId': toId(invitationId), ...(template ? { template } : {}) })
    .sort({ createdAt: 1, _id: 1 })
    .lean<NotificationDoc[]>();
}

/** The raw link token from the most recent e-mail of the given template (invitation or reminder). */
export async function tokenFromMail(invitationId: string, template = 'assessment-invitation'): Promise<string> {
  const mails = await mailsFor(invitationId, template);
  const last = mails[mails.length - 1];
  const match = last ? LINK.exec(last.body) : null;
  if (!match?.[1]) throw new Error(`No ${template} link for invitation ${invitationId}`);
  return match[1];
}

/** The six digits from the most recent OTP e-mail of an invitation. */
export async function otpFromMail(invitationId: string): Promise<string> {
  const mails = await mailsFor(invitationId, 'assessment-otp');
  const last = mails[mails.length - 1];
  const otp = last?.vars['otp'];
  if (typeof otp !== 'string') throw new Error(`No OTP e-mail for invitation ${invitationId}`);
  return otp;
}

// --- answering --------------------------------------------------------------

export function formQuestionIds(form: AssessmentFormDto): string[] {
  const ids: string[] = [];
  for (const category of form.categories) {
    for (const item of category.questions) ids.push(item.id);
    for (const sub of category.subcategories) for (const item of sub.questions) ids.push(item.id);
  }
  return ids;
}

export function answersFor(questionIds: readonly string[], rating = 4): { questionId: string; rating: number }[] {
  return questionIds.map((questionId) => ({ questionId, rating }));
}
