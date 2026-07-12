import { setTimeout as sleep } from "node:timers/promises";

import { PgBoss, fromKysely, fromPglite, type Db as BossDb } from "pg-boss";

import type { RunnerDeps } from "../engine/runner/runner.js";
import { executeRun } from "../engine/runner/runner.js";
import { assertRunTransition } from "../engine/runner/states.js";
import { isAppError } from "../shared/errors.js";
import type { Db } from "../storage/db.js";
import { getRun, setRunStatus, type RunRow } from "../storage/repositories/run-repo.js";
import type { JobQueue } from "./run-worker.js";

const QUEUE = "run-execute";

/**
 * pg-boss-backed JobQueue (ADR-002, activated at M3). One queue; each job is
 * `{ runId }`, keyed with singletonKey=runId for observability. NOTE: on a
 * standard-policy queue singletonKey does NOT dedupe — the run lease
 * (claimRunLease) is the single-driver guarantee: a duplicate delivery loses
 * the lease claim and exits via the LEASE_HELD no-op (tested). A run paused by
 * a provider rate limit reschedules itself with startAfter=resume_at; delayed
 * jobs persist across restart (spike scenario 2).
 *
 * pg-boss shares the app's single database connection via fromPglite/fromKysely
 * — never a second boss on the same pglite:// directory (ADR-017).
 */
export class PgBossRunWorker implements JobQueue {
  private readonly boss: PgBoss;
  private readonly boundaryPollMs: number;
  private readonly boundaryMaxWaitMs: number;
  private started = false;

  constructor(
    private readonly deps: RunnerDeps,
    private readonly db: Db,
    opts: { boundaryPollMs?: number; boundaryMaxWaitMs?: number } = {},
  ) {
    this.boss = new PgBoss({ db: bossDb(db), supervise: true, schedule: false });
    this.boss.on("error", () => undefined);
    this.boundaryPollMs = opts.boundaryPollMs ?? 200;
    this.boundaryMaxWaitMs = opts.boundaryMaxWaitMs ?? 60_000;
  }

  async start(): Promise<void> {
    if (this.started) return;
    await this.boss.start();
    await this.boss.createQueue(QUEUE);
    await this.boss.work<{ runId: string }>(QUEUE, { batchSize: 1, pollingIntervalSeconds: 1 }, async (jobs) => {
      for (const job of jobs) await this.execute(job.data.runId);
    });
    await this.sweep();
    this.started = true;
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    await this.boss.stop({ graceful: false });
    this.started = false;
  }

  async runToBoundary(runId: string): Promise<RunRow> {
    if (!this.started) await this.start();
    await this.boss.send(QUEUE, { runId }, { singletonKey: runId, retryLimit: 3, retryDelay: 1 });
    const deadline = Date.now() + this.boundaryMaxWaitMs;
    for (;;) {
      const run = await getRun(this.db.kysely, runId);
      // A rate-limit pause returns immediately; the delayed job resumes it later.
      if (run.status !== "pending" && run.status !== "running") return run;
      if (Date.now() > deadline) return run;
      await sleep(this.boundaryPollMs);
    }
  }

  /** The work handler body: auto-resume a due rate-limit pause, then run to boundary. */
  private async execute(runId: string): Promise<void> {
    const before = await getRun(this.db.kysely, runId);
    if (before.status === "paused" && before.pause_reason === "rate_limited") {
      if (before.resume_at !== null && new Date(before.resume_at) > new Date()) {
        // Not due yet (defensive): reschedule and let this delivery complete.
        await this.boss.send(QUEUE, { runId }, { singletonKey: runId, startAfter: new Date(before.resume_at) });
        return;
      }
      assertRunTransition("paused", "running");
      await setRunStatus(this.db.kysely, runId, "running", { pauseReason: null, resumeAt: null });
    }

    try {
      const run = await executeRun(this.deps, runId);
      if (run.status === "paused" && run.pause_reason === "rate_limited" && run.resume_at !== null) {
        await this.boss.send(QUEUE, { runId }, { singletonKey: runId, startAfter: new Date(run.resume_at) });
      }
    } catch (err) {
      // Another driver holds the lease — a benign duplicate delivery, not a failure.
      if (isAppError(err) && err.code === "LEASE_HELD") return;
      // Under a background worker there is no caller to surface the crash to:
      // record it on the run (status untouched — the pg-boss retry reclaims the
      // expired lease and resumes) so status views show WHY it is stuck.
      await this.db.kysely
        .updateTable("runs")
        .set({
          last_error: JSON.stringify({
            message: err instanceof Error ? err.message : String(err),
            source: "pg-boss-worker",
            at: new Date().toISOString(),
          }),
          updated_at: new Date(),
        })
        .where("id", "=", runId)
        .execute()
        .catch(() => undefined);
      throw err;
    }
  }

  /** On startup, enqueue rate-limit pauses whose resume_at has already arrived. */
  private async sweep(): Promise<void> {
    const due = await this.db.kysely
      .selectFrom("runs")
      .select("id")
      .where("status", "=", "paused")
      .where("pause_reason", "=", "rate_limited")
      .where("resume_at", "<=", new Date())
      .execute();
    for (const row of due) {
      await this.boss.send(QUEUE, { runId: row.id }, { singletonKey: row.id });
    }
  }
}

function bossDb(db: Db): BossDb {
  if (db.kind === "pglite" && db.pglite) return fromPglite(db.pglite);
  return fromKysely(db.kysely);
}
