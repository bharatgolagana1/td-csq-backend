import { createTask, type ScheduledTask } from 'node-cron';
import type { Logger } from 'pino';

import { JobModel } from './jobs.model.js';
import { logger } from './logger.js';

export interface JobRunContext {
  now: Date;
  log: Logger;
}

/** A runner is called once per tick; it decides what is due and uses `once()` for idempotency. */
export type JobRunner = (ctx: JobRunContext) => Promise<void>;

export interface SchedulerStatus {
  enabled: boolean;
  running: boolean;
  lastTickAt: string | null;
  lastTickMs: number | null;
  lastError: string | null;
  jobs: string[];
}

class Scheduler {
  private enabled = false;
  private task: ScheduledTask | null = null;
  private ticking = false;
  private readonly runners = new Map<string, JobRunner>();
  private lastTickAt: Date | null = null;
  private lastTickMs: number | null = null;
  private lastError: string | null = null;

  configure(options: { enabled: boolean }): void {
    this.enabled = options.enabled;
  }

  /** Registers a named runner. Names are unique; registering twice is a programming error. */
  registerJob(name: string, runner: JobRunner): void {
    if (this.runners.has(name)) throw new Error(`Job "${name}" is already registered`);
    this.runners.set(name, runner);
  }

  start(): void {
    if (!this.enabled || this.task) return;
    this.task = createTask('* * * * *', () => this.tick(), { name: 'csq-scheduler', noOverlap: true });
    void this.task.start();
    logger.info({ jobs: [...this.runners.keys()] }, 'Scheduler started (every minute)');
  }

  async stop(): Promise<void> {
    if (!this.task) return;
    await this.task.destroy();
    this.task = null;
  }

  /** Runs every registered runner once, in registration order, isolating failures. */
  async tick(now = new Date()): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    const started = Date.now();
    this.lastError = null;
    try {
      for (const [name, runner] of this.runners) {
        const log = logger.child({ job: name });
        try {
          await runner({ now, log });
        } catch (error) {
          this.lastError = `${name}: ${error instanceof Error ? error.message : String(error)}`;
          log.error({ err: error }, 'Job runner failed');
        }
      }
    } finally {
      this.lastTickAt = now;
      this.lastTickMs = Date.now() - started;
      this.ticking = false;
    }
  }

  status(): SchedulerStatus {
    return {
      enabled: this.enabled,
      running: this.task !== null,
      lastTickAt: this.lastTickAt?.toISOString() ?? null,
      lastTickMs: this.lastTickMs,
      lastError: this.lastError,
      jobs: [...this.runners.keys()],
    };
  }

  /** Test hook. */
  reset(): void {
    this.runners.clear();
    this.lastTickAt = null;
    this.lastTickMs = null;
    this.lastError = null;
  }
}

export const scheduler = new Scheduler();

export interface OnceResult {
  /** false when another instance already ran (or is running) this slot. */
  ran: boolean;
  ok: boolean;
}

/**
 * Runs `fn` at most once per (type, refId, slot) across every instance, using
 * the unique index on `jobs`. A FAILED slot is retried on the next call; a
 * DONE or RUNNING slot is skipped. Errors thrown by `fn` are recorded and
 * re-thrown.
 */
export async function once(
  type: string,
  refId: string,
  slot: string,
  fn: () => Promise<string | undefined>,
): Promise<OnceResult> {
  const now = new Date();
  const claimed = await claimSlot(type, refId, slot, now);
  if (!claimed) return { ran: false, ok: true };
  try {
    const detail = await fn();
    await JobModel.updateOne(
      { type, refId, slot },
      { $set: { status: 'DONE', finishedAt: new Date(), detail: detail ?? null } },
    );
    return { ran: true, ok: true };
  } catch (error) {
    await JobModel.updateOne(
      { type, refId, slot },
      { $set: { status: 'FAILED', finishedAt: new Date(), detail: error instanceof Error ? error.message : String(error) } },
    );
    throw error;
  }
}

async function claimSlot(type: string, refId: string, slot: string, now: Date): Promise<boolean> {
  try {
    await JobModel.create({ type, refId, slot, status: 'RUNNING', ranAt: now });
    return true;
  } catch (error) {
    if (!(typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 11000)) throw error;
  }
  const retried = await JobModel.findOneAndUpdate(
    { type, refId, slot, status: 'FAILED' },
    { $set: { status: 'RUNNING', ranAt: now, finishedAt: null, detail: null } },
  ).lean();
  return retried !== null;
}

/** `YYYY-MM-DDTHH` in UTC — a convenient hourly slot key. */
export function hourSlot(date: Date): string {
  return date.toISOString().slice(0, 13);
}

/** `YYYY-MM-DD` in UTC — a daily slot key. */
export function daySlot(date: Date): string {
  return date.toISOString().slice(0, 10);
}
