import type { Kysely, Selectable } from "kysely";

import { AppError } from "../../shared/errors.js";
import type { Database, RunSourceRequestsTable, SourceRequestStatus } from "../database-types.js";
import { num, round4 } from "../database-types.js";
import { toJson } from "./repo-util.js";

export type RunSourceRequestRow = Selectable<RunSourceRequestsTable>;

/**
 * Durable per-request ledger for a PAID, MULTI-REQUEST source step. This is the
 * run-scope analogue of the run_item_steps ledger in run-repo.ts: one row per
 * planned search, claimed and finalized so a crash / 429 / credit pause resumes
 * without re-paying for a completed search.
 */

export interface SourceRequestPlan {
  index: number;
  descriptor: string;
}

export function sourceRequestKeyFor(runId: string, stepId: string, index: number, attempt: number): string {
  return `${runId}:${stepId}:src:${index}:${attempt}`;
}

/** Idempotently create the ledger rows for a step's planned requests (UNIQUE (run_id, step_id, request_index)). */
export async function ensureSourceRequests(
  db: Kysely<Database>,
  runId: string,
  stepId: string,
  plans: SourceRequestPlan[],
): Promise<void> {
  if (plans.length === 0) return;
  await db
    .insertInto("run_source_requests")
    .values(
      plans.map((p) => ({
        run_id: runId,
        step_id: stepId,
        request_index: p.index,
        descriptor: p.descriptor,
        request_key: sourceRequestKeyFor(runId, stepId, p.index, 1),
      })),
    )
    .onConflict((oc) => oc.columns(["run_id", "step_id", "request_index"]).doNothing())
    .execute();
}

export async function listSourceRequests(db: Kysely<Database>, runId: string): Promise<RunSourceRequestRow[]> {
  return await db
    .selectFrom("run_source_requests")
    .selectAll()
    .where("run_id", "=", runId)
    .orderBy("step_id")
    .orderBy("request_index")
    .execute();
}

export async function listSourceRequestsForStep(
  db: Kysely<Database>,
  runId: string,
  stepId: string,
): Promise<RunSourceRequestRow[]> {
  return await db
    .selectFrom("run_source_requests")
    .selectAll()
    .where("run_id", "=", runId)
    .where("step_id", "=", stepId)
    .orderBy("request_index")
    .execute();
}

export type SourceRequestClaim =
  | { kind: "execute"; row: RunSourceRequestRow; requestKey: string; attempt: number; crashReplay: boolean }
  | { kind: "already_done"; row: RunSourceRequestRow }
  | { kind: "exhausted"; row: RunSourceRequestRow }
  | { kind: "needs_review"; row: RunSourceRequestRow };

/**
 * Claim one source-request row (mirrors claimStep in run-repo.ts):
 * - pending/failed (attempts < max): claim — attempts+1 and a fresh key.
 * - running: crash replay — reuse the stored key, attempts unchanged.
 * - completed: already done (resume marker).
 * - needs_review: not claimable (never auto-retried).
 */
export async function claimSourceRequest(
  db: Kysely<Database>,
  runId: string,
  stepId: string,
  requestIndex: number,
  maxAttempts: number,
): Promise<SourceRequestClaim> {
  const row = await db
    .selectFrom("run_source_requests")
    .selectAll()
    .where("run_id", "=", runId)
    .where("step_id", "=", stepId)
    .where("request_index", "=", requestIndex)
    .executeTakeFirstOrThrow();

  if (row.status === "completed") return { kind: "already_done", row };
  if (row.status === "needs_review") return { kind: "needs_review", row };
  if (row.status === "running") {
    return { kind: "execute", row, requestKey: row.request_key, attempt: row.attempts, crashReplay: true };
  }
  if (row.attempts >= maxAttempts) return { kind: "exhausted", row };

  const attempt = row.attempts + 1;
  const requestKey = sourceRequestKeyFor(runId, stepId, requestIndex, attempt);
  const updated = await db
    .updateTable("run_source_requests")
    .set({ status: "running", attempts: attempt, request_key: requestKey, updated_at: new Date() })
    .where("id", "=", row.id)
    .where("status", "=", row.status)
    .where("attempts", "=", row.attempts)
    .returningAll()
    .executeTakeFirst();
  if (!updated) {
    throw new AppError("CONFLICT", "Source-request claim lost a concurrent update; run lease invariant violated.", {
      runId,
      stepId,
      requestIndex,
    });
  }
  return { kind: "execute", row: updated, requestKey, attempt, crashReplay: false };
}

/**
 * Finalize a source-request attempt. Accumulates cost_units (the caller bumps
 * run credits by the same amount in the same transaction, exactly like
 * finalizeStepAttempt). Does not itself touch runs.
 */
export async function finalizeSourceRequest(
  db: Kysely<Database>,
  requestRowId: string,
  outcome: {
    status: Extract<SourceRequestStatus, "completed" | "failed" | "needs_review">;
    cost: number;
    providerRequestId?: string | null;
    recordsInserted?: number | null;
    coverageNote?: string | null;
    lastError?: Record<string, unknown> | null;
  },
): Promise<void> {
  const row = await db
    .selectFrom("run_source_requests")
    .select(["cost_units"])
    .where("id", "=", requestRowId)
    .executeTakeFirstOrThrow();
  await db
    .updateTable("run_source_requests")
    .set({
      status: outcome.status,
      cost_units: round4(num(row.cost_units) + outcome.cost),
      ...(outcome.providerRequestId !== undefined ? { provider_request_id: outcome.providerRequestId } : {}),
      ...(outcome.recordsInserted !== undefined ? { records_inserted: outcome.recordsInserted } : {}),
      ...(outcome.coverageNote !== undefined ? { coverage_note: outcome.coverageNote } : {}),
      ...(outcome.lastError !== undefined
        ? { last_error: outcome.lastError === null ? null : toJson(outcome.lastError) }
        : {}),
      updated_at: new Date(),
    })
    .where("id", "=", requestRowId)
    .execute();
}

/**
 * Return a rate-limited request to `pending` WITHOUT counting the attempt — a
 * 429 is a provider refusal, not a failed attempt. Books no cost.
 */
export async function deferSourceRequestForRateLimit(
  db: Kysely<Database>,
  requestRowId: string,
  attempt: number,
): Promise<void> {
  await db
    .updateTable("run_source_requests")
    .set({ status: "pending", attempts: Math.max(0, attempt - 1), updated_at: new Date() })
    .where("id", "=", requestRowId)
    .execute();
}

/**
 * Requeue FAILED source requests for `run retry` (mirrors requeueFailedSteps):
 * back to pending with attempts reset so the next claim starts fresh with a
 * rotated key. completed and needs_review rows are deliberately untouched —
 * retrying a zero-cost failed search cannot double-spend, but a possibly-paid
 * ambiguous one is never auto-retried. Returns the affected step ids so the
 * caller can re-open their step_progress markers.
 */
export async function requeueFailedSourceRequests(
  db: Kysely<Database>,
  runId: string,
): Promise<{ requeued: number; stepIds: string[] }> {
  const failed = await db
    .selectFrom("run_source_requests")
    .select(["id", "step_id"])
    .where("run_id", "=", runId)
    .where("status", "=", "failed")
    .execute();
  if (failed.length === 0) return { requeued: 0, stepIds: [] };
  await db
    .updateTable("run_source_requests")
    .set({ status: "pending", attempts: 0, last_error: null, updated_at: new Date() })
    .where(
      "id",
      "in",
      failed.map((f) => f.id),
    )
    .execute();
  return { requeued: failed.length, stepIds: [...new Set(failed.map((f) => f.step_id))] };
}

/** Component of the credits invariant: SUM(run_source_requests.cost_units) for a run. */
export async function sumSourceRequestCosts(db: Kysely<Database>, runId: string): Promise<number> {
  const rows = await db
    .selectFrom("run_source_requests")
    .select(["cost_units"])
    .where("run_id", "=", runId)
    .execute();
  return round4(rows.reduce((acc, r) => acc + num(r.cost_units), 0));
}
