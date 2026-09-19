import { describe, expect, it } from 'vitest';
import type { CsqError } from '@csq/contracts';
import { checkModule, mountModules } from '../src/kernel/router.js';
import { assessmentsModule } from '../src/modules/assessments/assessments.module.js';
import { silentLog } from './mongo.js';
import {
  applyOps,
  computeProgress,
  pruneAll,
  pruneFollowUps,
  revealedFollowUps,
  submitBlockers,
  toAnswerViews,
} from '../src/modules/assessments/assessments.answers.js';
import type { AnswerOp } from '../src/modules/assessments/assessments.contracts.js';
import type { InstrumentDoc, StoredAnswerDoc } from '../src/modules/assessments/assessments.models.js';

/**
 * The answer rules, with no database in the way. These are the calculations a
 * bug would be most expensive in, so they are exercised directly rather than
 * through a route.
 */

const NOW = new Date('2026-04-10T09:00:00.000Z');
const LATER = new Date('2026-04-10T09:05:00.000Z');
const ASSESSOR = 'ASSESSOR1';

const instrument: InstrumentDoc = {
  _id: 'INSTRUMENT1',
  code: 'ACFI.CSQ',
  version: 1,
  formScope: 'INTERNATIONAL',
  sourceRef: 'CSQ Survey Form (International)',
  publishedAt: NOW,
  questions: [
    {
      code: 'ACFI.INFRA.TC_BC_GENERATION',
      categoryCode: 'INFRA',
      text: 'Generation of the trade control and booking confirmation',
      answerType: 'RATING_5',
      weightBp: 5000,
      scored: true,
      required: true,
      applicableDirections: ['EXPORT', 'IMPORT'],
      options: [
        { key: 'SELF_SERVICE', label: 'Self service' },
        { key: 'COUNTER', label: 'At the counter' },
      ],
      followUps: [
        { code: 'WHAT_WENT_WRONG', prompt: 'What went wrong?', revealOn: ['FAIR', 'POOR'], required: true },
        { code: 'ANYTHING_ELSE', prompt: 'Anything else?', revealOn: ['POOR'], required: false },
      ],
    },
    {
      code: 'ACFI.FACIL.EXPORT_ONLY',
      categoryCode: 'FACIL',
      text: 'Export facilitation',
      answerType: 'RATING_5',
      weightBp: 5000,
      scored: true,
      required: true,
      applicableDirections: ['EXPORT'],
      options: [],
      followUps: [],
    },
    {
      code: 'ACFI.NOTES.FREE_TEXT',
      categoryCode: 'NOTES',
      text: 'Anything the form did not ask',
      answerType: 'TEXT',
      weightBp: 0,
      scored: false,
      required: false,
      applicableDirections: ['EXPORT', 'IMPORT'],
      options: [],
      followUps: [],
    },
  ],
};

function apply(ops: AnswerOp[], from: StoredAnswerDoc[] = [], now = NOW): StoredAnswerDoc[] {
  return applyOps(instrument, from, ops, { now, userId: ASSESSOR }).answers;
}

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return (error as CsqError).code;
  }
  throw new Error('expected a failure');
}

const rate = (questionCode: string, direction: 'EXPORT' | 'IMPORT', rating: string): AnswerOp =>
  ({ op: 'SET_RATING', questionCode, direction, rating } as AnswerOp);

describe('progress', () => {
  it('counts applicable directions rather than questions', () => {
    // three questions, but only the two required rated ones count, and one of
    // those is asked in one direction only: 2 + 1 = 3
    expect(computeProgress(instrument, []).applicableDirections).toBe(3);
  });

  it('does not call a question answered because one of its directions is', () => {
    const answers = apply([rate('ACFI.INFRA.TC_BC_GENERATION', 'EXPORT', 'GOOD')]);
    const progress = computeProgress(instrument, answers);

    expect(progress.answeredDirections).toBe(1);
    expect(progress.applicableDirections).toBe(3);
    expect(progress.percentBp).toBe(3333);
  });

  it('is complete only when every applicable direction carries a rating', () => {
    const answers = apply([
      rate('ACFI.INFRA.TC_BC_GENERATION', 'EXPORT', 'GOOD'),
      rate('ACFI.INFRA.TC_BC_GENERATION', 'IMPORT', 'NA'),
      rate('ACFI.FACIL.EXPORT_ONLY', 'EXPORT', 'VERY_GOOD'),
    ]);

    expect(computeProgress(instrument, answers).percentBp).toBe(10_000);
    // NA is an answer, not a gap: it leaves the score, not the form
    expect(submitBlockers(instrument, answers)).toHaveLength(0);
  });
});

describe('submit blockers', () => {
  it('blocks on the unanswered import column', () => {
    const answers = apply([
      rate('ACFI.INFRA.TC_BC_GENERATION', 'EXPORT', 'GOOD'),
      rate('ACFI.FACIL.EXPORT_ONLY', 'EXPORT', 'GOOD'),
    ]);

    expect(submitBlockers(instrument, answers)).toEqual([
      expect.objectContaining({
        questionCode: 'ACFI.INFRA.TC_BC_GENERATION',
        direction: 'IMPORT',
        reason: 'DIRECTION_UNANSWERED',
      }),
    ]);
  });

  it('blocks on a required follow-up the rating revealed', () => {
    const answers = apply([
      rate('ACFI.INFRA.TC_BC_GENERATION', 'EXPORT', 'POOR'),
      rate('ACFI.INFRA.TC_BC_GENERATION', 'IMPORT', 'GOOD'),
      rate('ACFI.FACIL.EXPORT_ONLY', 'EXPORT', 'GOOD'),
    ]);

    expect(submitBlockers(instrument, answers)).toEqual([
      expect.objectContaining({ reason: 'FOLLOW_UP_MISSING', direction: 'EXPORT' }),
    ]);
  });

  it('is satisfied once the revealed follow-up is answered', () => {
    const answers = apply([
      rate('ACFI.INFRA.TC_BC_GENERATION', 'EXPORT', 'POOR'),
      {
        op: 'SET_FOLLOW_UP',
        questionCode: 'ACFI.INFRA.TC_BC_GENERATION',
        direction: 'EXPORT',
        code: 'WHAT_WENT_WRONG',
        value: 'The booking confirmation took two days',
      },
      rate('ACFI.INFRA.TC_BC_GENERATION', 'IMPORT', 'GOOD'),
      rate('ACFI.FACIL.EXPORT_ONLY', 'EXPORT', 'GOOD'),
    ]);

    expect(submitBlockers(instrument, answers)).toHaveLength(0);
  });
});

describe('follow-up pruning', () => {
  it('drops an explanation when the rating that revealed it changes', () => {
    const poor = apply([
      rate('ACFI.INFRA.TC_BC_GENERATION', 'EXPORT', 'POOR'),
      {
        op: 'SET_FOLLOW_UP',
        questionCode: 'ACFI.INFRA.TC_BC_GENERATION',
        direction: 'EXPORT',
        code: 'ANYTHING_ELSE',
        value: 'Nothing else',
      },
    ]);
    expect(poor[0]?.ratings[0]?.followUps).toHaveLength(1);

    // ANYTHING_ELSE is revealed by POOR alone, so raising the rating to FAIR
    // must take the explanation with it
    const fair = apply([rate('ACFI.INFRA.TC_BC_GENERATION', 'EXPORT', 'FAIR')], poor, LATER);
    expect(fair[0]?.ratings[0]?.followUps).toHaveLength(0);
  });

  it('prunes again over the whole document, for a rating changed elsewhere', () => {
    const stored: StoredAnswerDoc[] = [
      {
        questionCode: 'ACFI.INFRA.TC_BC_GENERATION',
        comment: null,
        updatedAt: NOW,
        ratings: [
          {
            direction: 'EXPORT',
            rating: 'EXCELLENT',
            options: [],
            updatedAt: NOW,
            updatedBy: ASSESSOR,
            followUps: [
              { code: 'WHAT_WENT_WRONG', value: 'left over', updatedAt: NOW, updatedBy: ASSESSOR },
            ],
          },
        ],
      },
    ];

    expect(pruneAll(instrument, stored)[0]?.ratings[0]?.followUps).toHaveLength(0);
  });

  it('reports which follow-ups a rating reveals', () => {
    const question = instrument.questions[0];
    if (!question) throw new Error('fixture');

    expect(revealedFollowUps(question, 'POOR').map((f) => f.code)).toEqual([
      'WHAT_WENT_WRONG',
      'ANYTHING_ELSE',
    ]);
    expect(revealedFollowUps(question, 'EXCELLENT')).toHaveLength(0);
    expect(
      pruneFollowUps(question, {
        direction: 'EXPORT',
        rating: 'EXCELLENT',
        options: [],
        followUps: [{ code: 'WHAT_WENT_WRONG', value: 'x', updatedAt: NOW, updatedBy: ASSESSOR }],
        updatedAt: NOW,
        updatedBy: ASSESSOR,
      }).followUps,
    ).toHaveLength(0);
  });
});

describe('answer operations', () => {
  it('refuses a direction the form does not ask for', () => {
    expect(codeOf(() => apply([rate('ACFI.FACIL.EXPORT_ONLY', 'IMPORT', 'GOOD')]))).toBe(
      'VALIDATION_FAILED',
    );
  });

  it('refuses a question that is not on the form', () => {
    expect(codeOf(() => apply([rate('ACFI.MADE.UP', 'EXPORT', 'GOOD')]))).toBe('VALIDATION_FAILED');
  });

  it('refuses a follow-up the current rating does not reveal', () => {
    const answers = apply([rate('ACFI.INFRA.TC_BC_GENERATION', 'EXPORT', 'EXCELLENT')]);

    expect(
      codeOf(() =>
        apply(
          [
            {
              op: 'SET_FOLLOW_UP',
              questionCode: 'ACFI.INFRA.TC_BC_GENERATION',
              direction: 'EXPORT',
              code: 'WHAT_WENT_WRONG',
              value: 'nothing',
            },
          ],
          answers,
        ),
      ),
    ).toBe('VALIDATION_FAILED');
  });

  it('refuses a sub-parameter the question does not declare', () => {
    const answers = apply([rate('ACFI.INFRA.TC_BC_GENERATION', 'EXPORT', 'GOOD')]);

    expect(
      codeOf(() =>
        apply(
          [
            {
              op: 'SET_OPTIONS',
              questionCode: 'ACFI.INFRA.TC_BC_GENERATION',
              direction: 'EXPORT',
              options: ['BY_CARRIER_PIGEON'],
            },
          ],
          answers,
        ),
      ),
    ).toBe('VALIDATION_FAILED');
  });

  it('reports every problem in the batch at once', () => {
    let fields: ReadonlyArray<{ path: string }> = [];
    try {
      apply([rate('ACFI.MADE.UP', 'EXPORT', 'GOOD'), rate('ACFI.FACIL.EXPORT_ONLY', 'IMPORT', 'GOOD')]);
    } catch (error) {
      fields = (error as CsqError).fields ?? [];
    }

    expect(fields.map((f) => f.path)).toEqual(['ops.0.questionCode', 'ops.1.direction']);
  });

  it('takes the options and follow-ups with a cleared rating', () => {
    const answered = apply([
      rate('ACFI.INFRA.TC_BC_GENERATION', 'EXPORT', 'POOR'),
      {
        op: 'SET_OPTIONS',
        questionCode: 'ACFI.INFRA.TC_BC_GENERATION',
        direction: 'EXPORT',
        options: ['COUNTER'],
      },
      { op: 'SET_COMMENT', questionCode: 'ACFI.INFRA.TC_BC_GENERATION', comment: 'slow' },
    ]);
    expect(answered[0]?.comment).toBe('slow');

    const cleared = apply(
      [{ op: 'CLEAR_RATING', questionCode: 'ACFI.INFRA.TC_BC_GENERATION', direction: 'EXPORT' }],
      answered,
      LATER,
    );

    // the comment belongs to the answer, and there is no answer without a rating
    expect(cleared).toHaveLength(0);
  });

  it('refuses a comment on a question nobody has rated', () => {
    expect(
      codeOf(() => apply([{ op: 'SET_COMMENT', questionCode: 'ACFI.INFRA.TC_BC_GENERATION', comment: 'hm' }])),
    ).toBe('VALIDATION_FAILED');
  });

  it('applies the later operation to the same leaf and leaves the others alone', () => {
    const first = apply([
      rate('ACFI.INFRA.TC_BC_GENERATION', 'EXPORT', 'GOOD'),
      rate('ACFI.INFRA.TC_BC_GENERATION', 'IMPORT', 'FAIR'),
    ]);
    const second = apply([rate('ACFI.INFRA.TC_BC_GENERATION', 'EXPORT', 'POOR')], first, LATER);

    const ratings = second[0]?.ratings ?? [];
    expect(ratings.find((r) => r.direction === 'EXPORT')?.rating).toBe('POOR');
    expect(ratings.find((r) => r.direction === 'IMPORT')?.rating).toBe('FAIR');
    expect(ratings.find((r) => r.direction === 'EXPORT')?.updatedAt).toEqual(LATER);
  });

  it('never mutates the answers it was given', () => {
    const before = apply([rate('ACFI.INFRA.TC_BC_GENERATION', 'EXPORT', 'GOOD')]);
    const snapshot = JSON.stringify(before);
    apply([rate('ACFI.INFRA.TC_BC_GENERATION', 'EXPORT', 'POOR')], before, LATER);

    expect(JSON.stringify(before)).toBe(snapshot);
  });
});

describe('the wire shape', () => {
  it('is the locked Answer from the contracts package', () => {
    const answers = apply([
      rate('ACFI.INFRA.TC_BC_GENERATION', 'EXPORT', 'POOR'),
      {
        op: 'SET_OPTIONS',
        questionCode: 'ACFI.INFRA.TC_BC_GENERATION',
        direction: 'EXPORT',
        options: ['COUNTER', 'COUNTER'],
      },
      {
        op: 'SET_FOLLOW_UP',
        questionCode: 'ACFI.INFRA.TC_BC_GENERATION',
        direction: 'EXPORT',
        code: 'WHAT_WENT_WRONG',
        value: '  queues  ',
      },
      { op: 'SET_COMMENT', questionCode: 'ACFI.INFRA.TC_BC_GENERATION', comment: '  slow  ' },
    ]);

    expect(toAnswerViews(answers)).toEqual([
      {
        questionCode: 'ACFI.INFRA.TC_BC_GENERATION',
        comment: 'slow',
        updatedAt: NOW.toISOString(),
        ratings: [
          {
            direction: 'EXPORT',
            rating: 'POOR',
            options: ['COUNTER'],
            followUps: [{ code: 'WHAT_WENT_WRONG', value: 'queues' }],
          },
        ],
      },
    ]);
  });
});


describe('the route table', () => {
  it('satisfies the boot policy check, so the orchestrator can mount it', () => {
    expect(() => checkModule(assessmentsModule)).not.toThrow();
  });

  it('declares every capability its routes require', () => {
    const declared = new Set(assessmentsModule.capabilities);
    const required = assessmentsModule.routes
      .map((route) => route.policy.requiredCapability)
      .filter((capability): capability is string => capability !== null);

    expect(required.every((capability) => declared.has(capability))).toBe(true);
    // nothing in this module is open: every route names the authority it needs
    expect(assessmentsModule.routes.every((r) => r.policy.requiredCapability !== null)).toBe(true);
    expect(assessmentsModule.routes.every((r) => r.policy.tenancy === 'ORG')).toBe(true);
  });

  it('registers the literal paths before the one that would swallow them', () => {
    const paths = assessmentsModule.routes.map((route) => route.path);
    const wildcard = paths.indexOf('/:assessmentId');

    for (const literal of ['/instruments', '/assignments', '/worklist']) {
      expect(paths.indexOf(literal)).toBeLessThan(wildcard);
    }
  });

  it('mounts without colliding with the module it will be mounted beside', () => {
    const deps = {
      authenticate: (_req: unknown, _res: unknown, next: () => void) => next(),
      enterSelfScope: (_req: unknown, _res: unknown, next: () => void) => next(),
      enterOrgScope: (_req: unknown, _res: unknown, next: () => void) => next(),
      log: silentLog,
    } as unknown as Parameters<typeof mountModules>[1];

    expect(() => mountModules([assessmentsModule], deps)).not.toThrow();
  });
});
