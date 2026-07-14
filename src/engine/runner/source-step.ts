import { AmbiguousOutcomeError, AppError, RateLimitError, RetryableProviderError } from "../../shared/errors.js";
import { num, round4 } from "../../storage/database-types.js";
import {
  bumpRunCredits,
  getRun,
  insertRunItems,
  renewRunLease,
  setRunStatus,
  setStepProgress,
} from "../../storage/repositories/run-repo.js";
import {
  claimSourceRequest,
  deferSourceRequestForRateLimit,
  ensureSourceRequests,
  finalizeSourceRequest,
  listSourceRequestsForStep,
} from "../../storage/repositories/source-request-repo.js";
import type { PagedPaidSource, SourceQuery, SourceRecord } from "../../providers/types.js";
import { isPagedPaidSource } from "../../providers/types.js";
import type { PlannedStep, ResolvedPlan } from "../workflow-schema/plan.js";
import type { SourceStep } from "../workflow-schema/steps.js";
import { assertRunTransition } from "./states.js";
import type { RunnerDeps } from "./runner.js";

export type SourceStepSignal = "completed" | "paused" | "cancelled" | "failed";

/**
 * Execute a `source` step. A free single-shot source (the fake providers, a
 * future free official API) takes the legacy path. A PAID, MULTI-REQUEST source
 * (SerpAPI Maps) is driven through the durable run_source_requests ledger so a
 * crash / 429 / credit pause never re-pays for a completed search.
 */
export async function executeSourceStep(
  deps: RunnerDeps,
  runId: string,
  planStep: PlannedStep,
  defStep: SourceStep,
  plan: ResolvedPlan,
  leaseToken: string,
): Promise<SourceStepSignal> {
  const kysely = deps.db.kysely;
  const provider = deps.providers.sources.get(defStep.provider);
  if (!provider) throw new AppError("VALIDATION_FAILED", `Unregistered source provider '${defStep.provider}'.`, {});

  const query: SourceQuery = {
    businessType: plan.inputs.businessType,
    locations: plan.inputs.locations,
    limit: plan.sourceLimit,
    personTitles: plan.inputs.personTitles,
    importRows: plan.inputs.importRows,
    ...(plan.inputs.continueFromRunId && plan.inputs.continuationLeadIds
      ? { continuation: { runId: plan.inputs.continueFromRunId, leadIds: plan.inputs.continuationLeadIds } }
      : {}),
  };

  if (!isPagedPaidSource(provider)) {
    // Legacy free single-search path (fake providers / free official APIs).
    const { records, requestId, coverageNote } = await provider.search(query);
    const capped = records.slice(0, plan.sourceLimit);
    let inserted = 0;
    await kysely.transaction().execute(async (trx) => {
      const res = await insertRunItems(
        trx,
        runId,
        capped.map((r) => ({ sourceKey: r.sourceKey, snapshot: sourceSnapshot(r, requestId) })),
      );
      inserted = res.inserted;
    });
    // Persist a coverage summary row so status surfacing is uniform with the paid path.
    await ensureSourceRequests(kysely, runId, planStep.id, [{ index: 0, descriptor: `source:${defStep.provider}` }]);
    const row0 = (await listSourceRequestsForStep(kysely, runId, planStep.id)).find((r) => r.request_index === 0);
    if (row0 && row0.status !== "completed") {
      await finalizeSourceRequest(kysely, row0.id, {
        status: "completed",
        cost: 0,
        providerRequestId: requestId,
        recordsInserted: inserted,
        coverageNote: coverageNote ?? null,
      });
    }
    await setStepProgress(kysely, runId, planStep.id, "completed");
    return "completed";
  }

  return await executePagedSource(deps, runId, planStep, provider, query, plan, leaseToken);
}

async function executePagedSource(
  deps: RunnerDeps,
  runId: string,
  planStep: PlannedStep,
  provider: PagedPaidSource,
  query: SourceQuery,
  plan: ResolvedPlan,
  leaseToken: string,
): Promise<SourceStepSignal> {
  const kysely = deps.db.kysely;
  const specs = provider.planSearchRequests(query);
  await ensureSourceRequests(
    kysely,
    runId,
    planStep.id,
    specs.map((s) => ({ index: s.index, descriptor: s.descriptor })),
  );

  for (const spec of specs) {
    if (await isCancelled(deps, runId)) return "cancelled";
    await renewRunLease(kysely, runId, leaseToken, deps.leaseTtlSeconds);

    // The ledger row is matched to the re-planned request by index; the stored
    // descriptor must still describe the SAME search. A provider-config change
    // between pause and resume (page ceiling, base URL semantics) could
    // otherwise silently execute searches never shown in any preview.
    const existing = (await listSourceRequestsForStep(kysely, runId, planStep.id)).find(
      (r) => r.request_index === spec.index,
    );
    if (existing && existing.descriptor !== spec.descriptor) {
      throw new AppError(
        "APPROVAL_MISMATCH",
        `Source request ${spec.index} re-planned as '${spec.descriptor}' but was approved as '${existing.descriptor}'. Provider configuration changed since the preview; preview and approve again.`,
        { runId, stepId: planStep.id, index: spec.index },
      );
    }
    // Skip rows already terminal from a prior pass BEFORE the credit gate, so a
    // resume near the budget ceiling is not blocked by already-paid requests.
    if (existing && (existing.status === "completed" || existing.status === "failed" || existing.status === "needs_review")) {
      continue;
    }

    // Credit gate BEFORE spending on this request (mirrors the enrich gate).
    const run = await getRun(kysely, runId);
    if (round4(num(run.credits_used) + spec.estimatedCost) > round4(num(run.credit_limit))) {
      assertRunTransition("running", "paused");
      await setRunStatus(kysely, runId, "paused", { pauseReason: "credit_cap_reached" });
      return "paused";
    }

    // Bounded retry for this one request.
    for (;;) {
      const claim = await claimSourceRequest(kysely, runId, planStep.id, spec.index, deps.maxStepAttempts);
      if (claim.kind === "already_done" || claim.kind === "needs_review" || claim.kind === "exhausted") break;

      try {
        const result = await provider.executeSearchRequest(spec, query, { requestKey: claim.requestKey });
        // Fault-injection point (crash before commit) — same contract as the item path.
        deps.hooks?.beforeFinalize?.({ stepId: planStep.id, sourceKey: `src:${spec.index}`, attempt: claim.attempt });
        await kysely.transaction().execute(async (trx) => {
          const current = await trx
            .selectFrom("run_items")
            .select(({ fn }) => fn.countAll().as("n"))
            .where("run_id", "=", runId)
            .executeTakeFirst();
          const room = Math.max(0, plan.sourceLimit - Number(current?.n ?? 0));
          const capped = result.records.slice(0, room);
          const { inserted } = await insertRunItems(
            trx,
            runId,
            capped.map((r) => ({ sourceKey: r.sourceKey, snapshot: sourceSnapshot(r, result.providerRequestId) })),
          );
          await finalizeSourceRequest(trx, claim.row.id, {
            status: "completed",
            cost: result.cost,
            providerRequestId: result.providerRequestId,
            recordsInserted: inserted,
            coverageNote: result.coverageNote,
          });
          await bumpRunCredits(trx, runId, result.cost);
        });
        break;
      } catch (err) {
        if (err instanceof RateLimitError) {
          // 429: revert the claim (attempt uncounted), schedule, and pause the run.
          const dueAt = new Date(Date.now() + err.retryAfterSeconds * 1000);
          await deferSourceRequestForRateLimit(kysely, claim.row.id, claim.attempt);
          assertRunTransition("running", "paused");
          await setRunStatus(kysely, runId, "paused", { pauseReason: "rate_limited", resumeAt: dueAt });
          return "paused";
        }
        if (err instanceof AmbiguousOutcomeError) {
          // Possibly completed and possibly charged: book the provisional cost,
          // park in needs_review, and continue to the next request.
          await kysely.transaction().execute(async (trx) => {
            await finalizeSourceRequest(trx, claim.row.id, {
              status: "needs_review",
              cost: err.possibleCost,
              providerRequestId: (err.details["providerRequestId"] as string | undefined) ?? null,
              coverageNote: "Outcome unconfirmed; held for review.",
              lastError: { code: err.code, message: err.message },
            });
            await bumpRunCredits(trx, runId, err.possibleCost);
          });
          break;
        }
        if (err instanceof RetryableProviderError) {
          const charged = err.details["charged"] === true;
          const failedCost = charged ? ((err.details["cost"] as number | undefined) ?? 0) : 0;
          await kysely.transaction().execute(async (trx) => {
            await finalizeSourceRequest(trx, claim.row.id, {
              status: "failed",
              cost: failedCost,
              lastError: { message: err.message, retryable: true },
            });
            await bumpRunCredits(trx, runId, failedCost);
          });
          continue; // bounded re-claim; exhaustion breaks via claimSourceRequest
        }
        // Non-typed error = crash: leave the row 'running' and propagate so
        // crash-resume replays the stored request_key.
        throw err;
      }
    }
  }

  // Completion: a fully-failed source fails the run; any success/needs_review
  // completes the step (partial coverage is surfaced via run_source_requests).
  const finalRows = await listSourceRequestsForStep(kysely, runId, planStep.id);
  const allFailed = finalRows.length > 0 && finalRows.every((r) => r.status === "failed");
  if (allFailed) {
    assertRunTransition("running", "failed");
    await setRunStatus(kysely, runId, "failed", {
      lastError: { message: "All source requests failed.", stepId: planStep.id },
    });
    return "failed";
  }
  await setStepProgress(kysely, runId, planStep.id, "completed");
  return "completed";
}

function sourceSnapshot(record: SourceRecord, requestId: string): Record<string, unknown> {
  return { source: record, sourceRequestId: requestId, sourceRetrievedAt: new Date().toISOString() };
}

/** Mirrors runner.checkCancel; inlined to avoid a runtime import cycle with runner.ts. */
async function isCancelled(deps: RunnerDeps, runId: string): Promise<boolean> {
  const run = await getRun(deps.db.kysely, runId);
  if (!run.cancel_requested || run.status === "cancelled") return run.status === "cancelled";
  assertRunTransition(run.status === "pending" ? "pending" : "running", "cancelled");
  await setRunStatus(deps.db.kysely, runId, "cancelled", { completedAt: new Date() });
  return true;
}
