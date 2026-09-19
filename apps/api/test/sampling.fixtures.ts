import mongoose from 'mongoose';
import express, { type Express } from 'express';
import { newId } from '../src/kernel/ids.js';
import { errorHandler, notFoundHandler } from '../src/kernel/errors.js';
import { mountModules } from '../src/kernel/router.js';
import { runAnonymous, runAsPrincipal, runWithoutOrg, type Principal } from '../src/kernel/requestContext.js';
import { samplingModule } from '../src/modules/sampling/sampling.module.js';
import {
  BatchIntegrityModel,
  ContactImportModel,
  CustomerContactModel,
  CyclePolicyModel,
  SamplingAuditModel,
  SamplingBatchModel,
  SamplingSettingsModel,
} from '../src/modules/sampling/sampling.models.js';
import { silentLog } from './mongo.js';
import type { CyclePolicyBody } from '../src/modules/sampling/sampling.contracts.js';

export const ALL_SAMPLING_CAPABILITIES = [
  'sampling:read',
  'sampling:administer',
  'sampling.contacts:write',
  'sampling.batches:write',
  'sampling:review',
] as const;

export function samplingPrincipal(
  userId: string,
  orgId: string,
  capabilities: readonly string[] = ALL_SAMPLING_CAPABILITIES,
): Principal {
  return {
    userId,
    subject: `sub-${userId}`,
    email: null,
    displayName: userId,
    memberships: [{ orgId, roles: ['ADMIN'], capabilities: [...capabilities], active: true }],
  };
}

export const SAMPLING_MODELS = [
  CustomerContactModel,
  ContactImportModel,
  SamplingBatchModel,
  BatchIntegrityModel,
  SamplingAuditModel,
  SamplingSettingsModel,
  CyclePolicyModel,
];

export async function syncSamplingIndexes(): Promise<void> {
  for (const model of SAMPLING_MODELS) await model.syncIndexes();
}

export async function clearSampling(): Promise<void> {
  for (const model of SAMPLING_MODELS) {
    await mongoose.connection.collection(model.collection.name).deleteMany({});
  }
}

/** Runs a service call inside a request scope, the way a route would. */
export function asOrg<T>(principal: Principal, orgId: string, fn: () => T): T {
  return runAsPrincipal({ requestId: newId(), principal, orgId }, fn);
}

/**
 * The real router with the real policy checks, wired to test scopes. Only the
 * two scope entries are supplied here; every guard, parser and error mapping
 * below them is the one that runs in production.
 */
export function samplingApp(principal: Principal, orgId: string): Express {
  const app = express();
  app.use(express.json());
  app.use((_req, _res, next) => runAnonymous(newId(), () => next()));
  app.use(
    mountModules([samplingModule], {
      authenticate: (_req, _res, next) => next(),
      enterSelfScope: (_req, _res, next) => runWithoutOrg({ requestId: newId(), principal }, () => next()),
      enterOrgScope: (_req, _res, next) => runAsPrincipal({ requestId: newId(), principal, orgId }, () => next()),
      log: silentLog,
    }),
  );
  app.use(notFoundHandler);
  app.use(errorHandler(silentLog));
  return app;
}

const WALL = new Map<string, Intl.DateTimeFormat>();

/** The wall clock reading of an instant in a zone, as the policy endpoint expects it. */
export function wallTimeIn(utc: Date, tz: string): string {
  let format = WALL.get(tz);
  if (!format) {
    format = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    WALL.set(tz, format);
  }
  const parts = format.formatToParts(utc);
  const part = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}:${part('second')}`;
}

export const TZ = 'Asia/Kolkata';

export function boundary(utc: Date, tz: string = TZ): { wall: string; tz: string; utc: Date } {
  return { wall: wallTimeIn(utc, tz), tz, utc };
}

const DAY = 24 * 60 * 60 * 1000;

/**
 * A cycle whose sampling window is open now and whose assessment window opened
 * before sampling closes, which is the overlap the product requires: customers
 * added after assessment has begun still have to be samplable.
 */
export function openCyclePolicy(now: Date, minimumSamplingSize: number): CyclePolicyBody {
  return {
    minimumSamplingSize,
    samplingOpens: boundary(new Date(now.getTime() - 10 * DAY)),
    samplingCloses: boundary(new Date(now.getTime() + 10 * DAY)),
    assessmentOpens: boundary(new Date(now.getTime() - 2 * DAY)),
    assessmentCloses: boundary(new Date(now.getTime() + 30 * DAY)),
  };
}
