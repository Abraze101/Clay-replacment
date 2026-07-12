import { canonicalJson } from "../../shared/checksum.js";
import { AmbiguousOutcomeError, AppError, RetryableProviderError } from "../../shared/errors.js";
import type { Db } from "../../storage/db.js";
import { num, round4 } from "../../storage/database-types.js";
import type { RunItemRow, RunRow } from "../../storage/repositories/run-repo.js";
import {
  bumpRunCredits,
  claimRunLease,
  claimStep,
  ensureStepRow,
  finalizeStepAttempt,
  getRun,
  getRunItem,
  insertRunItems,
  latestApproval,
  listRunItems,
  listSteps,
  releaseRunLease,
  renewRunLease,
  setRunStatus,
  setStepProgress,
  skipStep,
  updateRunItem,
} from "../../storage/repositories/run-repo.js";
import { getVersion } from "../../storage/repositories/workflow-repo.js";
import type { ProviderRegistry } from "../../providers/types.js";
import { exportRun } from "../export/export-run.js";
import type { ResolvedPlan } from "../workflow-schema/plan.js";
import type { WorkflowStep } from "../workflow-schema/steps.js";
import type { WorkflowDefinition } from "../workflow-schema/workflow.js";
import { parseWorkflowDefinition } from "../workflow-schema/workflow.js";
import type { ExecOutcome } from "./executors.js";
import { executeDedupe, executeEnrich, executeFilter, executeNormalize, executeResearch, executeScore } from "./executors.js";
import { assertItemTransition, assertRunTransition } from "./states.js";

export interface RunnerHooks {
  /** Test fault-injection point: called after the provider call, before the finalize transaction commits. */
  beforeFinalize?: (info: { stepId: string; sourceKey: string; attempt: number }) => void;
}

export interface RunnerDeps {
  db: Db;
  providers: ProviderRegistry;
  leaseTtlSeconds: number;
  maxStepAttempts: number;
  exportDir: string;
  actor: string;
  hooks?: RunnerHooks;
}

type StepSignal = "completed" | "waiting_review" | "paused" | "cancelled";
type ItemSignal = "ok" | "failed" | "needs_review" | "skipped_item";

/**
 * Drive one run to its next durable boundary (waiting_review, paused,
 * cancelled, or completed) under an exclusive run lease. Everything it needs
 * to resume is persisted: step_progress markers, run_item_steps ledger rows,
 * and item snapshots — a killed process resumes exactly where it stopped.
 */
export async function executeRun(deps: RunnerDeps, runId: string): Promise<RunRow> {
  const kysely = deps.db.kysely;
  let run = await getRun(kysely, runId);
  if (run.status === "cancelled" || run.status === "completed" || run.status === "failed") return run;
  verifyApprovalScope(run);

  const token = await claimRunLease(kysely, runId, {
    ttlSeconds: deps.leaseTtlSeconds,
    fromStatuses: ["pending", "running"],
  });
  if (!token) {
    throw new AppError("LEASE_HELD", `Run ${runId} is leased by another driver; use 'run resume' after the lease expires.`, { runId });
  }

  try {
    if (run.status === "pending") assertRunTransition("pending", "running");
    await setRunStatus(kysely, runId, "running", run.started_at ? {} : { startedAt: new Date() });

    const version = await getVersion(kysely, run.workflow_version_id);
    const definition = parseWorkflowDefinition(version.definition);
    const plan = run.resolved_plan as unknown as ResolvedPlan;

    const signal = await runSteps(deps, runId, definition, plan, token);
    if (signal === "completed") {
      await finalizeItems(deps, runId);
      assertRunTransition("running", "completed");
      await setRunStatus(kysely, runId, "completed", { completedAt: new Date() });
    }
    run = await getRun(kysely, runId);
    return run;
  } finally {
    await releaseRunLease(kysely, runId, token);
  }
}

function verifyApprovalScope(run: RunRow): void {
  const approval = latestApproval(run);
  if (!approval) {
    throw new AppError("APPROVAL_REQUIRED", "Run has no approval entry; start runs through run_preview -> run start --approval.", { runId: run.id });
  }
  const mismatch =
    approval.planHash !== run.plan_hash ||
    approval.profile !== run.enrichment_profile ||
    approval.paidRecordCap !== run.paid_record_cap ||
    round4(approval.creditLimit) !== round4(num(run.credit_limit)) ||
    canonicalJson(approval.overrides) !== canonicalJson(run.overrides);
  if (mismatch) {
    throw new AppError(
      "APPROVAL_MISMATCH",
      "The latest approval does not match the run's plan hash, profile, overrides, record cap, or budget. Preview again and re-approve.",
      { runId: run.id },
    );
  }
}

async function runSteps(
  deps: RunnerDeps,
  runId: string,
  definition: WorkflowDefinition,
  plan: ResolvedPlan,
  leaseToken: string,
): Promise<StepSignal> {
  const kysely = deps.db.kysely;

  for (const planStep of plan.steps) {
    if (!planStep.willRun) continue;

    const cancelled = await checkCancel(deps, runId);
    if (cancelled) return "cancelled";
    await renewRunLease(kysely, runId, leaseToken, deps.leaseTtlSeconds);

    const run = await getRun(kysely, runId);
    if (run.step_progress[planStep.id] === "completed") continue;

    const defStep = definition.steps.find((s) => s.id === planStep.id);
    if (!defStep) throw new AppError("INTERNAL", `Plan step '${planStep.id}' missing from definition.`, {});

    switch (defStep.type) {
      case "source": {
        const provider = deps.providers.sources.get(defStep.provider);
        if (!provider) throw new AppError("VALIDATION_FAILED", `Unregistered source provider '${defStep.provider}'.`, {});
        const inputs = plan.inputs;
        const { records, requestId } = await provider.search({
          businessType: inputs.businessType,
          locations: inputs.locations,
          limit: plan.sourceLimit,
        });
        await insertRunItems(
          kysely,
          runId,
          records.slice(0, plan.sourceLimit).map((r) => ({
            sourceKey: r.sourceKey,
            snapshot: {
              source: r,
              sourceRequestId: requestId,
              sourceRetrievedAt: new Date().toISOString(),
            },
          })),
        );
        await setStepProgress(kysely, runId, planStep.id, "completed");
        break;
      }

      case "review_gate": {
        if (run.review_gate_passed_at) {
          await setStepProgress(kysely, runId, planStep.id, "completed");
          break;
        }
        assertRunTransition("running", "waiting_review");
        await setRunStatus(kysely, runId, "waiting_review");
        return "waiting_review";
      }

      case "export": {
        // Terminal item statuses must be settled before selection, or the
        // in-run export would see items still in_progress and select nothing.
        await finalizeItems(deps, runId);
        await exportRun(deps.db, { runId, exportDir: deps.exportDir });
        await setStepProgress(kysely, runId, planStep.id, "completed");
        break;
      }

      default: {
        const signal = await runItemStep(deps, runId, defStep, planStep.paid, planStep.costPerRecord, leaseToken);
        if (signal !== "completed") return signal;
        await setStepProgress(kysely, runId, planStep.id, "completed");
      }
    }
  }
  return "completed";
}

async function runItemStep(
  deps: RunnerDeps,
  runId: string,
  defStep: WorkflowStep,
  paid: boolean,
  costPerRecord: number,
  leaseToken: string,
): Promise<StepSignal> {
  const kysely = deps.db.kysely;
  const all = await listRunItems(kysely, runId);
  const eligible = all.filter((i) => i.status === "pending" || i.status === "in_progress");
  const run0 = await getRun(kysely, runId);

  for (let index = 0; index < eligible.length; index += 1) {
    const itemRef = eligible[index];
    if (!itemRef) continue;

    const cancelled = await checkCancel(deps, runId);
    if (cancelled) return "cancelled";
    if (index % 10 === 0) await renewRunLease(kysely, runId, leaseToken, deps.leaseTtlSeconds);

    const item = await getRunItem(kysely, itemRef.id);
    if (item.status === "skipped" || item.status === "failed" || item.status === "completed") continue;

    // generate: consult the (empty in M0) model-provider registry.
    if (defStep.type === "generate") {
      if (deps.providers.models.size === 0) {
        await ensurePendingStepSkipped(deps, runId, item, defStep.id, "model_provider_not_configured");
        continue;
      }
      throw new AppError("INTERNAL", "Model providers are not wired until Milestone 5.", { stepId: defStep.id });
    }

    // Paid gates: record cap first, then the budget gate BEFORE any claim/spend.
    if (paid && index >= run0.paid_record_cap) {
      await ensurePendingStepSkipped(deps, runId, item, defStep.id, "paid_record_cap_reached");
      continue;
    }
    if (paid) {
      const run = await getRun(kysely, runId);
      if (round4(num(run.credits_used) + costPerRecord) > round4(num(run.credit_limit))) {
        // Stop BEFORE the next paid item; keep partial results.
        assertRunTransition("running", "paused");
        await setRunStatus(kysely, runId, "paused", { pauseReason: "credit_cap_reached" });
        return "paused";
      }
    }

    await processOneItemStep(deps, runId, defStep, item);
  }
  return "completed";
}

async function processOneItemStep(
  deps: RunnerDeps,
  runId: string,
  defStep: WorkflowStep,
  itemStart: RunItemRow,
): Promise<ItemSignal> {
  const kysely = deps.db.kysely;

  if (itemStart.status === "pending") {
    assertItemTransition("pending", "in_progress");
    await updateRunItem(kysely, itemStart.id, { status: "in_progress", currentStepId: defStep.id });
  } else {
    await updateRunItem(kysely, itemStart.id, { currentStepId: defStep.id });
  }

  for (;;) {
    const claim = await claimStep(kysely, runId, itemStart.id, defStep.id, deps.maxStepAttempts);
    if (claim.kind === "already_done") return "ok";
    if (claim.kind === "needs_review") return "needs_review";
    if (claim.kind === "exhausted") {
      assertItemTransition("in_progress", "failed");
      await updateRunItem(kysely, itemStart.id, {
        status: "failed",
        lastError: (claim.step.last_error) ?? { message: "step attempts exhausted" },
      });
      return "failed";
    }

    const item = await getRunItem(kysely, itemStart.id);
    const ctx = {
      providers: deps.providers,
      run: await getRun(kysely, runId),
      item,
      step: defStep,
      requestKey: claim.requestKey,
      agencyId: (await getRun(kysely, runId)).agency_id,
    };

    // Phase 1 — provider/deterministic execution. Errors here are ATTEMPT
    // failures: they finalize the attempt (with any charged cost) and feed the
    // bounded retry loop, or park the step in needs_review.
    let outcome: ExecOutcome;
    try {
      switch (defStep.type) {
        case "normalize":
          outcome = executeNormalize(ctx);
          break;
        case "dedupe":
          outcome = executeDedupe(ctx);
          break;
        case "filter":
          outcome = executeFilter(ctx);
          break;
        case "research":
          outcome = await executeResearch(ctx);
          break;
        case "enrich": {
          const provider = deps.providers.enrichers.get(defStep.provider);
          if (!provider) throw new AppError("INTERNAL", `Unregistered enrich provider '${defStep.provider}'.`, {});
          outcome = await executeEnrich(ctx, provider);
          break;
        }
        case "score":
          outcome = executeScore(ctx);
          break;
        default:
          throw new AppError("INTERNAL", `Step type '${defStep.type}' is not an item step.`, {});
      }
    } catch (err) {
      if (err instanceof AmbiguousOutcomeError) {
        // Possibly completed and possibly charged: book the provisional cost,
        // park in needs_review, and NEVER auto-retry (double-spend risk).
        await kysely.transaction().execute(async (trx) => {
          await finalizeStepAttempt(trx, claim.step.id, {
            status: "needs_review",
            attempt: claim.attempt,
            requestKey: claim.requestKey,
            providerRequestId: (err.details["providerRequestId"] as string | undefined) ?? null,
            cost: err.possibleCost,
            classification: "ambiguous",
            outcomeNote: "ambiguous_outcome",
            lastError: { code: err.code, message: err.message },
          });
          await bumpRunCredits(trx, runId, err.possibleCost);
        });
        return "needs_review";
      }

      const retryable = err instanceof RetryableProviderError;
      const charged = retryable && err.details["charged"] === true;
      const failedCost = charged ? ((err.details["cost"] as number | undefined) ?? 0) : 0;
      const message = err instanceof Error ? err.message : String(err);
      await kysely.transaction().execute(async (trx) => {
        await finalizeStepAttempt(trx, claim.step.id, {
          status: "failed",
          attempt: claim.attempt,
          requestKey: claim.requestKey,
          providerRequestId: retryable ? ((err.details["providerRequestId"] as string | undefined) ?? null) : null,
          cost: failedCost,
          classification: charged ? "failed_charged" : "failed_uncharged",
          outcomeNote: retryable ? "retryable_provider_error" : "step_error",
          lastError: { message, retryable },
        });
        await bumpRunCredits(trx, runId, failedCost);
      });
      // Bounded in-run retry: loop back to claim; exhaustion fails the item.
      continue;
    }

    // Phase 2 — finalize. The hook and the transaction sit OUTSIDE the
    // provider-error handling on purpose: a failure between the provider call
    // and the commit is a CRASH, not an attempt failure. It must propagate,
    // leaving the step 'running' so crash-resume replays the STORED
    // request_key and the provider's idempotency (not a retry) absorbs it.
    deps.hooks?.beforeFinalize?.({
      stepId: defStep.id,
      sourceKey: item.source_key,
      attempt: claim.attempt,
    });

    await kysely.transaction().execute(async (trx) => {
      if (outcome.commit) await outcome.commit(trx, claim.step.id);
      await finalizeStepAttempt(trx, claim.step.id, {
        status: "completed",
        attempt: claim.attempt,
        requestKey: claim.requestKey,
        providerRequestId: outcome.providerRequestId,
        cost: outcome.cost,
        classification: outcome.classification,
        outcomeNote: outcome.note,
        result: outcome.result,
      });
      await bumpRunCredits(trx, runId, outcome.cost);
    });

    const fresh = await getRunItem(kysely, itemStart.id);
    return fresh.status === "skipped" ? "skipped_item" : "ok";
  }
}

async function ensurePendingStepSkipped(
  deps: RunnerDeps,
  runId: string,
  item: RunItemRow,
  stepId: string,
  reason: string,
): Promise<void> {
  const kysely = deps.db.kysely;
  const row = await ensureStepRow(kysely, runId, item.id, stepId);
  if (row.status === "pending") await skipStep(kysely, row.id, reason);
}

async function checkCancel(deps: RunnerDeps, runId: string): Promise<boolean> {
  const run = await getRun(deps.db.kysely, runId);
  if (!run.cancel_requested || run.status === "cancelled") return run.status === "cancelled";
  assertRunTransition(run.status === "pending" ? "pending" : "running", "cancelled");
  await setRunStatus(deps.db.kysely, runId, "cancelled", { completedAt: new Date() });
  return true;
}

/**
 * Terminal item pass: an item is completed when every executed step is
 * completed/skipped; a failed step already failed it; a needs_review step
 * leaves it in_progress pending reconciliation (visible in status counts).
 */
async function finalizeItems(deps: RunnerDeps, runId: string): Promise<void> {
  const kysely = deps.db.kysely;
  const items = await listRunItems(kysely, runId);
  for (const item of items) {
    if (item.status === "skipped" || item.status === "failed" || item.status === "completed") continue;
    const steps = await listSteps(kysely, item.id);
    if (steps.some((s) => s.status === "needs_review" || s.status === "running" || s.status === "pending")) {
      continue; // pending reconciliation or interrupted work; never silently completed
    }
    if (item.status === "pending") {
      assertItemTransition("pending", "in_progress");
      await updateRunItem(kysely, item.id, { status: "in_progress" });
    }
    if (steps.some((s) => s.status === "failed")) {
      assertItemTransition("in_progress", "failed");
      await updateRunItem(kysely, item.id, { status: "failed" });
      continue;
    }
    assertItemTransition("in_progress", "completed");
    await updateRunItem(kysely, item.id, { status: "completed", currentStepId: null });
  }
}
