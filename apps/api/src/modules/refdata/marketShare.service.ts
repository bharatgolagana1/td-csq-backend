import { fail, notFound } from '../../kernel/errors.js';
import {
  MarketShareSnapshotModel,
  type MarketShareLine,
  type MarketShareSnapshotDoc,
  type AirportDoc,
} from './refdata.models.js';
import { requireAirport } from './airports.service.js';
import { BP_TOTAL, type MarketShareDerivation } from './refdata.contracts.js';

/**
 * Market share at an airport, as the CSQ requirements define it:
 *
 *   one operator at the airport                      100 percent, no judgement
 *   several operators, one subscribed to CSQ         100 percent, no judgement
 *   several subscribed                               apportioned, totalling 100
 *
 * Which of the three applies is read off the airport's operator roster and is
 * never accepted from the caller. A submission that claimed to be the sole
 * subscriber at an airport where three operators subscribe would silently give
 * one of them the whole airport's weight in the national roll-up.
 *
 * Shares are basis points, and they total exactly 10000. Percentages that
 * "round to 100" are how a roll-up quietly stops being a weighted mean.
 */

export interface MarketShareView {
  snapshotId: string;
  iataCode: string;
  derivation: MarketShareDerivation;
  operatorsAtAirport: number;
  subscribedOperators: number;
  lines: MarketShareLine[];
  effectiveFrom: string;
  note: string | null;
}

function toView(doc: MarketShareSnapshotDoc): MarketShareView {
  return {
    snapshotId: doc._id,
    iataCode: doc.iataCode,
    derivation: doc.derivation,
    operatorsAtAirport: doc.operatorsAtAirport,
    subscribedOperators: doc.subscribedOperators,
    lines: doc.lines.map((line) => ({ ...line })),
    effectiveFrom: doc.effectiveFrom.toISOString(),
    note: doc.note,
  };
}

export async function currentMarketShare(iataCode: string, asOf: Date = new Date()): Promise<MarketShareView> {
  const airport = await requireAirport(iataCode);
  const rows = await MarketShareSnapshotModel.find({ airportId: airport._id, effectiveFrom: { $lte: asOf } })
    .sort({ effectiveFrom: -1 })
    .limit(1)
    .lean()
    .exec();

  const latest = rows[0];
  if (!latest) throw notFound('No market share has been recorded for this airport');
  return toView(latest);
}

export async function marketShareHistory(iataCode: string, limit: number): Promise<MarketShareView[]> {
  const airport = await requireAirport(iataCode);
  const rows = await MarketShareSnapshotModel.find({ airportId: airport._id })
    .sort({ effectiveFrom: -1 })
    .limit(limit)
    .lean()
    .exec();
  return rows.map(toView);
}

interface Subscriber {
  orgId: string;
  operatorKey: string;
  operatorName: string;
}

function subscribersOf(airport: AirportDoc): Subscriber[] {
  const out: Subscriber[] = [];
  for (const entry of airport.operatorRoster) {
    if (!entry.subscribed || entry.orgId === null) continue;
    out.push({ orgId: entry.orgId, operatorKey: entry.operatorKey, operatorName: entry.name });
  }
  return out;
}

export function deriveCase(operatorsAtAirport: number, subscribed: number): MarketShareDerivation {
  if (operatorsAtAirport === 1) return 'SOLE_OPERATOR';
  return subscribed === 1 ? 'SOLE_SUBSCRIBER' : 'DISTRIBUTED';
}

export async function recordMarketShare(
  iataCode: string,
  input: { lines?: ReadonlyArray<{ orgId: string; shareBp: number }>; effectiveFrom?: string; note: string | null },
  createdBy: string | null,
): Promise<MarketShareView> {
  const airport = await requireAirport(iataCode);
  const subscribers = subscribersOf(airport);
  const operatorsAtAirport = airport.operatorRoster.length;

  if (operatorsAtAirport === 0) {
    throw fail('VALIDATION_FAILED', `${iataCode} has no operators on its roster. Record the roster first.`);
  }
  if (subscribers.length === 0) {
    throw fail('VALIDATION_FAILED', `No operator at ${iataCode} subscribes to CSQ, so there is nothing to apportion.`);
  }

  const derivation = deriveCase(operatorsAtAirport, subscribers.length);
  const lines = buildLines(derivation, subscribers, input.lines);

  const effectiveFrom = input.effectiveFrom ? new Date(input.effectiveFrom) : new Date();
  const latest = await MarketShareSnapshotModel.find({ airportId: airport._id })
    .sort({ effectiveFrom: -1 })
    .limit(1)
    .select('effectiveFrom')
    .lean()
    .exec();
  const previous = latest[0];
  if (previous && effectiveFrom <= previous.effectiveFrom) {
    // a snapshot dated at or before the standing one would never be read back,
    // so accepting it would be accepting a change that does nothing
    throw fail(
      'CONFLICT',
      `The standing market share for ${iataCode} takes effect at ${previous.effectiveFrom.toISOString()}. A new one must be later.`,
    );
  }

  const created = await MarketShareSnapshotModel.create({
    airportId: airport._id,
    iataCode: airport.iataCode,
    derivation,
    operatorsAtAirport,
    subscribedOperators: subscribers.length,
    lines,
    effectiveFrom,
    note: input.note,
    createdBy,
  });
  return toView(created.toObject());
}

function buildLines(
  derivation: MarketShareDerivation,
  subscribers: readonly Subscriber[],
  offered: ReadonlyArray<{ orgId: string; shareBp: number }> | undefined,
): MarketShareLine[] {
  if (derivation !== 'DISTRIBUTED') {
    const only = subscribers[0];
    if (!only) throw fail('INTERNAL', 'A sole subscriber case with no subscriber');
    if (offered !== undefined) {
      const single = offered.length === 1 ? offered[0] : undefined;
      if (!single || single.orgId !== only.orgId || single.shareBp !== BP_TOTAL) {
        throw fail(
          'VALIDATION_FAILED',
          'This airport has one subscribed operator, so the only possible share is all of it. Send no lines, or that one line at 10000.',
        );
      }
    }
    return [{ orgId: only.orgId, operatorKey: only.operatorKey, operatorName: only.operatorName, shareBp: BP_TOTAL }];
  }

  if (offered === undefined) {
    throw fail(
      'VALIDATION_FAILED',
      `${subscribers.length} operators here subscribe to CSQ, so their shares have to be stated. There is no default.`,
    );
  }

  const problems: Array<{ path: string; message: string }> = [];
  const byOrg = new Map<string, number>();
  offered.forEach((line, index) => {
    if (byOrg.has(line.orgId)) {
      problems.push({ path: `lines.${index}.orgId`, message: 'appears twice' });
      return;
    }
    byOrg.set(line.orgId, line.shareBp);
  });

  const lines: MarketShareLine[] = [];
  for (const subscriber of subscribers) {
    const shareBp = byOrg.get(subscriber.orgId);
    if (shareBp === undefined) {
      problems.push({ path: 'lines', message: `${subscriber.operatorName} subscribes here but has no share` });
      continue;
    }
    byOrg.delete(subscriber.orgId);
    lines.push({
      orgId: subscriber.orgId,
      operatorKey: subscriber.operatorKey,
      operatorName: subscriber.operatorName,
      shareBp,
    });
  }
  for (const orgId of byOrg.keys()) {
    problems.push({ path: 'lines', message: `${orgId} does not subscribe at this airport` });
  }
  if (problems.length > 0) {
    throw fail('VALIDATION_FAILED', 'The shares do not match who subscribes at this airport', problems);
  }

  const total = lines.reduce((running, line) => running + line.shareBp, 0);
  if (total !== BP_TOTAL) {
    throw fail('WEIGHTS_DO_NOT_SUM', `Shares total ${total} basis points, not ${BP_TOTAL}`);
  }
  return lines;
}
