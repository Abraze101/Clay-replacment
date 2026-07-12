import type { RunnerDeps } from "../engine/runner/runner.js";
import { executeRun } from "../engine/runner/runner.js";
import type { RunRow } from "../storage/repositories/run-repo.js";

/**
 * The background-execution seam. M0 ships the in-process claim-and-drain
 * driver over the run lease + run_item_steps ledger; the pg-boss driver fills
 * this same interface at M1 if the M0 compatibility spike passes (see
 * docs/decisions.md ADR-002). The engine never imports a queue library
 * directly.
 */
export interface JobQueue {
  /** Execute (or continue) a run to its next durable boundary. */
  runToBoundary(runId: string): Promise<RunRow>;
}

export class InProcessRunWorker implements JobQueue {
  constructor(private readonly deps: RunnerDeps) {}

  async runToBoundary(runId: string): Promise<RunRow> {
    return await executeRun(this.deps, runId);
  }
}
