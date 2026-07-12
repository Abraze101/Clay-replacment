import { AppError } from "../../shared/errors.js";
import type { RunItemStatus, RunStatus, StepStatus } from "../../storage/database-types.js";

/**
 * Exhaustive state-transition maps. Every status write in the runner goes
 * through assertTransition; the matrices are tested exhaustively.
 */
export const RUN_TRANSITIONS: Record<RunStatus, readonly RunStatus[]> = {
  pending: ["running", "cancelled"],
  running: ["waiting_review", "paused", "completed", "failed", "cancelled"],
  waiting_review: ["running", "cancelled"],
  paused: ["running", "cancelled"],
  // completed → running is the explicit `run retry` path (requeued failed items).
  completed: ["running"],
  failed: ["running"],
  cancelled: [],
};

export const ITEM_TRANSITIONS: Record<RunItemStatus, readonly RunItemStatus[]> = {
  pending: ["in_progress", "skipped"],
  in_progress: ["completed", "failed", "skipped"],
  // failed → in_progress is the `run retry` requeue.
  failed: ["in_progress"],
  completed: [],
  skipped: [],
};

export const STEP_TRANSITIONS: Record<StepStatus, readonly StepStatus[]> = {
  pending: ["running", "skipped"],
  running: ["completed", "failed", "needs_review"],
  // failed → pending is an explicit requeue (rotates request_key); failed → running is the in-run bounded retry claim.
  failed: ["pending", "running"],
  // needs_review resolves ONLY through reconciliation (never auto-retried).
  needs_review: ["completed", "failed"],
  completed: [],
  skipped: [],
};

export function assertRunTransition(from: RunStatus, to: RunStatus): void {
  if (!RUN_TRANSITIONS[from].includes(to)) {
    throw new AppError("RUN_NOT_RUNNABLE", `Illegal run transition ${from} -> ${to}.`, { from, to });
  }
}

export function assertItemTransition(from: RunItemStatus, to: RunItemStatus): void {
  if (!ITEM_TRANSITIONS[from].includes(to)) {
    throw new AppError("INTERNAL", `Illegal run-item transition ${from} -> ${to}.`, { from, to });
  }
}

export function assertStepTransition(from: StepStatus, to: StepStatus): void {
  if (!STEP_TRANSITIONS[from].includes(to)) {
    throw new AppError("INTERNAL", `Illegal step transition ${from} -> ${to}.`, { from, to });
  }
}
