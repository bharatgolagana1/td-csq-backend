import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { JobModel } from '../src/core/jobs.model.js';
import { daySlot, hourSlot, once, scheduler } from '../src/core/scheduler.js';
import { heartbeat } from '../src/jobs/heartbeat.job.js';

import { createTestApp, type TestApp } from './helpers/app.js';

let t: TestApp;

beforeAll(async () => {
  t = await createTestApp({ airports: false });
});
afterAll(() => t.close());

describe('once()', () => {
  it('runs a slot exactly once and records DONE with the detail', async () => {
    let runs = 0;
    const first = await once('demo', 'ref-1', 'slot-1', async () => {
      runs += 1;
      return 'did it';
    });
    const second = await once('demo', 'ref-1', 'slot-1', async () => {
      runs += 1;
      return undefined;
    });
    expect(first).toEqual({ ran: true, ok: true });
    expect(second).toEqual({ ran: false, ok: true });
    expect(runs).toBe(1);
    const row = await JobModel.findOne({ type: 'demo', refId: 'ref-1', slot: 'slot-1' }).lean();
    expect(row).toMatchObject({ status: 'DONE', detail: 'did it' });
    expect(row?.finishedAt).toBeInstanceOf(Date);
  });

  it('different slots run independently', async () => {
    const other = await once('demo', 'ref-1', 'slot-2', async () => undefined);
    expect(other.ran).toBe(true);
    expect(await JobModel.countDocuments({ type: 'demo', refId: 'ref-1' })).toBe(2);
  });

  it('records FAILED, re-throws, and retries the slot on the next call', async () => {
    await expect(
      once('demo', 'ref-2', 'slot-1', async () => {
        throw new Error('transient');
      }),
    ).rejects.toThrow('transient');
    expect((await JobModel.findOne({ type: 'demo', refId: 'ref-2' }).lean())?.status).toBe('FAILED');
    const retry = await once('demo', 'ref-2', 'slot-1', async () => 'recovered');
    expect(retry).toEqual({ ran: true, ok: true });
    expect((await JobModel.findOne({ type: 'demo', refId: 'ref-2' }).lean())).toMatchObject({ status: 'DONE', detail: 'recovered' });
    expect(await JobModel.countDocuments({ type: 'demo', refId: 'ref-2' })).toBe(1);
  });

  it('provides hourly and daily slot keys', () => {
    const date = new Date('2026-10-07T13:45:10.000Z');
    expect(hourSlot(date)).toBe('2026-10-07T13');
    expect(daySlot(date)).toBe('2026-10-07');
  });
});

describe('scheduler', () => {
  it('runs registered runners on tick, isolates failures and reports status', async () => {
    scheduler.reset();
    const seen: string[] = [];
    scheduler.registerJob('first', async ({ now }) => {
      seen.push(`first@${now.toISOString()}`);
    });
    scheduler.registerJob('broken', async () => {
      throw new Error('kaput');
    });
    scheduler.registerJob('heartbeat', heartbeat);
    expect(() => scheduler.registerJob('first', async () => undefined)).toThrow(/already registered/);

    const now = new Date('2026-10-07T09:00:30.000Z');
    await scheduler.tick(now);
    expect(seen).toEqual(['first@2026-10-07T09:00:30.000Z']);
    const status = scheduler.status();
    expect(status).toMatchObject({ enabled: false, running: false, lastTickAt: now.toISOString(), lastError: 'broken: kaput', jobs: ['first', 'broken', 'heartbeat'] });
    expect(typeof status.lastTickMs).toBe('number');

    const beat = await JobModel.findOne({ type: 'heartbeat', refId: 'scheduler', slot: '2026-10-07T09' }).lean();
    expect(beat?.status).toBe('DONE');
    await scheduler.tick(new Date('2026-10-07T09:01:30.000Z'));
    expect(await JobModel.countDocuments({ type: 'heartbeat' })).toBe(1);
    scheduler.reset();
  });

  it('does not start when disabled', () => {
    scheduler.configure({ enabled: false });
    scheduler.start();
    expect(scheduler.status().running).toBe(false);
  });
});
