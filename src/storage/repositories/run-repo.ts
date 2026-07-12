import { randomUUID } from "node:crypto";
import type { Kysely, Selectable } from "kysely";

import { AppError } from "../../shared/errors.js";
import type {
  ApprovalEntry,
  AttemptClassification,
  AttemptCostEntry,
  Database,
  DedupeStatus,
  EnrichmentProfile,
  PauseReason,
  ReviewStatus,
  RunItemsTable,
  RunItemStepsTable,
  RunsTable,
  RunStatus,
  SkipReason,
  StepStatus,
} from "../database-types.js";
import { num, round4 } from "../database-types.js";
import { assertBoundedJson, toJson } from "./repo-util.js";

export type RunRow = Selectable<RunsTable>;
export type RunItemRow = Selectable<RunItemsTable>;
export type RunItemStepRow = Selectable<RunItemStepsTable>;

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

export async function createRun(
  db: Kysely<Database>,
  input: {
    agencyId: string;
    workflowVersionId: string;
    inputs: Record<string, unknown>;
    profile: EnrichmentProfile;
    overrides: Record<string, unknown>;
    resolvedPlan: Record<string, unknown>;
    planHash: string;
    paidRecordCap: number;
    creditLimit: number;
    approval: ApprovalEntry;
  },
): Promise<RunRow> {
  return await db
    .insertInto("runs")
    .values({
      agency_id: input.agencyId,
      workflow_version_id: input.workflowVersionId,
      inputs: toJson(input.inputs),
      enrichment_profile: input.profile,
      overrides: toJson(input.overrides),
      resolved_plan: toJson(input.resolvedPlan),
      plan_hash: input.planHash,
      paid_record_cap: input.paidRecordCap,
      credit_limit: input.creditLimit,
      approvals: toJson([input.approval]),
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

export async function getRun(db: Kysely<Database>, runId: string): Promise<RunRow> {
  const row = await db.selectFrom("runs").selectAll().where("id", "=", runId).executeTakeFirst();
  if (!row) throw new AppError("NOT_FOUND", `Run ${runId} not found.`, { runId });
  return row;
}

export async function listRuns(db: Kysely<Database>, agencyId: string, limit = 50): Promise<RunRow[]> {
  return await db
    .selectFrom("runs")
    .selectAll()
    .where("agency_id", "=", agencyId)
    .orderBy("created_at", "desc")
    .limit(limit)
    .execute();
}

/**
 * Single-driver invariant: claiming a run is one atomic conditional UPDATE.
 * A crashed process leaves a stale lease that a later claim (same statement,
 * expired lease) reclaims. Returns the lease token or null if the claim lost.
 */
export async function claimRunLease(
  db: Kysely<Database>,
  runId: string,
  opts: { ttlSeconds: number; fromStatuses: RunStatus[] },
): Promise<string | null> {
  const token = randomUUID();
  const expires = new Date(Date.now() + opts.ttlSeconds * 1000);
  const updated = await db
    .updateTable("runs")
    .set({ lease_token: token, lease_expires_at: expires, updated_at: new Date() })
    .where("id", "=", runId)
    .where("status", "in", opts.fromStatuses)
    .where((eb) =>
      eb.or([eb("lease_token", "is", null), eb("lease_expires_at", "<", new Date())]),
    )
    .returning("id")
    .executeTakeFirst();
  return updated ? token : null;
}

export async function renewRunLease(
  db: Kysely<Database>,
  runId: string,
  token: string,
  ttlSeconds: number,
): Promise<boolean> {
  const updated = await db
    .updateTable("runs")
    .set({ lease_expires_at: new Date(Date.now() + ttlSeconds * 1000) })
    .where("id", "=", runId)
    .where("lease_token", "=", token)
    .returning("id")
    .executeTakeFirst();
  return updated !== undefined;
}

export async function releaseRunLease(db: Kysely<Database>, runId: string, token: string): Promise<void> {
  await db
    .updateTable("runs")
    .set({ lease_token: null, lease_expires_at: null })
    .where("id", "=", runId)
    .where("lease_token", "=", token)
    .execute();
}

export async function setRunStatus(
  db: Kysely<Database>,
  runId: string,
  status: RunStatus,
  extra: {
    pauseReason?: PauseReason | null;
    startedAt?: Date;
    completedAt?: Date;
    lastError?: Record<string, unknown> | null;
  } = {},
): Promise<void> {
  await db
    .updateTable("runs")
    .set({
      status,
      updated_at: new Date(),
      ...(extra.pauseReason !== undefined ? { pause_reason: extra.pauseReason } : {}),
      ...(extra.startedAt ? { started_at: extra.startedAt } : {}),
      ...(extra.completedAt ? { completed_at: extra.completedAt } : {}),
      ...(extra.lastError !== undefined ? { last_error: extra.lastError === null ? null : toJson(extra.lastError) } : {}),
    })
    .where("id", "=", runId)
    .execute();
}

export async function requestCancel(db: Kysely<Database>, runId: string): Promise<void> {
  await db.updateTable("runs").set({ cancel_requested: true, updated_at: new Date() }).where("id", "=", runId).execute();
}

/** Approvals are append-only; entries are never overwritten (schema doc §6). */
export async function appendApproval(
  db: Kysely<Database>,
  runId: string,
  approval: ApprovalEntry,
  scope: { planHash: string; paidRecordCap: number; creditLimit: number; profile: EnrichmentProfile; overrides: Record<string, unknown>; resolvedPlan: Record<string, unknown> },
): Promise<void> {
  const run = await getRun(db, runId);
  const approvals = [...run.approvals, approval];
  await db
    .updateTable("runs")
    .set({
      approvals: toJson(approvals),
      plan_hash: scope.planHash,
      paid_record_cap: scope.paidRecordCap,
      credit_limit: scope.creditLimit,
      enrichment_profile: scope.profile,
      overrides: toJson(scope.overrides),
      resolved_plan: toJson(scope.resolvedPlan),
      updated_at: new Date(),
    })
    .where("id", "=", runId)
    .execute();
}

export function latestApproval(run: RunRow): ApprovalEntry | undefined {
  return run.approvals[run.approvals.length - 1];
}

/** Run-scoped step markers (bounded jsonb) used to recompute resume position. */
export async function setStepProgress(
  db: Kysely<Database>,
  runId: string,
  stepId: string,
  marker: string,
): Promise<void> {
  const run = await getRun(db, runId);
  const progress = { ...run.step_progress, [stepId]: marker };
  await db
    .updateTable("runs")
    .set({ step_progress: assertBoundedJson(progress, "runs.step_progress"), updated_at: new Date() })
    .where("id", "=", runId)
    .execute();
}

export async function passReviewGate(db: Kysely<Database>, runId: string, actor: string): Promise<void> {
  await db
    .updateTable("runs")
    .set({ review_gate_passed_at: new Date(), review_gate_actor: actor, updated_at: new Date() })
    .where("id", "=", runId)
    .execute();
}

export async function bumpRunCredits(db: Kysely<Database>, runId: string, cost: number): Promise<void> {
  if (cost === 0) return;
  const run = await getRun(db, runId);
  await db
    .updateTable("runs")
    .set({ credits_used: round4(num(run.credits_used) + cost), updated_at: new Date() })
    .where("id", "=", runId)
    .execute();
}

// ---------------------------------------------------------------------------
// Run items
// ---------------------------------------------------------------------------

/**
 * Insert sourced records. `position` comes from a per-run monotonic counter
 * inside this transaction (never provider ordinal); UNIQUE (run_id, source_key)
 * makes a replayed source step upsert instead of duplicate.
 */
export async function insertRunItems(
  db: Kysely<Database>,
  runId: string,
  records: { sourceKey: string; snapshot: Record<string, unknown> }[],
): Promise<{ inserted: number }> {
  let inserted = 0;
  await db.transaction().execute(async (trx) => {
    const maxRow = await trx
      .selectFrom("run_items")
      .where("run_id", "=", runId)
      .select(({ fn }) => fn.max("position").as("max_position"))
      .executeTakeFirst();
    let position = maxRow?.max_position ?? 0;
    for (const record of records) {
      const row = await trx
        .insertInto("run_items")
        .values({
          run_id: runId,
          source_key: record.sourceKey,
          position: position + 1,
          snapshot: assertBoundedJson(record.snapshot, "run_items.snapshot"),
        })
        .onConflict((oc) => oc.columns(["run_id", "source_key"]).doNothing())
        .returning("id")
        .executeTakeFirst();
      if (row) {
        position += 1;
        inserted += 1;
      }
    }
  });
  return { inserted };
}

export async function listRunItems(
  db: Kysely<Database>,
  runId: string,
  filter: { statuses?: RunItemsTable["status"][] extends never ? never : ("pending" | "in_progress" | "completed" | "failed" | "skipped")[]; reviewStatuses?: ReviewStatus[] } = {},
): Promise<RunItemRow[]> {
  let query = db.selectFrom("run_items").selectAll().where("run_id", "=", runId);
  if (filter.statuses && filter.statuses.length > 0) query = query.where("status", "in", filter.statuses);
  if (filter.reviewStatuses && filter.reviewStatuses.length > 0)
    query = query.where("review_status", "in", filter.reviewStatuses);
  return await query.orderBy("position").orderBy("id").execute();
}

export async function getRunItem(db: Kysely<Database>, runItemId: string): Promise<RunItemRow> {
  const row = await db.selectFrom("run_items").selectAll().where("id", "=", runItemId).executeTakeFirst();
  if (!row) throw new AppError("NOT_FOUND", `Run item ${runItemId} not found.`, { runItemId });
  return row;
}

export async function updateRunItem(
  db: Kysely<Database>,
  runItemId: string,
  patch: {
    status?: "pending" | "in_progress" | "completed" | "failed" | "skipped";
    skipReason?: SkipReason | null;
    dedupeStatus?: DedupeStatus | null;
    leadId?: string | null;
    currentStepId?: string | null;
    score?: number | null;
    snapshot?: Record<string, unknown>;
    lastError?: Record<string, unknown> | null;
  },
): Promise<void> {
  await db
    .updateTable("run_items")
    .set({
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.skipReason !== undefined ? { skip_reason: patch.skipReason } : {}),
      ...(patch.dedupeStatus !== undefined ? { dedupe_status: patch.dedupeStatus } : {}),
      ...(patch.leadId !== undefined ? { lead_id: patch.leadId } : {}),
      ...(patch.currentStepId !== undefined ? { current_step_id: patch.currentStepId } : {}),
      ...(patch.score !== undefined ? { score: patch.score } : {}),
      ...(patch.snapshot !== undefined ? { snapshot: assertBoundedJson(patch.snapshot, "run_items.snapshot") } : {}),
      ...(patch.lastError !== undefined
        ? { last_error: patch.lastError === null ? null : toJson(patch.lastError) }
        : {}),
      updated_at: new Date(),
    })
    .where("id", "=", runItemId)
    .execute();
}

/**
 * "Duplicate → attach the existing lead to the new run" is an idempotent
 * upsert: the partial unique (run_id, lead_id) means a retried dedupe step
 * cannot attach the same lead twice — the second attach becomes skipped.
 */
export async function attachLead(
  db: Kysely<Database>,
  runItemId: string,
  runId: string,
  leadId: string,
  dedupeStatus: DedupeStatus,
): Promise<{ attached: boolean }> {
  const already = await db
    .selectFrom("run_items")
    .select("id")
    .where("run_id", "=", runId)
    .where("lead_id", "=", leadId)
    .where("id", "!=", runItemId)
    .executeTakeFirst();
  if (already) return { attached: false };
  await updateRunItem(db, runItemId, { leadId, dedupeStatus });
  return { attached: true };
}

export async function reviewRunItems(
  db: Kysely<Database>,
  runId: string,
  itemIds: string[] | "all",
  reviewStatus: ReviewStatus,
  actor: string,
): Promise<number> {
  let query = db
    .updateTable("run_items")
    .set({ review_status: reviewStatus, reviewed_at: new Date(), review_actor: actor, updated_at: new Date() })
    .where("run_id", "=", runId)
    .where("status", "!=", "skipped");
  if (itemIds !== "all") query = query.where("id", "in", itemIds);
  const result = await query.returning("id").execute();
  return result.length;
}

// ---------------------------------------------------------------------------
// Run item steps (the execution ledger)
// ---------------------------------------------------------------------------

export function requestKeyFor(runId: string, stepId: string, runItemId: string, attempt: number): string {
  return `${runId}:${stepId}:${runItemId}:${attempt}`;
}

/** Ensure the (item, step) ledger row exists WITHOUT claiming it (used for skip paths). */
export async function ensureStepRow(
  db: Kysely<Database>,
  runId: string,
  runItemId: string,
  stepId: string,
): Promise<RunItemStepRow> {
  await db
    .insertInto("run_item_steps")
    .values({ run_item_id: runItemId, step_id: stepId, request_key: requestKeyFor(runId, stepId, runItemId, 1) })
    .onConflict((oc) => oc.columns(["run_item_id", "step_id"]).doNothing())
    .execute();
  return await db
    .selectFrom("run_item_steps")
    .selectAll()
    .where("run_item_id", "=", runItemId)
    .where("step_id", "=", stepId)
    .executeTakeFirstOrThrow();
}

export type StepClaim =
  | { kind: "execute"; step: RunItemStepRow; requestKey: string; attempt: number; crashReplay: boolean }
  | { kind: "already_done"; step: RunItemStepRow }
  | { kind: "exhausted"; step: RunItemStepRow }
  | { kind: "needs_review"; step: RunItemStepRow };

/**
 * Claim one (item, step) ledger row. INSERT ... ON CONFLICT DO NOTHING creates
 * the row once; retries mutate it, never fork it.
 * - pending/failed (attempts < max): normal claim — attempts+1 and a fresh
 *   attempt-scoped request_key (an explicit requeue therefore rotates the key).
 * - running: crash replay — the stored request_key is reused so the same
 *   attempt dedupes at the provider; attempts are NOT incremented.
 * - completed/skipped: already done (resume marker).
 * - needs_review: deliberately not claimable (never auto-retried).
 */
export async function claimStep(
  db: Kysely<Database>,
  runId: string,
  runItemId: string,
  stepId: string,
  maxAttempts: number,
): Promise<StepClaim> {
  await db
    .insertInto("run_item_steps")
    .values({
      run_item_id: runItemId,
      step_id: stepId,
      request_key: requestKeyFor(runId, stepId, runItemId, 1),
    })
    .onConflict((oc) => oc.columns(["run_item_id", "step_id"]).doNothing())
    .execute();

  const step = await db
    .selectFrom("run_item_steps")
    .selectAll()
    .where("run_item_id", "=", runItemId)
    .where("step_id", "=", stepId)
    .executeTakeFirstOrThrow();

  if (step.status === "completed" || step.status === "skipped") return { kind: "already_done", step };
  if (step.status === "needs_review") return { kind: "needs_review", step };
  if (step.status === "running") {
    // Crash replay under a reclaimed run lease: reuse the stored request_key.
    return { kind: "execute", step, requestKey: step.request_key, attempt: step.attempts, crashReplay: true };
  }
  if (step.attempts >= maxAttempts) return { kind: "exhausted", step };

  const attempt = step.attempts + 1;
  const requestKey = requestKeyFor(runId, stepId, runItemId, attempt);
  const updated = await db
    .updateTable("run_item_steps")
    .set({
      status: "running",
      attempts: attempt,
      request_key: requestKey,
      started_at: step.started_at ?? new Date(),
      updated_at: new Date(),
    })
    .where("id", "=", step.id)
    .where("status", "=", step.status)
    .where("attempts", "=", step.attempts)
    .returningAll()
    .executeTakeFirst();
  if (!updated) throw new AppError("CONFLICT", "Step claim lost a concurrent update; run lease invariant violated.", { stepId, runItemId });
  return { kind: "execute", step: updated, requestKey, attempt, crashReplay: false };
}

/**
 * Finalize an attempt: status transition + append-only attempt_costs entry +
 * cost accumulation on completed, failed AND needs_review transitions
 * (charged-but-failed and ambiguous attempts count against the budget).
 * Callers run this inside the same transaction as domain effects.
 */
export async function finalizeStepAttempt(
  db: Kysely<Database>,
  stepRowId: string,
  outcome: {
    status: Extract<StepStatus, "completed" | "failed" | "needs_review">;
    attempt: number;
    requestKey: string;
    providerRequestId?: string | null;
    cost: number;
    classification: AttemptClassification;
    outcomeNote: string;
    result?: Record<string, unknown>;
    lastError?: Record<string, unknown> | null;
    at?: Date;
  },
): Promise<void> {
  const step = await db
    .selectFrom("run_item_steps")
    .selectAll()
    .where("id", "=", stepRowId)
    .executeTakeFirstOrThrow();
  const entry: AttemptCostEntry = {
    attempt: outcome.attempt,
    requestKey: outcome.requestKey,
    providerRequestId: outcome.providerRequestId ?? null,
    cost: outcome.cost,
    at: (outcome.at ?? new Date()).toISOString(),
    outcome: outcome.outcomeNote,
    classification: outcome.classification,
    reconciledAt: null,
  };
  await db
    .updateTable("run_item_steps")
    .set({
      status: outcome.status,
      cost_units: round4(num(step.cost_units) + outcome.cost),
      attempt_costs: toJson([...step.attempt_costs, entry]),
      ...(outcome.result !== undefined ? { result: assertBoundedJson(outcome.result, "run_item_steps.result") } : {}),
      ...(outcome.lastError !== undefined
        ? { last_error: outcome.lastError === null ? null : toJson(outcome.lastError) }
        : {}),
      ...(outcome.status === "completed" ? { completed_at: new Date() } : {}),
      updated_at: new Date(),
    })
    .where("id", "=", stepRowId)
    .execute();
}

/** Mark a step skipped (e.g. model_provider_not_configured, paid_record_cap_reached). */
export async function skipStep(
  db: Kysely<Database>,
  stepRowId: string,
  skipReason: string,
  result: Record<string, unknown> = {},
): Promise<void> {
  await db
    .updateTable("run_item_steps")
    .set({
      status: "skipped",
      skip_reason: skipReason,
      result: assertBoundedJson(result, "run_item_steps.result"),
      completed_at: new Date(),
      updated_at: new Date(),
    })
    .where("id", "=", stepRowId)
    .execute();
}

/**
 * Reconciliation is the single permitted amendment to the otherwise
 * append-only attempt_costs ledger: fill the ambiguous entry's classification
 * and reconciledAt, then complete the step or requeue it failed→pending (the
 * next claim rotates request_key).
 */
export async function reconcileStep(
  db: Kysely<Database>,
  stepRowId: string,
  resolution: {
    classification: Extract<AttemptClassification, "completed" | "failed_charged" | "failed_uncharged">;
    actualCost?: number;
    then: "complete" | "requeue";
    result?: Record<string, unknown>;
  },
): Promise<void> {
  const step = await db
    .selectFrom("run_item_steps")
    .selectAll()
    .where("id", "=", stepRowId)
    .executeTakeFirstOrThrow();
  if (step.status !== "needs_review") {
    throw new AppError("CONFLICT", `Step ${stepRowId} is '${step.status}', not 'needs_review'; nothing to reconcile.`, { stepRowId });
  }
  const costs = [...step.attempt_costs];
  const ambiguousIdx = costs.findLastIndex((c) => c.classification === "ambiguous");
  if (ambiguousIdx < 0) throw new AppError("CONFLICT", "No ambiguous attempt entry to reconcile.", { stepRowId });
  const ambiguous = costs[ambiguousIdx];
  if (!ambiguous) throw new AppError("INTERNAL", "Ambiguous attempt entry disappeared.", { stepRowId });
  const provisional = ambiguous.cost;
  const actual = resolution.actualCost ?? provisional;
  costs[ambiguousIdx] = {
    ...ambiguous,
    cost: actual,
    classification: resolution.classification,
    reconciledAt: new Date().toISOString(),
  };
  await db
    .updateTable("run_item_steps")
    .set({
      attempt_costs: toJson(costs),
      cost_units: round4(num(step.cost_units) - provisional + actual),
      status: resolution.then === "complete" ? "completed" : "failed",
      ...(resolution.then === "complete" ? { completed_at: new Date() } : {}),
      ...(resolution.result !== undefined
        ? { result: assertBoundedJson(resolution.result, "run_item_steps.result") }
        : {}),
      updated_at: new Date(),
    })
    .where("id", "=", stepRowId)
    .execute();
}

/** Requeue failed steps for `run retry`. needs_review steps are deliberately excluded. */
export async function requeueFailedSteps(db: Kysely<Database>, runId: string): Promise<number> {
  const failed = await db
    .selectFrom("run_item_steps")
    .innerJoin("run_items", "run_items.id", "run_item_steps.run_item_id")
    .select(["run_item_steps.id as step_row_id", "run_items.id as item_id"])
    .where("run_items.run_id", "=", runId)
    .where("run_item_steps.status", "=", "failed")
    .execute();
  if (failed.length === 0) return 0;
  await db
    .updateTable("run_item_steps")
    .set({ status: "pending", attempts: 0, last_error: null, updated_at: new Date() })
    .where(
      "id",
      "in",
      failed.map((f) => f.step_row_id),
    )
    .execute();
  await db
    .updateTable("run_items")
    .set({ status: "in_progress", last_error: null, updated_at: new Date() })
    .where(
      "id",
      "in",
      failed.map((f) => f.item_id),
    )
    .where("status", "=", "failed")
    .execute();
  return failed.length;
}

export async function listSteps(db: Kysely<Database>, runItemId: string): Promise<RunItemStepRow[]> {
  return await db
    .selectFrom("run_item_steps")
    .selectAll()
    .where("run_item_id", "=", runItemId)
    .orderBy("created_at")
    .execute();
}

export async function listStepsForRun(db: Kysely<Database>, runId: string): Promise<RunItemStepRow[]> {
  return await db
    .selectFrom("run_item_steps")
    .selectAll()
    .where(
      "run_item_id",
      "in",
      db.selectFrom("run_items").select("id").where("run_id", "=", runId),
    )
    .execute();
}

/** Reconcilable invariant (tested): runs.credits_used === SUM(run_item_steps.cost_units). */
export async function sumStepCosts(db: Kysely<Database>, runId: string): Promise<number> {
  const rows = await listStepsForRun(db, runId);
  return round4(rows.reduce((acc, r) => acc + num(r.cost_units), 0));
}
