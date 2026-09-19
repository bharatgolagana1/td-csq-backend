import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import type { CsqError } from '@csq/contracts';
import { runAsPrincipal, type Principal } from '../src/kernel/requestContext.js';
import { newId } from '../src/kernel/ids.js';
import {
  AssessmentModel,
  AssignmentModel,
  InstrumentModel,
} from '../src/modules/assessments/assessments.models.js';
import { publishInstrument } from '../src/modules/assessments/assessments.instruments.js';
import {
  completionFor,
  createAssignment,
  loadAssignment,
  revokeAssignment,
  worklist,
} from '../src/modules/assessments/assessments.assignments.js';
import {
  discardAssessment,
  patchAnswers,
  readAssessment,
  readReadiness,
  readSubmission,
  startAssessment,
  submitAssessment,
} from '../src/modules/assessments/assessments.service.js';
import {
  ASSESSMENTS_MANAGE,
  ASSESSMENTS_RESPOND,
  INSTRUMENTS_PUBLISH,
} from '../src/modules/assessments/assessments.module.js';
import type { AnswerOp, CreateAssignment } from '../src/modules/assessments/assessments.contracts.js';
import { closeDatabase, openDatabase } from './mongo.js';

/**
 * The runtime against a real MongoDB. The two things worth a database here are
 * the partial unique indexes that decide which of two tabs owns the draft and
 * whether a customer can answer twice, and the tenancy plugin. Neither exists
 * anywhere but in the server.
 */

const ORG_A = newId();
const ORG_B = newId();

const OPERATOR = newId();
const CUSTOMER = newId();
const BYSTANDER = newId();
const MANAGER = newId();

const PEOPLE = [OPERATOR, CUSTOMER, BYSTANDER, MANAGER];

/**
 * Accounts belong to the kernel. The suite writes them through the connection
 * rather than the kernel's model, because that model is registered unguarded
 * and importing it from two test files in one process throws.
 */
const users = () => mongoose.connection.collection<{ _id: string; subject: string; displayName: string; status: string; memberships: unknown[] }>('users');

const CYCLE = newId();
const CYCLE_TWO = newId();
const OTHER_TERMINAL = newId();

const BEFORE = new Date('2026-03-20T09:00:00.000Z');
const DURING = new Date('2026-04-10T09:00:00.000Z');
const LATER = new Date('2026-04-10T09:30:00.000Z');
const AFTER = new Date('2026-06-10T09:00:00.000Z');

/** India keeps no daylight saving, so the offset is the same all year. */
const TZ = 'Asia/Kolkata';
const IST_OFFSET = '+05:30';

function boundary(wall: string): { wall: string; tz: string; utc: string } {
  return { wall, tz: TZ, utc: new Date(`${wall}:00${IST_OFFSET}`).toISOString() };
}

const WINDOWS = {
  samplingOpens: boundary('2026-03-01T00:00'),
  samplingCloses: boundary('2026-04-30T00:00'),
  assessmentOpens: boundary('2026-04-01T00:00'),
  assessmentCloses: boundary('2026-05-31T00:00'),
};

const QUESTIONS = [
  {
    code: 'ACFI.INFRA.TC_BC_GENERATION',
    categoryCode: 'INFRA',
    text: 'Generation of the trade control and booking confirmation',
    answerType: 'RATING_5' as const,
    weightBp: 6000,
    scored: true,
    required: true,
    applicableDirections: ['EXPORT' as const, 'IMPORT' as const],
    options: [{ key: 'COUNTER', label: 'At the counter' }],
    followUps: [
      { code: 'WHAT_WENT_WRONG', prompt: 'What went wrong?', revealOn: ['FAIR' as const, 'POOR' as const], required: false },
    ],
  },
  {
    code: 'ACFI.FACIL.EXPORT_ONLY',
    categoryCode: 'FACIL',
    text: 'Export facilitation',
    answerType: 'RATING_5' as const,
    weightBp: 4000,
    scored: true,
    required: true,
    applicableDirections: ['EXPORT' as const],
    options: [],
    followUps: [],
  },
];

function principal(userId: string, orgId: string, capabilities: readonly string[]): Principal {
  return {
    userId,
    subject: `sub-${userId}`,
    email: null,
    displayName: userId,
    memberships: [{ orgId, roles: ['MEMBER'], capabilities: [...capabilities], active: true }],
  };
}

function as<T>(userId: string, orgId: string, fn: () => T): T {
  const capabilities = [ASSESSMENTS_RESPOND, ASSESSMENTS_MANAGE, INSTRUMENTS_PUBLISH];
  return runAsPrincipal({ requestId: newId(), principal: principal(userId, orgId, capabilities), orgId }, fn);
}

const inA = <T>(userId: string, fn: () => T): T => as(userId, ORG_A, fn);
const inB = <T>(userId: string, fn: () => T): T => as(userId, ORG_B, fn);

async function codeOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    return (error as CsqError).code;
  }
  throw new Error('expected a failure');
}

let instrumentId = '';
let version = 0;

async function assign(overrides: Partial<CreateAssignment> = {}): Promise<string> {
  const input: CreateAssignment = {
    cycleId: CYCLE,
    acoOrgId: ORG_A,
    participationId: null,
    assessorUserId: CUSTOMER,
    assessorKind: 'CUSTOMER',
    formScope: 'INTERNATIONAL',
    instrumentId,
    windows: WINDOWS,
    activeFrom: null,
    ...overrides,
  };
  const created = await inA(MANAGER, () => createAssignment(input, DURING));
  return created.id;
}

const rate = (questionCode: string, direction: 'EXPORT' | 'IMPORT', rating: string): AnswerOp =>
  ({ op: 'SET_RATING', questionCode, direction, rating } as AnswerOp);

const COMPLETE: AnswerOp[] = [
  rate('ACFI.INFRA.TC_BC_GENERATION', 'EXPORT', 'GOOD'),
  rate('ACFI.INFRA.TC_BC_GENERATION', 'IMPORT', 'VERY_GOOD'),
  rate('ACFI.FACIL.EXPORT_ONLY', 'EXPORT', 'EXCELLENT'),
];

describe('assessment runtime', () => {
  beforeAll(async () => {
    await openDatabase();
    await AssignmentModel.syncIndexes();
    await AssessmentModel.syncIndexes();
    await InstrumentModel.syncIndexes();
  });

  afterAll(async () => {
    await users().deleteMany({ _id: { $in: PEOPLE } });
    await closeDatabase();
  });

  beforeEach(async () => {
    for (const model of [AssignmentModel, AssessmentModel, InstrumentModel]) {
      await mongoose.connection.collection(model.collection.name).deleteMany({});
    }
    await users().deleteMany({ _id: { $in: PEOPLE } });
    await users().insertMany(
      PEOPLE.map((userId) => ({
        _id: userId,
        subject: `sub-${userId}`,
        displayName: userId,
        status: 'ACTIVE',
        memberships: [],
      })),
    );

    version += 1;
    const published = await inA(MANAGER, () =>
      publishInstrument(
        { code: 'ACFI.CSQ', version, formScope: 'INTERNATIONAL', sourceRef: null, questions: QUESTIONS },
        DURING,
      ),
    );
    instrumentId = published.id;
  });

  describe('the instrument', () => {
    it('refuses to publish the same version twice', async () => {
      expect(
        await codeOf(() =>
          inA(MANAGER, () =>
            publishInstrument(
              { code: 'ACFI.CSQ', version, formScope: 'INTERNATIONAL', sourceRef: null, questions: QUESTIONS },
              DURING,
            ),
          ),
        ),
      ).toBe('CONFLICT');
    });

    it('refuses an assignment pointed at an instrument for the other form', async () => {
      expect(await codeOf(() => assign({ formScope: 'DOMESTIC' }))).toBe('VALIDATION_FAILED');
    });
  });

  describe('assignments', () => {
    it('refuses a window whose instant does not fall at its own wall time', async () => {
      expect(
        await codeOf(() =>
          assign({
            windows: {
              ...WINDOWS,
              // the instant of midnight UTC, labelled as midnight in Kolkata
              assessmentOpens: { wall: '2026-04-01T00:00', tz: TZ, utc: '2026-04-01T00:00:00.000Z' },
            },
          }),
        ),
      ).toBe('VALIDATION_FAILED');
    });

    it('refuses an assessor who has no account', async () => {
      expect(await codeOf(() => assign({ assessorUserId: newId() }))).toBe('VALIDATION_FAILED');
    });

    it('is idempotent, because a sampling batch may be replayed', async () => {
      const first = await assign();
      const again = await assign();

      expect(again).toBe(first);
      expect(await inA(MANAGER, () => AssignmentModel.countDocuments({}).exec())).toBe(1);
    });

    it('refuses to re-cast the same assessor as a different kind', async () => {
      await assign();
      expect(await codeOf(() => assign({ assessorKind: 'EXTERNAL' }))).toBe('CONFLICT');
    });
  });

  describe('opening a return', () => {
    it('records what there is to answer before anything is answered', async () => {
      const assignmentId = await assign();
      const started = await inA(CUSTOMER, () => startAssessment(assignmentId, CUSTOMER, DURING));

      expect(started.state).toBe('DRAFT');
      // two questions, three applicable directions between them
      expect(started.progress).toEqual({ applicableDirections: 3, answeredDirections: 0, percentBp: 0 });

      const assignment = await inA(MANAGER, () => loadAssignment(assignmentId));
      expect(assignment.state).toBe('IN_PROGRESS');
      expect(assignment.completeness.applicableDirections).toBe(3);
    });

    it('hands the same draft to the second tab', async () => {
      const assignmentId = await assign();
      const first = await inA(CUSTOMER, () => startAssessment(assignmentId, CUSTOMER, DURING));
      const second = await inA(CUSTOMER, () => startAssessment(assignmentId, CUSTOMER, LATER));

      expect(second.id).toBe(first.id);
      expect(await inA(MANAGER, () => AssessmentModel.countDocuments({}).exec())).toBe(1);
    });

    it('refuses a customer before the window opens and after it closes', async () => {
      const assignmentId = await assign();

      expect(await codeOf(() => inA(CUSTOMER, () => startAssessment(assignmentId, CUSTOMER, BEFORE)))).toBe(
        'WINDOW_NOT_OPEN',
      );
      expect(await codeOf(() => inA(CUSTOMER, () => startAssessment(assignmentId, CUSTOMER, AFTER)))).toBe(
        'WINDOW_CLOSED',
      );
    });

    it('lets a customer sampled late start after the window opened, but not before they were sampled', async () => {
      const assignmentId = await assign({ activeFrom: LATER.toISOString() });

      expect(await codeOf(() => inA(CUSTOMER, () => startAssessment(assignmentId, CUSTOMER, DURING)))).toBe(
        'WINDOW_NOT_OPEN',
      );
      expect((await inA(CUSTOMER, () => startAssessment(assignmentId, CUSTOMER, LATER))).state).toBe('DRAFT');
    });

    it('lets an operator assess itself at any time, window or no window', async () => {
      const assignmentId = await assign({
        assessorUserId: OPERATOR,
        assessorKind: 'SELF',
        windows: null,
      });

      expect((await inA(OPERATOR, () => startAssessment(assignmentId, OPERATOR, AFTER))).state).toBe('DRAFT');
    });

    it('answers a withdrawn assignment with forbidden and discards the draft', async () => {
      const assignmentId = await assign();
      const started = await inA(CUSTOMER, () => startAssessment(assignmentId, CUSTOMER, DURING));
      await inA(MANAGER, () => revokeAssignment(assignmentId, 'Sampled in error', LATER));

      expect(await codeOf(() => inA(CUSTOMER, () => startAssessment(assignmentId, CUSTOMER, LATER)))).toBe(
        'FORBIDDEN',
      );
      expect((await inA(CUSTOMER, () => readAssessment(started.id, CUSTOMER))).state).toBe('DISCARDED');
    });
  });

  describe('autosave', () => {
    it('applies a batch and reports the progress it produced', async () => {
      const assignmentId = await assign();
      const started = await inA(CUSTOMER, () => startAssessment(assignmentId, CUSTOMER, DURING));

      const saved = await inA(CUSTOMER, () =>
        patchAnswers(started.id, CUSTOMER, [rate('ACFI.INFRA.TC_BC_GENERATION', 'EXPORT', 'GOOD')], LATER),
      );

      expect(saved.revision).toBe(1);
      expect(saved.progress.answeredDirections).toBe(1);
      expect(saved.touched).toEqual(['ACFI.INFRA.TC_BC_GENERATION']);
      expect((await inA(MANAGER, () => loadAssignment(assignmentId))).completeness.answeredDirections).toBe(1);
    });

    it('keeps what the other tab typed when both save at once', async () => {
      const assignmentId = await assign();
      const started = await inA(CUSTOMER, () => startAssessment(assignmentId, CUSTOMER, DURING));

      await Promise.all([
        inA(CUSTOMER, () =>
          patchAnswers(started.id, CUSTOMER, [rate('ACFI.INFRA.TC_BC_GENERATION', 'EXPORT', 'GOOD')], LATER),
        ),
        inA(CUSTOMER, () =>
          patchAnswers(started.id, CUSTOMER, [rate('ACFI.FACIL.EXPORT_ONLY', 'EXPORT', 'POOR')], LATER),
        ),
      ]);

      const settled = await inA(CUSTOMER, () => readAssessment(started.id, CUSTOMER));
      expect(settled.answers.map((a) => a.questionCode).sort()).toEqual([
        'ACFI.FACIL.EXPORT_ONLY',
        'ACFI.INFRA.TC_BC_GENERATION',
      ]);
      expect(settled.revision).toBe(2);
    });

    it('will not save into somebody else return', async () => {
      const assignmentId = await assign();
      const started = await inA(CUSTOMER, () => startAssessment(assignmentId, CUSTOMER, DURING));

      expect(
        await codeOf(() =>
          inA(BYSTANDER, () => patchAnswers(started.id, BYSTANDER, [...COMPLETE], LATER)),
        ),
      ).toBe('NOT_FOUND');
    });
  });

  describe('submitting', () => {
    it('refuses while an applicable direction is unanswered', async () => {
      const assignmentId = await assign();
      const started = await inA(CUSTOMER, () => startAssessment(assignmentId, CUSTOMER, DURING));
      await inA(CUSTOMER, () =>
        patchAnswers(
          started.id,
          CUSTOMER,
          [rate('ACFI.INFRA.TC_BC_GENERATION', 'EXPORT', 'GOOD'), rate('ACFI.FACIL.EXPORT_ONLY', 'EXPORT', 'GOOD')],
          LATER,
        ),
      );

      const readiness = await inA(CUSTOMER, () => readReadiness(started.id, CUSTOMER));
      expect(readiness.canSubmit).toBe(false);
      expect(readiness.blockers).toEqual([
        expect.objectContaining({ direction: 'IMPORT', reason: 'DIRECTION_UNANSWERED' }),
      ]);

      expect(await codeOf(() => inA(CUSTOMER, () => submitAssessment(started.id, CUSTOMER, LATER)))).toBe(
        'VALIDATION_FAILED',
      );
    });

    it('drops a follow-up whose rating moved before it stores the submission', async () => {
      const assignmentId = await assign();
      const started = await inA(CUSTOMER, () => startAssessment(assignmentId, CUSTOMER, DURING));

      await inA(CUSTOMER, () =>
        patchAnswers(
          started.id,
          CUSTOMER,
          [
            rate('ACFI.INFRA.TC_BC_GENERATION', 'EXPORT', 'POOR'),
            {
              op: 'SET_FOLLOW_UP',
              questionCode: 'ACFI.INFRA.TC_BC_GENERATION',
              direction: 'EXPORT',
              code: 'WHAT_WENT_WRONG',
              value: 'Queues at the counter',
            },
          ],
          LATER,
        ),
      );

      // the assessor changes their mind. The explanation was revealed by POOR
      // and must not survive next to an EXCELLENT
      await inA(CUSTOMER, () =>
        patchAnswers(started.id, CUSTOMER, [rate('ACFI.INFRA.TC_BC_GENERATION', 'EXPORT', 'EXCELLENT')], LATER),
      );
      await inA(CUSTOMER, () =>
        patchAnswers(
          started.id,
          CUSTOMER,
          [rate('ACFI.INFRA.TC_BC_GENERATION', 'IMPORT', 'GOOD'), rate('ACFI.FACIL.EXPORT_ONLY', 'EXPORT', 'GOOD')],
          LATER,
        ),
      );

      const submitted = await inA(CUSTOMER, () => submitAssessment(started.id, CUSTOMER, LATER));
      const exported = submitted.answers
        .find((a) => a.questionCode === 'ACFI.INFRA.TC_BC_GENERATION')
        ?.ratings.find((r) => r.direction === 'EXPORT');

      expect(submitted.state).toBe('SUBMITTED');
      expect(exported?.followUps).toEqual([]);
    });

    it('is idempotent, and a second press changes nothing', async () => {
      const assignmentId = await assign();
      const started = await inA(CUSTOMER, () => startAssessment(assignmentId, CUSTOMER, DURING));
      await inA(CUSTOMER, () => patchAnswers(started.id, CUSTOMER, [...COMPLETE], LATER));

      const first = await inA(CUSTOMER, () => submitAssessment(started.id, CUSTOMER, LATER));
      const second = await inA(CUSTOMER, () => submitAssessment(started.id, CUSTOMER, AFTER));

      expect(second.id).toBe(first.id);
      expect(second.submittedAt).toBe(first.submittedAt);

      const assignment = await inA(MANAGER, () => loadAssignment(assignmentId));
      expect(assignment.state).toBe('COMPLETED');
      expect(assignment.submissionCount).toBe(1);
    });

    it('will not let a submitted return be amended or discarded', async () => {
      const assignmentId = await assign();
      const started = await inA(CUSTOMER, () => startAssessment(assignmentId, CUSTOMER, DURING));
      await inA(CUSTOMER, () => patchAnswers(started.id, CUSTOMER, [...COMPLETE], LATER));
      await inA(CUSTOMER, () => submitAssessment(started.id, CUSTOMER, LATER));

      expect(
        await codeOf(() =>
          inA(CUSTOMER, () =>
            patchAnswers(started.id, CUSTOMER, [rate('ACFI.FACIL.EXPORT_ONLY', 'EXPORT', 'POOR')], AFTER),
          ),
        ),
      ).toBe('ASSESSMENT_ALREADY_SUBMITTED');
      expect(await codeOf(() => inA(CUSTOMER, () => discardAssessment(started.id, CUSTOMER)))).toBe(
        'ASSESSMENT_ALREADY_SUBMITTED',
      );
    });

    it('lets a customer answer once and an operator assess itself again', async () => {
      const customerAssignment = await assign();
      const customerDraft = await inA(CUSTOMER, () => startAssessment(customerAssignment, CUSTOMER, DURING));
      await inA(CUSTOMER, () => patchAnswers(customerDraft.id, CUSTOMER, [...COMPLETE], LATER));
      await inA(CUSTOMER, () => submitAssessment(customerDraft.id, CUSTOMER, LATER));

      expect(
        await codeOf(() => inA(CUSTOMER, () => startAssessment(customerAssignment, CUSTOMER, LATER))),
      ).toBe('ASSESSMENT_ALREADY_SUBMITTED');

      const selfAssignment = await assign({
        assessorUserId: OPERATOR,
        assessorKind: 'SELF',
        windows: null,
      });
      const first = await inA(OPERATOR, () => startAssessment(selfAssignment, OPERATOR, DURING));
      await inA(OPERATOR, () => patchAnswers(first.id, OPERATOR, [...COMPLETE], LATER));
      await inA(OPERATOR, () => submitAssessment(first.id, OPERATOR, LATER));

      const again = await inA(OPERATOR, () => startAssessment(selfAssignment, OPERATOR, AFTER));
      expect(again.id).not.toBe(first.id);
      expect(again.state).toBe('DRAFT');
    });

    it('refuses a submission after the window has closed', async () => {
      const assignmentId = await assign();
      const started = await inA(CUSTOMER, () => startAssessment(assignmentId, CUSTOMER, DURING));
      await inA(CUSTOMER, () => patchAnswers(started.id, CUSTOMER, [...COMPLETE], LATER));

      expect(await codeOf(() => inA(CUSTOMER, () => submitAssessment(started.id, CUSTOMER, AFTER)))).toBe(
        'WINDOW_CLOSED',
      );
    });
  });

  describe('who may see what', () => {
    it('keeps one organisation returns out of another', async () => {
      const assignmentId = await assign();
      const started = await inA(CUSTOMER, () => startAssessment(assignmentId, CUSTOMER, DURING));

      expect(await codeOf(() => inB(CUSTOMER, () => readAssessment(started.id, CUSTOMER)))).toBe('NOT_FOUND');
      expect(await codeOf(() => inB(CUSTOMER, () => startAssessment(assignmentId, CUSTOMER, DURING)))).toBe(
        'NOT_FOUND',
      );
    });

    it('does not let one assessor read another draft in the same organisation', async () => {
      const assignmentId = await assign();
      const started = await inA(CUSTOMER, () => startAssessment(assignmentId, CUSTOMER, DURING));

      expect(await codeOf(() => inA(BYSTANDER, () => readAssessment(started.id, BYSTANDER)))).toBe('NOT_FOUND');
    });

    it('shows a manager the submission but never the draft', async () => {
      const assignmentId = await assign();
      const started = await inA(CUSTOMER, () => startAssessment(assignmentId, CUSTOMER, DURING));
      await inA(CUSTOMER, () => patchAnswers(started.id, CUSTOMER, [...COMPLETE], LATER));

      expect(await codeOf(() => inA(MANAGER, () => readSubmission(started.id)))).toBe('NOT_FOUND');

      await inA(CUSTOMER, () => submitAssessment(started.id, CUSTOMER, LATER));
      expect((await inA(MANAGER, () => readSubmission(started.id))).state).toBe('SUBMITTED');
    });
  });

  describe('the worklist and the terminal state', () => {
    it('lists what this assessor has to do, soonest deadline first', async () => {
      const here = await assign();
      const elsewhere = await assign({
        cycleId: CYCLE_TWO,
        acoOrgId: OTHER_TERMINAL,
        windows: {
          ...WINDOWS,
          assessmentCloses: boundary('2026-04-20T00:00'),
        },
      });
      await assign({ assessorUserId: BYSTANDER });

      const rows = await inA(CUSTOMER, () => worklist(CUSTOMER, { includeFinished: false }, DURING));

      expect(rows.map((r) => r.id)).toEqual([elsewhere, here]);
      expect(rows.every((r) => r.assessorUserId === CUSTOMER)).toBe(true);
      expect(rows[0]?.action).toBe('START');
      expect(rows[0]?.windowState).toBe('OPEN');

      const started = await inA(CUSTOMER, () => startAssessment(here, CUSTOMER, DURING));
      await inA(CUSTOMER, () => patchAnswers(started.id, CUSTOMER, [...COMPLETE], LATER));
      const afterSaving = await inA(CUSTOMER, () => worklist(CUSTOMER, { includeFinished: false }, LATER));

      expect(afterSaving.find((r) => r.id === here)?.action).toBe('CONTINUE');
      expect(afterSaving.find((r) => r.id === here)?.completeness.percentBp).toBe(10_000);
    });

    it('counts a terminal way through a cycle', async () => {
      const customerAssignment = await assign();
      await assign({ assessorUserId: BYSTANDER });
      const selfAssignment = await assign({
        assessorUserId: OPERATOR,
        assessorKind: 'SELF',
        windows: null,
      });

      const draft = await inA(CUSTOMER, () => startAssessment(customerAssignment, CUSTOMER, DURING));
      await inA(CUSTOMER, () => patchAnswers(draft.id, CUSTOMER, [...COMPLETE], LATER));
      await inA(CUSTOMER, () => submitAssessment(draft.id, CUSTOMER, LATER));

      const completion = await inA(MANAGER, () => completionFor(CYCLE, ORG_A, null));

      expect(completion.byKind.CUSTOMER).toMatchObject({ assigned: 2, completed: 1, pending: 1 });
      expect(completion.customerSubmissions).toBe(1);
      expect(completion.byKind.SELF.assigned).toBe(1);
      expect(completion.selfComplete).toBe(false);

      const selfDraft = await inA(OPERATOR, () => startAssessment(selfAssignment, OPERATOR, DURING));
      await inA(OPERATOR, () => patchAnswers(selfDraft.id, OPERATOR, [...COMPLETE], LATER));
      await inA(OPERATOR, () => submitAssessment(selfDraft.id, OPERATOR, LATER));

      expect((await inA(MANAGER, () => completionFor(CYCLE, ORG_A, null))).selfComplete).toBe(true);
    });
  });
});
