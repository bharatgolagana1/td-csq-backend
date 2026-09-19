import { isOpen, type MarketShareStage, type QuestionSpec, type WeightingProfile } from '@csq/core';
import { directionsFor, type Direction, type FormScope, type ScoreEnvelope } from '@csq/contracts';
import { TenantRepo, type TenantFields } from '../../kernel/tenancy.js';
import { conflict, fail, notFound } from '../../kernel/errors.js';
import { requireOrgId } from '../../kernel/requestContext.js';
import {
  CohortSnapshotModel,
  CycleRollupModel,
  ScoringRunModel,
  type CohortAirportRow,
  type CohortSnapshotDoc,
  type CycleDisplayState,
  type CycleRollupDoc,
  type RollupMode,
  type StoredScore,
} from './scoring.models.js';
import {
  PIPELINE_VERSION,
  cohortStatistics,
  customerTrack,
  gapOf,
  parameterCounts,
  publishTrack,
  rankAirports,
  selfTrack,
  questionWeightsFor,
  specsOf,
  tallyRatings,
  toWeightingProfile,
  weightingProblems,
  type AirportCandidate,
} from './scoring.pipeline.js';
import type {
  AssessmentInput,
  CycleInput,
  InstrumentInput,
  MarketShareSnapshotInput,
  ParticipationInput,
  ScoringSources,
  WeightingProfileInput,
} from './scoring.inputs.js';
import {
  CohortView,
  DashboardData,
  PerceptionGapView,
  RANKING_ROWS_SHOWN,
  RollupView,
  ScoringRunView,
  TrendView,
  type DashboardQuery,
  type GapQuery,
  type RollupQuery,
  type TrendQuery,
} from './scoring.contracts.js';

/**
 * Scoring has two halves that never touch the same data path.
 *
 * The write half ranks a cohort, so it reads across organisations inside an
 * explicitly recorded system scope and materialises one rollup per operator.
 * The read half serves those rollups, tenant filtered, and aggregates nothing:
 * a dashboard that recomputed a rating per request would give two people two
 * different answers in the same minute and could not tell either of them which
 * weighting produced their number.
 */

const rollups = new TenantRepo<CycleRollupDoc>(CycleRollupModel);

type StoredRollup = CycleRollupDoc & TenantFields;

function stored(envelope: ScoreEnvelope): StoredScore {
  return {
    value: envelope.value,
    coverageBp: envelope.scoreCoverageBp,
    responseCount: envelope.responseCount,
    suppression: envelope.suppression,
  };
}

function asEnvelope(score: StoredScore, rollup: StoredRollup): ScoreEnvelope {
  return {
    value: score.value,
    scoreCoverageBp: score.coverageBp,
    responseCount: score.responseCount,
    suppression: score.suppression,
    weightingProfile: { profileId: rollup.weighting.profileId, version: rollup.weighting.version },
    marketShareApplied: rollup.marketShareApplied,
  };
}

function displayState(cycle: CycleInput, mode: RollupMode, now: Date): CycleDisplayState {
  if (mode === 'FINAL') return 'SCORED';
  if (now < cycle.windows.assessmentOpens.utc) return 'OPEN';
  return isOpen(cycle.windows, 'ASSESSMENT', now) ? 'OPEN' : 'CLOSED';
}

/**
 * Which returns belong to which terminal. An operator with one participation
 * owns every return in the cycle; an operator with two must have said which,
 * and a return that did not say is left out of both rather than counted twice.
 */
function bucketAssessments(
  assessments: readonly AssessmentInput[],
  participation: ParticipationInput,
  participationsForOrg: number,
): { usable: AssessmentInput[]; skippedScopeMismatch: number } {
  let skippedScopeMismatch = 0;
  const usable: AssessmentInput[] = [];

  for (const assessment of assessments) {
    if (participationsForOrg > 1 && assessment.participationId !== participation._id) continue;
    if (assessment.formScope !== participation.formScope) {
      // an international return against a domestic terminal cannot be weighted
      // against the same category set, so it is excluded and counted
      skippedScopeMismatch += 1;
      continue;
    }
    usable.push(assessment);
  }

  return { usable, skippedScopeMismatch };
}

/** A rollup before it is inserted: the id is minted by the schema on insert. */
type RollupDraft = Omit<CycleRollupDoc, '_id'> & TenantFields;

interface ComputedRollup {
  readonly doc: RollupDraft;
  readonly airportId: string | null;
  readonly orgId: string;
}

interface CategoryHeading {
  readonly code: string;
  readonly label: string;
}

function computeRollup(args: {
  cycle: CycleInput;
  participation: ParticipationInput;
  assessments: readonly AssessmentInput[];
  specs: ReadonlyMap<string, QuestionSpec>;
  parameters: ReadonlyMap<string, number>;
  headings: readonly CategoryHeading[];
  profile: WeightingProfile;
  instrument: CycleRollupDoc['instrument'];
  terminal: CycleRollupDoc['terminal'];
  mode: RollupMode;
  cohortSize: number;
  now: Date;
}): ComputedRollup {
  const { cycle, participation, assessments, specs, profile, mode, now } = args;
  const scope: FormScope = participation.formScope;

  // a provisional run deliberately computes no publishable figure. The value
  // does not exist to be leaked rather than existing and being hidden, because
  // a score visible while the window is open is the same cherry picking signal
  // as a live rank
  const scored = mode === 'FINAL';

  const customers = customerTrack(assessments, specs, profile, scope);
  const published = publishTrack(customers, profile, { scored, marketShareApplied: false });
  const own = selfTrack(assessments, specs, profile, scope);

  const directions = directionsFor(scope).map((direction: Direction) => {
    const slice = customerTrack(assessments, specs, profile, scope, direction);
    const envelope = publishTrack(slice, profile, { scored, marketShareApplied: false }).overall;
    return { direction, ...stored(envelope) };
  });

  const selfByCategory = new Map(own.categories.map((c) => [c.categoryCode, c.value]));
  const publishedByCategory = new Map(published.categories.map((c) => [c.categoryCode, c]));

  const categories = args.headings.map((heading) => {
    const score = publishedByCategory.get(heading.code);
    return {
      categoryCode: heading.code,
      label: heading.label,
      parameterCount: args.parameters.get(heading.code) ?? 0,
      ...(score
        ? stored(score)
        : {
            value: null,
            coverageBp: 0,
            responseCount: 0,
            suppression: scored ? ('BELOW_MIN_RESPONSES' as const) : ('NOT_YET_SCORED' as const),
          }),
    };
  });

  const gapCategories = categories
    .map((category) => {
      const self = selfByCategory.get(category.categoryCode);
      const gap = self === undefined ? null : gapOf(self, category.value);
      return gap === null ? null : { categoryCode: category.categoryCode, value: gap };
    })
    .filter((row): row is { categoryCode: string; value: number } => row !== null);

  const distribution = tallyRatings(assessments, specs);

  const selfCount = assessments.filter((a) => a.assessorKind === 'SELF').length;
  const customerCount = assessments.filter((a) => a.assessorKind === 'CUSTOMER').length;
  const externalCount = assessments.filter((a) => a.assessorKind === 'EXTERNAL').length;

  const weights = profile.categoryWeightBp[scope];

  const doc: RollupDraft = {
    orgId: participation.acoOrgId,
    cycleId: cycle._id,
    participationId: participation._id,
    airportId: participation.airportId,
    formScope: scope,
    mode,
    cycle: { label: cycle.name, state: displayState(cycle, mode, now) },
    terminal: args.terminal,
    counts: {
      self: selfCount,
      customer: customerCount,
      external: externalCount,
      total: selfCount + customerCount + externalCount,
    },
    overall: stored(published.overall),
    categories,
    directions,
    distribution: distribution.map((row) => ({ key: row.key, count: row.count, percent: row.percent })),
    self: {
      value: own.value,
      coverageBp: own.coverageBp,
      responseCount: own.responseCount,
      categories: own.categories.map((c) => ({ categoryCode: c.categoryCode, value: c.value })),
    },
    gap: { overall: gapOf(own.value, published.overall.value), categories: gapCategories },
    weighting: {
      profileId: profile.profileId,
      version: profile.version,
      basis: profile.weightingBasis,
      categoryWeightBp: Object.entries(weights).map(([categoryCode, weightBp]) => ({ categoryCode, weightBp })),
    },
    instrument: args.instrument,
    marketShareApplied: false,
    rank: null,
    rankOf: args.cohortSize,
    pipelineVersion: PIPELINE_VERSION,
    computedAt: now,
    frozenAt: scored ? now : null,
  };

  return { doc, airportId: participation.airportId, orgId: participation.acoOrgId };
}

export interface RunArgs {
  readonly cycleId: string;
  readonly mode: RollupMode;
  readonly requestedByUserId: string;
  readonly requestedByOrgId: string;
  readonly reason: string;
  readonly sources: ScoringSources;
  readonly now: Date;
}

/**
 * The instrument a cycle is scored against is the one its assessors actually
 * answered, read off the returns rather than assumed. Two instruments inside one
 * cycle means the returns were not answering the same questions, which is not a
 * league table, so it is refused instead of averaged.
 */
async function resolveInstrument(
  cycle: CycleInput,
  assessments: readonly AssessmentInput[],
  sources: ScoringSources,
): Promise<InstrumentInput> {
  const ids = [...new Set(assessments.map((assessment) => assessment.instrumentId))];

  if (ids.length > 1) {
    const loaded = await sources.instruments(ids);
    const described = ids
      .map((id) => {
        const found = loaded.get(id);
        return found ? `${found.code} v${found.version}` : id;
      })
      .join(' and ');
    throw fail(
      'PRECONDITION_FAILED',
      `This cycle was answered against more than one instrument (${described}). Those returns are not comparable.`,
    );
  }

  const only = ids[0];
  const instrument =
    only === undefined
      ? await sources.latestInstrument(cycle.formScope)
      : (await sources.instruments([only])).get(only) ?? null;

  if (!instrument) {
    throw fail('QUESTION_BANK_NOT_PUBLISHED', 'No published instrument for this cycle');
  }
  return instrument;
}

/**
 * The profile that says what each question is worth. A profile pinned to the
 * instrument's own source wins; otherwise there must be exactly one published
 * profile, because a score that cannot name its weighting is not reproducible.
 */
async function resolveProfile(
  instrument: InstrumentInput,
  sources: ScoringSources,
): Promise<WeightingProfileInput> {
  const profiles = await sources.publishedProfiles();

  const pinned =
    instrument.sourceRef === null
      ? undefined
      : profiles.find((profile) => profile.snapshotId === instrument.sourceRef);
  if (pinned) return pinned;

  const only = profiles.length === 1 ? profiles[0] : undefined;
  if (only) return only;

  throw fail(
    'PRECONDITION_FAILED',
    profiles.length === 0
      ? 'No published weighting profile'
      : `${profiles.length} published weighting profiles and nothing says which one scores this instrument`,
  );
}

function marketStageFor(snapshot: MarketShareSnapshotInput | undefined): MarketShareStage {
  const lines = (snapshot?.lines ?? []).filter(
    (line): line is { orgId: string; shareBp: number } => line.orgId !== null,
  );
  // where ACFI has published nothing, the stage stays off and an airport with
  // two terminals is their own mean, which is what the core does with OFF
  if (lines.length === 0) return { mode: 'OFF', sharesBp: {} };
  return {
    mode: 'AIRPORT_ROLLUP',
    sharesBp: Object.fromEntries(lines.map((line) => [line.orgId, line.shareBp])),
  };
}

/**
 * One pass over a cycle. Rollups are replaced wholesale rather than patched,
 * because they are derived data and a half updated set is harder to reason about
 * than a missing one. The cohort snapshot is written last, so a run that dies
 * half way leaves a cycle that is simply not published yet and can be run again.
 */
export async function runScoring(args: RunArgs): Promise<ScoringRunView> {
  const { cycleId, mode, sources, now } = args;

  const existingSnapshot = await CohortSnapshotModel.findOne({ cycleId }).lean().exec();
  if (existingSnapshot) {
    throw conflict(
      mode === 'FINAL'
        ? 'This cycle is already frozen. A published league table does not change.'
        : 'This cycle is frozen. Its rollups are the published ones and are not recomputed.',
    );
  }

  const cycle = await sources.cycle(cycleId);
  if (!cycle) throw notFound('No such cycle');

  if (mode === 'FINAL' && now < cycle.windows.assessmentCloses.utc) {
    throw fail(
      'PRECONDITION_FAILED',
      'The assessment window is still open. A cycle is frozen after it closes, never during it.',
    );
  }

  const participations = await sources.participations(cycleId);

  const assessmentsByOrg = new Map<string, AssessmentInput[]>();
  for (const orgId of new Set(participations.map((p) => p.acoOrgId))) {
    assessmentsByOrg.set(orgId, await sources.submittedAssessments(cycleId, orgId));
  }
  const everyAssessment = [...assessmentsByOrg.values()].flat();

  const instrument = await resolveInstrument(cycle, everyAssessment, sources);
  const profileInput = await resolveProfile(instrument, sources);
  const profile = toWeightingProfile(profileInput);

  for (const scope of new Set([cycle.formScope, ...participations.map((p) => p.formScope)])) {
    const problems = weightingProblems(profile, scope);
    if (problems.length > 0) throw fail('WEIGHTS_DO_NOT_SUM', problems.join('; '));
  }

  const run = await ScoringRunModel.create({
    cycleId,
    mode,
    requestedByUserId: args.requestedByUserId,
    requestedByOrgId: args.requestedByOrgId,
    reason: args.reason,
    startedAt: now,
    participationCount: participations.length,
  });

  try {
    const specs = specsOf(instrument, questionWeightsFor(profileInput, cycle.formScope));
    const parameters = parameterCounts(specs);
    const categories = await sources.categories();

    const headings: CategoryHeading[] = [...new Set([...specs.values()].map((spec) => spec.categoryCode))]
      .map((code) => ({
        code,
        label: categories.get(code)?.name ?? code,
        order: categories.get(code)?.displayOrder ?? Number.MAX_SAFE_INTEGER,
      }))
      .sort((a, b) => a.order - b.order || a.code.localeCompare(b.code))
      .map(({ code, label }) => ({ code, label }));

    const airportIds = participations
      .map((p) => p.airportId)
      .filter((id): id is string => id !== null);
    const airports = await sources.airports(airportIds);
    const shares = await sources.marketShares(airportIds);
    const organisations = await sources.organisations(participations.map((p) => p.acoOrgId));

    const perOrg = new Map<string, number>();
    for (const participation of participations) {
      perOrg.set(participation.acoOrgId, (perOrg.get(participation.acoOrgId) ?? 0) + 1);
    }
    const cohortSize = new Set(airportIds).size;

    const computed: ComputedRollup[] = [];
    let skippedScopeMismatch = 0;

    for (const participation of participations) {
      const bucket = bucketAssessments(
        assessmentsByOrg.get(participation.acoOrgId) ?? [],
        participation,
        perOrg.get(participation.acoOrgId) ?? 1,
      );
      skippedScopeMismatch += bucket.skippedScopeMismatch;

      const organisation = organisations.get(participation.acoOrgId);
      if (!organisation) {
        throw fail(
          'INTERNAL',
          `Participation ${participation._id} names organisation ${participation.acoOrgId}, which does not exist`,
        );
      }
      const terminalName = organisation.displayName ?? organisation.legalName;
      const airport = participation.airportId === null ? undefined : airports.get(participation.airportId);

      computed.push(
        computeRollup({
          cycle,
          participation,
          assessments: bucket.usable,
          specs,
          parameters,
          headings,
          profile,
          instrument: {
            snapshotId: instrument._id,
            version: instrument.version,
            questionCount: [...parameters.values()].reduce((a, b) => a + b, 0),
          },
          terminal: {
            terminalName,
            // an operator with no airport on its participation is scored and
            // reported to itself, but has no row in an airport league table
            airportIata: airport?.iataCode ?? '',
            airportName: airport?.city ?? airport?.name ?? terminalName,
            airportFullName: airport?.name ?? terminalName,
          },
          mode,
          cohortSize,
          now,
        }),
      );
    }

    let snapshot: SnapshotDraft | null = null;
    if (mode === 'FINAL') {
      snapshot = buildSnapshot({
        cycle,
        computed,
        stageFor: (airportId) => marketStageFor(shares.get(airportId)),
        profile: { profileId: profile.profileId, version: profile.version },
        frozenByUserId: args.requestedByUserId,
        frozenByOrgId: args.requestedByOrgId,
        now,
      });

      const ranked = new Map(snapshot.airports.map((row) => [row.airportId, row]));
      for (const entry of computed) {
        const row = entry.airportId === null ? undefined : ranked.get(entry.airportId);
        entry.doc.rank = row?.rank ?? null;
        entry.doc.rankOf = snapshot.totalAirports;
        entry.doc.marketShareApplied = snapshot.marketShare.applied;
      }
    }

    await CycleRollupModel.deleteMany({ cycleId }).exec();
    if (computed.length > 0) {
      await CycleRollupModel.insertMany(computed.map((entry) => entry.doc));
    }

    if (snapshot) await CohortSnapshotModel.create(snapshot);

    const publishedCount = computed.filter((entry) => entry.doc.overall.suppression === 'NONE').length;
    run.finishedAt = new Date();
    run.publishedCount = publishedCount;
    run.suppressedCount = computed.length - publishedCount;
    run.skippedScopeMismatch = skippedScopeMismatch;
    await run.save();

    return ScoringRunView.parse({
      runId: run._id,
      cycleId,
      mode,
      startedAt: run.startedAt.toISOString(),
      finishedAt: run.finishedAt.toISOString(),
      participationCount: participations.length,
      publishedCount,
      suppressedCount: computed.length - publishedCount,
      skippedScopeMismatch,
      frozen: snapshot !== null,
    });
  } catch (error) {
    run.failure = error instanceof Error ? error.message : String(error);
    run.finishedAt = new Date();
    await run.save();
    throw error;
  }
}

type SnapshotDraft = Omit<CohortSnapshotDoc, '_id'>;

function buildSnapshot(args: {
  cycle: CycleInput;
  computed: readonly ComputedRollup[];
  stageFor: (airportId: string) => MarketShareStage;
  profile: { profileId: string; version: number };
  frozenByUserId: string;
  frozenByOrgId: string;
  now: Date;
}): SnapshotDraft {
  const { cycle, computed, now } = args;

  const byAirport = new Map<string, ComputedRollup[]>();
  for (const entry of computed) {
    if (entry.airportId === null) continue;
    byAirport.set(entry.airportId, [...(byAirport.get(entry.airportId) ?? []), entry]);
  }

  const candidates: AirportCandidate[] = [...byAirport].map(([airportId, entries]) => {
    const first = entries[0];
    if (!first) throw fail('INTERNAL', 'An airport group with no operators');

    const operators = entries
      .filter((entry) => entry.doc.overall.suppression === 'NONE' && entry.doc.overall.value !== null)
      .map((entry) => ({ acoId: entry.orgId, value: entry.doc.overall.value ?? 0 }));

    return {
      airportId,
      airportIata: first.doc.terminal.airportIata,
      airportName: first.doc.terminal.airportName,
      airportFullName: first.doc.terminal.airportFullName,
      terminalName:
        entries.length === 1 ? first.doc.terminal.terminalName : `${entries.length} terminals`,
      terminalCount: entries.length,
      orgIds: entries.map((entry) => entry.orgId),
      responseCount: entries.reduce((sum, entry) => sum + entry.doc.overall.responseCount, 0),
      operators,
      marketShare: args.stageFor(airportId),
    };
  });

  const ranked = rankAirports(candidates);
  const ratings = ranked.map((row) => row.rating).filter((rating): rating is number => rating !== null);

  return {
    cycleId: cycle._id,
    cycleLabel: cycle.name,
    frozenAt: now,
    frozenByUserId: args.frozenByUserId,
    frozenByOrgId: args.frozenByOrgId,
    marketShare: {
      mode: candidates.some((candidate) => candidate.marketShare.mode === 'AIRPORT_ROLLUP')
        ? 'AIRPORT_ROLLUP'
        : 'OFF',
      applied: ranked.some((row) => row.marketShareApplied),
    },
    statistics: cohortStatistics(ratings),
    totalAirports: ranked.length,
    rankedCount: ratings.length,
    airports: ranked.map((row) => ({
      airportId: row.airportId,
      airportIata: row.airportIata,
      airportName: row.airportName,
      airportFullName: row.airportFullName,
      terminalName: row.terminalName,
      terminalCount: row.terminalCount,
      rating: row.rating,
      rank: row.rank,
      responseCount: row.responseCount,
      orgIds: [...row.orgIds],
    })),
    weighting: args.profile,
    pipelineVersion: PIPELINE_VERSION,
  };
}

/**
 * Picks the rollup a read is about. One terminal is implied, the way one
 * organisation membership is; an operator that runs two must say which, because
 * silently answering about the wrong terminal is worse than asking.
 */
async function selectRollup(query: { cycleId?: string; airportId?: string }): Promise<StoredRollup> {
  const filter: Record<string, unknown> = {};
  if (query.cycleId !== undefined) filter['cycleId'] = query.cycleId;
  if (query.airportId !== undefined) filter['airportId'] = query.airportId;

  // ULIDs sort by creation time, so the newest cycle is the largest id
  const found = await rollups.find(filter).sort({ cycleId: -1, computedAt: -1 }).limit(20).lean().exec();
  const first = found[0];
  if (!first) throw notFound('No scored cycle for this organisation yet');

  const inCycle = found.filter((row) => row.cycleId === first.cycleId);
  const airports = new Set(inCycle.map((row) => row.airportId ?? row.participationId));
  if (airports.size > 1) {
    throw fail(
      'VALIDATION_FAILED',
      'This organisation has more than one terminal in that cycle. Name one with airportId.',
      inCycle.map((row) => ({
        path: 'airportId',
        message: `${row.airportId ?? 'none'} (${row.terminal.airportIata} ${row.terminal.terminalName})`,
      })),
    );
  }
  return first;
}

async function historyFor(rollup: StoredRollup, limit: number): Promise<StoredRollup[]> {
  const filter: Record<string, unknown> = { airportId: rollup.airportId };
  return rollups.find(filter).sort({ cycleId: -1 }).limit(limit).lean().exec();
}

function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 10) / 10;
}

function publishedValue(rollup: StoredRollup): number | null {
  return rollup.overall.suppression === 'NONE' ? rollup.overall.value : null;
}

/**
 * The names of the airports a dashboard did not have room to list. Generated
 * from the snapshot rather than written down, so it cannot go stale when the
 * cohort grows.
 */
function footnoteFor(shown: readonly string[], snapshot: CohortSnapshotDoc): string {
  const remaining = snapshot.airports.filter((row) => !shown.includes(row.airportIata));
  if (remaining.length === 0) return `Every airport in ${snapshot.cycleLabel} is listed.`;

  const named = remaining.slice(0, 3).map((row) => row.airportName);
  const rest = remaining.length - named.length;
  const list = named.join(', ');
  return rest === 0
    ? `${list} also took part in ${snapshot.cycleLabel}.`
    : `${list} and ${rest} more airport${rest === 1 ? '' : 's'} took part in ${snapshot.cycleLabel}.`;
}

function rankingRows(
  snapshot: CohortSnapshotDoc | SnapshotDraft,
  orgId: string,
): { rows: DashboardData['rankings']['rows']; shown: string[] } {
  const ranked = snapshot.airports.filter(
    (row): row is CohortAirportRow & { rank: number } => row.rank !== null,
  );
  const top = ranked.slice(0, RANKING_ROWS_SHOWN);

  // the caller always sees its own position, even from outside the top of the table
  const selfRow = ranked.find((row) => row.orgIds.includes(orgId));
  if (selfRow && !top.some((row) => row.airportIata === selfRow.airportIata)) top.push(selfRow);

  const rows = top.map((row) => ({
    rank: row.rank,
    airportIata: row.airportIata,
    airportName: row.airportName,
    terminalName: row.terminalName,
    rating: row.rating,
    isSelf: row.orgIds.includes(orgId),
  }));

  return { rows, shown: rows.map((row) => row.airportIata) };
}

export async function readDashboard(query: DashboardQuery): Promise<DashboardData> {
  const orgId = requireOrgId();
  const current = await selectRollup(query);
  const history = await historyFor(current, 40);
  const previous = history.find((row) => row.cycleId < current.cycleId) ?? null;

  const snapshot =
    current.mode === 'FINAL'
      ? await CohortSnapshotModel.findOne({ cycleId: current.cycleId }).lean().exec()
      : null;

  const rankings = snapshot
    ? rankingRows(snapshot, orgId)
    : { rows: [] as DashboardData['rankings']['rows'], shown: [] as string[] };

  const previousByCategory = new Map((previous?.categories ?? []).map((c) => [c.categoryCode, c]));

  return DashboardData.parse({
    cycle: { id: current.cycleId, label: current.cycle.label, state: current.cycle.state },
    terminal: {
      // the assessed operator's organisation: one row per terminal it runs
      acoId: current.orgId,
      terminalName: current.terminal.terminalName,
      airportIata: current.terminal.airportIata,
      airportName: current.terminal.airportName,
      airportFullName: current.terminal.airportFullName,
    },
    overall: {
      value: current.overall.value,
      suppression: current.overall.suppression,
      rank: current.rank,
      rankOf: current.rankOf,
      assessmentCount: current.counts.total,
      selfCount: current.counts.self,
      customerCount: current.counts.customer,
    },
    ratings: {
      overall: {
        self: mean(history.map((row) => row.self.value).filter((v): v is number => v !== null)),
        customer: mean(history.map(publishedValue).filter((v): v is number => v !== null)),
      },
      current: { self: current.self.value, customer: publishedValue(current) },
      previous: {
        self: previous?.self.value ?? null,
        customer: previous === null ? null : publishedValue(previous),
      },
    },
    feedback: {
      totalResponses: current.distribution.reduce((sum, row) => sum + row.count, 0),
      distribution: current.distribution.map((row) => ({
        key: row.key,
        label: labelFor(row.key),
        count: row.count,
        percent: row.percent,
      })),
    },
    categories: current.categories.map((category) => {
      const before = previousByCategory.get(category.categoryCode) ?? null;
      const previousValue = before?.suppression === 'NONE' ? before.value : null;
      const currentValue = category.suppression === 'NONE' ? category.value : null;
      return {
        code: category.categoryCode,
        label: category.label,
        current: currentValue,
        previous: previousValue,
        delta:
          currentValue === null || previousValue === null
            ? null
            : Math.round((currentValue - previousValue) * 10) / 10,
        parameterCount: category.parameterCount,
      };
    }),
    rankings: {
      rows: rankings.rows,
      totalAirports: snapshot?.totalAirports ?? current.rankOf,
      footnote: snapshot
        ? footnoteFor(rankings.shown, snapshot)
        : 'Rankings are published when the cycle is frozen.',
    },
  });
}

const RATING_LABELS: Readonly<Record<string, string>> = {
  EXCELLENT: 'Excellent',
  VERY_GOOD: 'Very good',
  GOOD: 'Good',
  FAIR: 'Fair',
  POOR: 'Poor',
};

function labelFor(key: string): string {
  return RATING_LABELS[key] ?? key;
}

function toRollupView(rollup: StoredRollup): RollupView {
  return RollupView.parse({
    cycleId: rollup.cycleId,
    cycleLabel: rollup.cycle.label,
    participationId: rollup.participationId,
    mode: rollup.mode,
    formScope: rollup.formScope,
    terminal: rollup.terminal,
    counts: rollup.counts,
    overall: asEnvelope(rollup.overall, rollup),
    categories: rollup.categories.map((category) => ({
      categoryCode: category.categoryCode,
      label: category.label,
      parameterCount: category.parameterCount,
      ...asEnvelope(category, rollup),
    })),
    directions: rollup.directions.map((direction) => ({
      direction: direction.direction,
      ...asEnvelope(direction, rollup),
    })),
    distribution: rollup.distribution,
    self: {
      value: rollup.self.value,
      coverageBp: rollup.self.coverageBp,
      responseCount: rollup.self.responseCount,
    },
    gap: rollup.gap,
    rank: rollup.rank,
    rankOf: rollup.rankOf,
    instrument: rollup.instrument,
    weightingProfile: {
      profileId: rollup.weighting.profileId,
      version: rollup.weighting.version,
      basis: rollup.weighting.basis,
    },
    pipelineVersion: rollup.pipelineVersion,
    computedAt: rollup.computedAt.toISOString(),
    frozenAt: rollup.frozenAt === null ? null : rollup.frozenAt.toISOString(),
  });
}

export async function readRollups(query: RollupQuery): Promise<RollupView[]> {
  const filter: Record<string, unknown> = {};
  if (query.cycleId !== undefined) filter['cycleId'] = query.cycleId;
  if (query.participationId !== undefined) filter['participationId'] = query.participationId;

  const found = await rollups.find(filter).sort({ cycleId: -1 }).limit(query.limit).lean().exec();
  return found.map(toRollupView);
}

export async function readTrend(query: TrendQuery): Promise<TrendView> {
  const anchor = await selectRollup(query.airportId === undefined ? {} : { airportId: query.airportId });
  const history = await historyFor(anchor, query.limit);

  const points = [...history]
    .sort((a, b) => a.cycleId.localeCompare(b.cycleId))
    .map((rollup) => ({
      cycleId: rollup.cycleId,
      cycleLabel: rollup.cycle.label,
      computedAt: rollup.computedAt.toISOString(),
      customer: publishedValue(rollup),
      self: rollup.self.value,
      gap: rollup.gap.overall,
      suppression: rollup.overall.suppression,
      responseCount: rollup.overall.responseCount,
      rank: rollup.rank,
      rankOf: rollup.rankOf,
    }));

  return TrendView.parse({
    participationIds: history.map((rollup) => rollup.participationId),
    points,
  });
}

/**
 * The gap between what an operator thinks of itself and what its customers
 * think. Only stated where the customer figure is publishable: a gap against a
 * suppressed score is a gap against noise.
 */
export async function readPerceptionGap(query: GapQuery): Promise<PerceptionGapView> {
  const rollup = await selectRollup(query);
  const selfByCategory = new Map(rollup.self.categories.map((c) => [c.categoryCode, c.value]));

  return PerceptionGapView.parse({
    cycleId: rollup.cycleId,
    cycleLabel: rollup.cycle.label,
    overall: {
      self: rollup.self.value,
      customer: publishedValue(rollup),
      gap: rollup.gap.overall,
    },
    categories: rollup.categories.map((category) => {
      const self = selfByCategory.get(category.categoryCode) ?? null;
      const customer = category.suppression === 'NONE' ? category.value : null;
      return {
        categoryCode: category.categoryCode,
        label: category.label,
        self: self === null ? null : Math.round(self * 10) / 10,
        customer,
        gap: gapOf(self, customer),
      };
    }),
  });
}

/**
 * The league table. Readable only by an organisation that took part in the
 * cycle, and only once it is frozen, and never carrying the identifiers the
 * snapshot keeps in order to answer "is this row you".
 */
export async function readCohort(cycleId: string): Promise<CohortView> {
  const orgId = requireOrgId();
  const own = await rollups.countDocuments({ cycleId });
  if (own === 0) throw notFound('No such cycle');

  const snapshot = await CohortSnapshotModel.findOne({ cycleId }).lean().exec();
  if (!snapshot) throw notFound('That cycle has not been frozen yet');

  return CohortView.parse({
    cycleId: snapshot.cycleId,
    cycleLabel: snapshot.cycleLabel,
    frozenAt: snapshot.frozenAt.toISOString(),
    totalAirports: snapshot.totalAirports,
    rankedCount: snapshot.rankedCount,
    marketShareApplied: snapshot.marketShare.applied,
    statistics: snapshot.statistics,
    rows: snapshot.airports.map((row) => ({
      rank: row.rank,
      airportIata: row.airportIata,
      airportName: row.airportName,
      terminalName: row.terminalName,
      rating: row.rating,
      isSelf: row.orgIds.includes(orgId),
    })),
  });
}
