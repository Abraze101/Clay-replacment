import { setTimeout as sleep } from "node:timers/promises";

import type { RunnerDeps } from "../engine/runner/runner.js";
import { executeRun } from "../engine/runner/runner.js";
import { assertRunTransition } from "../engine/runner/states.js";
import { getRun, setRunStatus, type RunRow } from "../storage/repositories/run-repo.js";

/**
 * The background-execution seam. M0/M1 ship the in-process claim-and-drain
 * driver over the run lease + run_item_steps ledger; the pg-boss driver
 * (PgBossRunWorker) fills this same interface at M3 (ADR-002). The engine never
 * imports a queue library directly.
 */
export interface JobQueue {
  /** Execute (or continue) a run to its next durable boundary. */
  runToBoundary(runId: string): Promise<RunRow>;
}

export class InProcessRunWorker implements JobQueue {
  private readonly maxInlineWaitMs: number;

  constructor(private readonly deps: RunnerDeps, opts: { maxInlineWaitSeconds?: number } = {}) {
    // Inline rate-limit self-heal is OPT-IN (default off): a short provider
    // rate-limit pause is slept out and resumed in-process so the CLI happy path
    // heals itself. Tests and long-lived servers keep it 0 (deterministic pause).
    this.maxInlineWaitMs = Math.max(0, opts.maxInlineWaitSeconds ?? 0) * 1000;
  }

  async runToBoundary(runId: string): Promise<RunRow> {
    // Provider-side waits self-heal inline: rate-limit pauses and async
    // vendor-job polls (awaiting_provider, ADR-029) both carry resume_at.
    const providerWait = (r: RunRow): boolean =>
      r.pause_reason === "rate_limited" || r.pause_reason === "awaiting_provider";
    let run = await executeRun(this.deps, runId);
    while (run.status === "paused" && providerWait(run) && run.resume_at !== null) {
      const waitMs = new Date(run.resume_at).getTime() - Date.now();
      if (waitMs > this.maxInlineWaitMs) break; // too long to hold inline; leave for a resident worker
      if (waitMs > 0) await sleep(waitMs);
      // Auto-resume without a fresh approval (budget/cap unchanged). Re-read
      // first: another actor may have resumed and re-paused with a LATER
      // resume_at while we slept — never resume a pause before it is due.
      const current = await getRun(this.deps.db.kysely, runId);
      if (current.status !== "paused" || !providerWait(current)) break;
      if (current.resume_at !== null && new Date(current.resume_at) > new Date()) {
        run = current;
        continue; // recompute the wait against the fresh resume_at
      }
      assertRunTransition("paused", "running");
      await setRunStatus(this.deps.db.kysely, runId, "running", { pauseReason: null, resumeAt: null });
      run = await executeRun(this.deps, runId);
    }
    return run;
  }
}
