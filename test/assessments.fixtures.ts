// Builders for the assessments tests: a small published survey with one
// question per comment mode, customers straight in the database, and cycles
// straight in the database with their participants created by the real
// cycles rules (the way the sampling tests build theirs), so `getCycle` /
// `getParticipant` and the cycles listener run for real.
import type { Types } from 'mongoose';

import { scopeForOrg, type RequestContext } from '../src/core/auth/session.js';
import { withTransaction } from '../src/core/db.js';
import type { CycleStatus, SurveyType } from '../src/core/events.js';
import { idString, toId } from '../src/core/ids.js';
import type { CustomerType } from '../src/modules/assessments/assessments.model.js';
import { CustomerModel } from '../src/modules/customers/customers.model.js';
import { CycleModel } from '../src/modules/cycles/cycles.model.js';
import type { CycleType } from '../src/modules/cycles/domain/types.js';
import { createParticipants } from '../src/modules/cycles/participants.service.js';
import type { OrganisationDoc } from '../src/modules/organisations/organisations.model.js';
import { createSurveyFromDefinition, getSurveyTree, type QuestionDefinition } from '../src/modules/surveys/surveys.service.js';

import type { TestUser } from './helpers/app.js';

// --- request context --------------------------------------------------------

/** The `req.ctx` a route would resolve for a test user, for calling a service directly. */
export function ctxOf(user: TestUser, tasks: readonly string[] = []): RequestContext {
  const org = {
    id: idString(user.org._id),
    type: user.org.type,
    code: user.org.code,
    name: user.org.name,
    airportId: user.org.airportId ? idString(user.org.airportId) : null,
  };
  return {
    user: { id: idString(user.user._id), email: user.user.email, name: user.user.name, status: user.user.status },
    org,
    role: { id: idString(user.role._id), code: user.role.code, scope: user.role.scope },
    tasks: new Set(tasks),
    scope: scopeForOrg(org),
    requestId: `test-${idString(user.user._id)}`,
    ip: '127.0.0.1',
  };
}

// --- survey -----------------------------------------------------------------

export const FOLLOW_UP_OPTIONS = ['Long delay', 'Damaged cargo', 'Staff unhelpful'];

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
  /** question code → id */
  q: Record<string, string>;
  /** category / subcategory code → id */
  section: Record<string, string>;
}

/**
 * INFRA (weight 40): direct   ⟶ Q.LOW (comment on Fair/Poor + follow-up; FF only)
 *                    STORAGE ⟶ Q.OPT (optional comment), Q.REQ (comment required)
 * PROC  (weight 60): direct   ⟶ Q.NONE (no comment; CB only), Q.OFF (inactive), Q.PLAIN
 * Display order is a category's direct questions, then its subcategories:
 * FF form: Q.LOW Q.OPT Q.REQ Q.PLAIN · CB form: Q.OPT Q.REQ Q.NONE Q.PLAIN · SELF: all five active.
 */
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
        weightPct: 40,
        subcategories: [
          {
            code: 'STORAGE',
            name: 'Storage',
            order: 1,
            questions: [question('Q.OPT', 1, { help: 'Rate the storage' }), question('Q.REQ', 2, { commentMode: 'REQUIRED' })],
          },
        ],
        questions: [
          question('Q.LOW', 1, {
            commentMode: 'REQUIRED_ON_LOW',
            stakeholderTypes: ['FF'],
            followUp: { prompt: 'What went wrong?', options: [...FOLLOW_UP_OPTIONS] },
          }),
        ],
      },
      {
        code: 'PROC',
        name: 'Processes',
        order: 20,
        weightPct: 60,
        subcategories: [],
        questions: [
          question('Q.NONE', 1, { commentMode: 'NONE', stakeholderTypes: ['CB'] }),
          question('Q.OFF', 2, { active: false }),
          question('Q.PLAIN', 3),
        ],
      },
    ],
  });
  const id = idString(survey._id);
  const tree = await getSurveyTree(id);
  const q: Record<string, string> = {};
  const section: Record<string, string> = {};
  for (const category of tree.categories) {
    section[category.code] = category.id;
    for (const item of category.questions) q[item.code] = item.id;
    for (const sub of category.subcategories) {
      section[sub.code] = sub.id;
      for (const item of sub.questions) q[item.code] = item.id;
    }
  }
  return { id, type, q, section };
}

// --- customers --------------------------------------------------------------

export interface TestCustomerOptions {
  acoId: string;
  airportId: string;
  name: string;
  contactPerson: string;
  email: string;
  type: CustomerType;
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
    surveyType: 'BOTH',
    status: 'ACTIVE',
    tags: [],
  });
  return idString(doc._id);
}

// --- cycles -----------------------------------------------------------------

const DAY = 86_400_000;
const edge = (at: Date) => ({ wall: at.toISOString().slice(0, 16), utc: at });

export interface TestParticipant {
  org: OrganisationDoc;
  surveyTypes: SurveyType[];
}

export interface TestCycleOptions {
  code: string;
  type?: CycleType;
  status: CycleStatus;
  surveyVersions: { DOMESTIC: string | null; INTERNATIONAL: string | null };
  participants: TestParticipant[];
}

export interface TestCycle {
  id: string;
  code: string;
  name: string;
}

/** A published cycle straight in the database (sampling over, assessment running) with its participants created by the real cycles rules. */
export async function createTestCycle(options: TestCycleOptions): Promise<TestCycle> {
  const now = Date.now();
  const airportOf = (org: OrganisationDoc): Types.ObjectId => {
    if (!org.airportId) throw new Error(`Test operator ${org.code} has no airport`);
    return org.airportId;
  };
  const cycle = await CycleModel.create({
    name: `Cycle ${options.code}`,
    code: options.code,
    type: options.type ?? 'BOTH',
    tz: 'Asia/Kolkata',
    sampling: { start: edge(new Date(now - 20 * DAY)), end: edge(new Date(now - 10 * DAY)) },
    assessment: { start: edge(new Date(now - 10 * DAY)), end: edge(new Date(now + 20 * DAY)) },
    minSampleSize: 1,
    reminders: { sampling: { count: 3, everyDays: 3 }, assessment: { count: 10, everyDays: 2 } },
    participatingAirportIds: [...new Set(options.participants.map((p) => idString(airportOf(p.org))))].map((id) => toId(id)),
    participatingAcoIds: options.participants.map((p) => p.org._id),
    surveyVersions: {
      DOMESTIC: options.surveyVersions.DOMESTIC ? toId(options.surveyVersions.DOMESTIC) : null,
      INTERNATIONAL: options.surveyVersions.INTERNATIONAL ? toId(options.surveyVersions.INTERNATIONAL) : null,
    },
    status: options.status,
    publishedAt: new Date(now - 25 * DAY),
  });
  await withTransaction((session) =>
    createParticipants(
      cycle._id,
      options.participants.map((p) => ({ acoId: p.org._id, airportId: airportOf(p.org), surveyTypes: [...p.surveyTypes], requiredSampleSize: 1 })),
      session,
    ),
  );
  return { id: idString(cycle._id), code: cycle.code, name: cycle.name };
}

export async function setTestCycleStatus(cycleId: string, status: CycleStatus): Promise<void> {
  await CycleModel.updateOne({ _id: toId(cycleId) }, { $set: { status } });
}
