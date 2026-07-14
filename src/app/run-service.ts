import { iso } from "../shared/clock.js";
import { AppError } from "../shared/errors.js";
import type { ResolvedPlan } from "../engine/workflow-schema/plan.js";
import { resolvePlan } from "../engine/workflow-schema/plan.js";
import type { CapabilityOverrides } from "../engine/workflow-schema/overrides.js";
import { overridesSchema } from "../engine/workflow-schema/overrides.js";
import type { Profile } from "../engine/workflow-schema/steps.js";
import { parseWorkflowDefinition } from "../engine/workflow-schema/workflow.js";
import { assertRunTransition } from "../engine/runner/states.js";
import { exportRun, type ExportResult } from "../engine/export/export-run.js";
import { parseImportCsv } from "../engine/import/csv-import.js";
import type { ApprovalEntry, JsonObject, ReviewStatus } from "../storage/database-types.js";
import { num } from "../storage/database-types.js";
import { getLead, listContactPoints } from "../storage/repositories/lead-repo.js";
import { latestOutput } from "../storage/repositories/output-repo.js";
import { findActiveSuppressions } from "../storage/repositories/suppression-repo.js";
import {
  createRun,
  getRun,
  latestApproval,
  appendApproval,
  listRunItems,
  listRunsWithWorkflow,
  listStepsForRun,
  passReviewGate,
  requestCancel,
  requeueFailedSteps,
  requeueRegenerateSteps,
  reviewRunItems,
  setRunStatus,
  type RunRow,
} from "../storage/repositories/run-repo.js";
import { getLatestVersion, getVersion, getWorkflow } from "../storage/repositories/workflow-repo.js";
import { listSourceRequests, requeueFailedSourceRequests } from "../storage/repositories/source-request-repo.js";
import { consumeApprovalToken, issueApprovalToken, linkApprovalToRun } from "./approval-service.js";
import type { AppContainer } from "./container.js";

export interface RunOptions {
  inputs?: Record<string, unknown>;
  profile?: Profile;
  overrides?: Record<string, unknown>;
  cap?: number;
  budget?: number;
  /**
   * Raw CSV text for imported-list workflows (≤512 KiB, ≤500 rows). Parsed
   * once here into inputs.importRows, so the SAME text must accompany preview
   * and start — the approval binds row content, and a changed list fails the
   * plan-hash check by design. XOR with inputs.importRows.
   */
  importCsv?: string;
}

export interface PreviewResult {
  workflowId: string;
  workflowVersionId: string;
  workflowVersion: number;
  plan: ResolvedPlan;
  /** Single-use engine approval issued for exactly this plan hash/scope. */
  approval: { token: string; expiresAt: string };
}

function parseOverrides(raw: Record<string, unknown> | undefined): CapabilityOverrides {
  const result = overridesSchema.safeParse(raw ?? {});
  if (!result.success) {
    throw new AppError("VALIDATION_FAILED", "Overrides are invalid.", {
      issues: result.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }
  return result.data;
}

/** Resolve the plan for a preview or start without issuing an approval token. */
async function resolvePreview(
  app: AppContainer,
  idOrSlug: string,
  options: RunOptions,
): Promise<Omit<PreviewResult, "approval">> {
  const workflow = await getWorkflow(app.db.kysely, idOrSlug, app.agencyId);
  const version = await getLatestVersion(app.db.kysely, workflow.id);
  if (!version) throw new AppError("NOT_FOUND", `Workflow '${idOrSlug}' has no validated version.`, {});
  const definition = parseWorkflowDefinition(version.definition);

  let inputs = options.inputs ?? {};
  const importWarnings: string[] = [];
  if (options.importCsv !== undefined) {
    if (inputs["importRows"] !== undefined) {
      throw new AppError("VALIDATION_FAILED", "Pass either importCsv (raw text) or inputs.importRows — not both.", {});
    }
    // Parsed identically on preview AND start: same text → same rows → same
    // plan hash. The accepted rows persist in the run's resolved plan, so
    // resume/crash-replay never touches a file again.
    const parsed = parseImportCsv(options.importCsv);
    inputs = { ...inputs, importRows: parsed.rows };
    importWarnings.push(...parsed.warnings);
    for (const reject of parsed.rejected) {
      importWarnings.push(`import line ${reject.line}: ${reject.reason}`);
    }
  }

  // Selected-lead continuation (M5): resolve the prior run's APPROVED,
  // completed leads from durable review state and bind the id set into the
  // plan hash — preview and start both resolve from the database, so a review
  // flip in between yields a different hash and APPROVAL_MISMATCH by design.
  const continueFromRunId = inputs["continueFromRunId"];
  if (typeof continueFromRunId === "string" && inputs["continuationLeadIds"] === undefined) {
    const priorRun = await getRun(app.db.kysely, continueFromRunId);
    if (priorRun.agency_id !== app.agencyId) {
      throw new AppError("NOT_FOUND", `Run '${continueFromRunId}' not found.`, {});
    }
    const approved = await listRunItems(app.db.kysely, continueFromRunId, { reviewStatuses: ["approved"] });
    const leadIds = approved
      .filter((i) => i.status === "completed" && i.lead_id !== null)
      .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id))
      .map((i) => i.lead_id as string);
    if (leadIds.length === 0) {
      throw new AppError(
        "VALIDATION_FAILED",
        `Run '${continueFromRunId}' has no approved, completed leads to continue — review and approve rows first.`,
        { runId: continueFromRunId },
      );
    }
    // Clamp the limit to the selection so caps and estimates are exact,
    // unless the caller explicitly narrowed it further.
    inputs = { ...inputs, continuationLeadIds: leadIds, limit: (inputs["limit"]) ?? leadIds.length };
    importWarnings.push(
      `Continuation source: ${leadIds.length} approved row(s) from run ${continueFromRunId} (0 credits — no provider calls).`,
    );
  }

  const plan = resolvePlan({
    definition,
    workflowChecksum: version.checksum,
    inputs,
    profile: options.profile,
    overrides: parseOverrides(options.overrides),
    requestedCap: options.cap,
    requestedBudget: options.budget,
    providers: app.providers,
  });
  plan.warnings.push(...importWarnings);
  return { workflowId: workflow.id, workflowVersionId: version.id, workflowVersion: version.version, plan };
}

/**
 * `run preview`: resolve the exact execution plan (steps, estimates, cap,
 * budget) and issue a single-use approval token bound to its plan hash and
 * full scope. Persists only the token row; spends nothing.
 */
export async function previewRun(app: AppContainer, idOrSlug: string, options: RunOptions): Promise<PreviewResult> {
  const preview = await resolvePreview(app, idOrSlug, options);
  const issued = await issueApprovalToken(app.db.kysely, {
    agencyId: app.agencyId,
    workflowVersionId: preview.workflowVersionId,
    plan: preview.plan,
    ttlMinutes: app.env.APPROVAL_TOKEN_TTL_MINUTES,
  });
  return { ...preview, approval: { token: issued.token, expiresAt: issued.expiresAt } };
}

/**
 * `run start --approval <token>`: recompute the plan from durable state and
 * consume the token against the recomputed hash (defense in depth — the token
 * stores the scope AND the hash must match what the engine resolves now).
 * Approval is engine-enforced — paid contact work can never silently start
 * because a source returned rows, and no harness prompt substitutes for it.
 */
export async function startRun(
  app: AppContainer,
  idOrSlug: string,
  approvalToken: string,
  options: RunOptions,
): Promise<RunRow> {
  const run = await createApprovedRun(app, idOrSlug, approvalToken, options);
  return await app.worker.runToBoundary(run.id);
}

/** Create the durable, approved run row without executing it (used by startRun and by tests that drive the runner directly). */
export async function createApprovedRun(
  app: AppContainer,
  idOrSlug: string,
  approvalToken: string,
  options: RunOptions,
): Promise<RunRow> {
  const preview = await resolvePreview(app, idOrSlug, options);
  return await app.db.kysely.transaction().execute(async (trx) => {
    const consumed = await consumeApprovalToken(trx, approvalToken, preview.plan.planHash);
    const approval: ApprovalEntry = {
      id: consumed.id,
      planHash: preview.plan.planHash,
      profile: preview.plan.profile,
      overrides: preview.plan.overrides,
      paidRecordCap: preview.plan.paidRecordCap,
      creditLimit: preview.plan.creditLimit,
      estimatedPaidActions: preview.plan.estimatedPaidActions,
      approvedAt: consumed.consumedAt,
      source: app.actor,
      expiresAt: consumed.expiresAt,
      consumedAt: consumed.consumedAt,
    };
    const run = await createRun(trx, {
      agencyId: app.agencyId,
      workflowVersionId: preview.workflowVersionId,
      inputs: preview.plan.inputs,
      profile: preview.plan.profile,
      overrides: preview.plan.overrides,
      resolvedPlan: preview.plan as unknown as JsonObject,
      planHash: preview.plan.planHash,
      paidRecordCap: preview.plan.paidRecordCap,
      creditLimit: preview.plan.creditLimit,
      approval,
    });
    await linkApprovalToRun(trx, consumed.id, run.id);
    return run;
  });
}

export interface RunStatusSummary {
  runId: string;
  status: string;
  pauseReason: string | null;
  resumeAt: string | null;
  cancelRequested: boolean;
  profile: string;
  planHash: string;
  paidRecordCap: number;
  creditLimit: number;
  creditsUsed: number;
  reviewGatePassedAt: string | null;
  counts: {
    items: number;
    pending: number;
    inProgress: number;
    completed: number;
    failed: number;
    skipped: number;
    filtered: number;
    identityConflicts: number;
    approved: number;
    rejected: number;
    unreviewed: number;
    stepsNeedingReview: number;
  };
  stepProgress: Record<string, string>;
  /** Per-search source provenance/coverage — makes "coverage limits are visible" true. */
  sourceCoverage: {
    descriptor: string;
    status: string;
    recordsInserted: number | null;
    coverageNote: string | null;
  }[];
  startedAt: string | null;
  completedAt: string | null;
  lastError: unknown;
}

export async function runStatus(app: AppContainer, runId: string): Promise<RunStatusSummary> {
  const run = await getRun(app.db.kysely, runId);
  const items = await listRunItems(app.db.kysely, runId);
  const steps = await listStepsForRun(app.db.kysely, runId);
  const sourceRequests = await listSourceRequests(app.db.kysely, runId);
  return {
    runId: run.id,
    status: run.status,
    pauseReason: run.pause_reason,
    resumeAt: iso(run.resume_at),
    cancelRequested: run.cancel_requested,
    profile: run.enrichment_profile,
    planHash: run.plan_hash,
    paidRecordCap: run.paid_record_cap,
    creditLimit: num(run.credit_limit),
    creditsUsed: num(run.credits_used),
    reviewGatePassedAt: iso(run.review_gate_passed_at),
    counts: {
      items: items.length,
      pending: items.filter((i) => i.status === "pending").length,
      inProgress: items.filter((i) => i.status === "in_progress").length,
      completed: items.filter((i) => i.status === "completed").length,
      failed: items.filter((i) => i.status === "failed").length,
      skipped: items.filter((i) => i.status === "skipped").length,
      filtered: items.filter((i) => i.skip_reason === "filtered").length,
      identityConflicts: items.filter((i) => i.skip_reason === "identity_conflict").length,
      approved: items.filter((i) => i.review_status === "approved").length,
      rejected: items.filter((i) => i.review_status === "rejected").length,
      unreviewed: items.filter((i) => i.review_status === "unreviewed").length,
      stepsNeedingReview: steps.filter((s) => s.status === "needs_review").length,
    },
    stepProgress: run.step_progress,
    sourceCoverage: sourceRequests.map((r) => ({
      descriptor: r.descriptor,
      status: r.status,
      recordsInserted: r.records_inserted,
      coverageNote: r.coverage_note,
    })),
    startedAt: iso(run.started_at),
    completedAt: iso(run.completed_at),
    lastError: run.last_error,
  };
}

export interface RunListItem {
  runId: string;
  workflowSlug: string;
  workflowName: string;
  status: string;
  pauseReason: string | null;
  profile: string;
  creditsUsed: number;
  creditLimit: number;
  createdAt: string | null;
  completedAt: string | null;
}

/** Recent runs with workflow identity, newest first (Home screen listing). */
export async function listRunSummaries(app: AppContainer, limit = 50): Promise<RunListItem[]> {
  const rows = await listRunsWithWorkflow(app.db.kysely, app.agencyId, limit);
  return rows.map((row) => ({
    runId: row.id,
    workflowSlug: row.workflow_slug,
    workflowName: row.workflow_name,
    status: row.status,
    pauseReason: row.pause_reason,
    profile: row.enrichment_profile,
    creditsUsed: num(row.credits_used),
    creditLimit: num(row.credit_limit),
    createdAt: iso(row.created_at),
    completedAt: iso(row.completed_at),
  }));
}

/** One phone contact point as surfaced to results views (per-signal honesty; never a bare 'verified'). */
export interface ResultPhone {
  role: string;
  e164: string | null;
  lineType: string | null;
  lineStatus: string | null;
  identityMatch: string | null;
  /** Deepest check performed: none | format | line_status | identity_match. */
  validationLevel: "none" | "format" | "line_status" | "identity_match";
  lastCheckedAt: string | null;
  suppressed: boolean;
}

export interface RunItemResult {
  runItemId: string;
  position: number;
  sourceKey: string;
  status: string;
  skipReason: string | null;
  dedupeStatus: string | null;
  reviewStatus: string;
  score: number | null;
  leadId: string | null;
  callReadinessStatus: string | null;
  callReadinessReason: string | null;
  business: {
    name: string | null;
    category: string | null;
    website: string | null;
    locality: string | null;
    businessMainPhone: string | null;
  } | null;
  owner: { name: string; title: string } | null;
  /** M5 contact detail: one entry per phone contact point, best-first per role ordering. */
  phones: ResultPhone[];
  email: {
    address: string | null;
    status: string | null;
    lastCheckedAt: string | null;
    verifiedEmail: string | null;
  } | null;
  /** Latest generated copy per kind (append-only history stays in generated_outputs). */
  generated: {
    fitSummary: Record<string, unknown> | null;
    callNotes: Record<string, unknown> | null;
    opener: Record<string, unknown> | null;
  } | null;
  suppressed: boolean;
}

export async function runResults(
  app: AppContainer,
  runId: string,
  filter: { reviewStatus?: ReviewStatus; status?: "pending" | "in_progress" | "completed" | "failed" | "skipped" },
): Promise<RunItemResult[]> {
  await getRun(app.db.kysely, runId);
  const items = await listRunItems(app.db.kysely, runId, {
    ...(filter.status ? { statuses: [filter.status] } : {}),
    ...(filter.reviewStatus ? { reviewStatuses: [filter.reviewStatus] } : {}),
  });
  const results: RunItemResult[] = [];
  for (const item of items) {
    const lead = item.lead_id ? await getLead(app.db.kysely, item.lead_id) : undefined;
    const snapshot = item.snapshot as { enrichment?: { personName?: string; title?: string } };
    let phones: ResultPhone[] = [];
    let email: RunItemResult["email"] = null;
    let generated: RunItemResult["generated"] = null;
    let suppressed = false;
    if (lead) {
      const contactPoints = await listContactPoints(app.db.kysely, lead.id);
      const matches = await findActiveSuppressions(app.db.kysely, app.agencyId, {
        phones: contactPoints.filter((cp) => cp.type === "phone" && cp.normalized_value).map((cp) => cp.normalized_value as string),
        emails: contactPoints.filter((cp) => cp.type === "email" && cp.normalized_value).map((cp) => cp.normalized_value as string),
        domains: lead.normalized_domain ? [lead.normalized_domain] : [],
        leadIds: [lead.id],
      });
      const suppressedValues = new Set(matches.filter((m) => m.scope === "phone" || m.scope === "email").map((m) => m.normalized_value));
      suppressed = matches.some((m) => m.scope === "lead" || m.scope === "domain");
      phones = contactPoints
        .filter((cp) => cp.type === "phone")
        .map((cp) => {
          const level =
            cp.identity_match_checked_at !== null
              ? ("identity_match" as const)
              : cp.line_status_checked_at !== null
                ? ("line_status" as const)
                : cp.format_checked_at !== null
                  ? ("format" as const)
                  : ("none" as const);
          const times = [cp.format_checked_at, cp.line_status_checked_at, cp.identity_match_checked_at]
            .filter((v): v is Date | string => v !== null)
            .map((v) => new Date(v).getTime());
          return {
            role: cp.role,
            e164: cp.normalized_value,
            lineType: cp.line_type,
            lineStatus: cp.line_status,
            identityMatch: cp.identity_match,
            validationLevel: level,
            lastCheckedAt: times.length > 0 ? iso(new Date(Math.max(...times))) : null,
            suppressed: cp.normalized_value !== null && suppressedValues.has(cp.normalized_value),
          };
        });
      const workEmail = contactPoints.find((cp) => cp.type === "email" && cp.role === "work") ?? contactPoints.find((cp) => cp.type === "email");
      email = workEmail
        ? {
            address: workEmail.normalized_value,
            status: workEmail.email_status,
            lastCheckedAt: iso(workEmail.email_status_checked_at),
            verifiedEmail: lead.verified_email,
          }
        : lead.verified_email
          ? { address: lead.verified_email, status: "valid", lastCheckedAt: null, verifiedEmail: lead.verified_email }
          : null;
      const [fitSummary, callNotes, opener] = await Promise.all([
        latestOutput(app.db.kysely, runId, lead.id, "fit_summary"),
        latestOutput(app.db.kysely, runId, lead.id, "call_notes"),
        latestOutput(app.db.kysely, runId, lead.id, "opener"),
      ]);
      if (fitSummary || callNotes || opener) {
        generated = {
          fitSummary: fitSummary?.content ?? null,
          callNotes: callNotes?.content ?? null,
          opener: opener?.content ?? null,
        };
      }
    }
    results.push({
      runItemId: item.id,
      position: item.position,
      sourceKey: item.source_key,
      status: item.status,
      skipReason: item.skip_reason,
      dedupeStatus: item.dedupe_status,
      reviewStatus: item.review_status,
      score: item.score === null ? null : num(item.score),
      leadId: item.lead_id,
      callReadinessStatus: item.call_readiness_status,
      callReadinessReason: item.call_readiness_reason,
      business: lead
        ? {
            name: lead.display_name,
            category: lead.category,
            website: lead.website_url,
            locality: lead.locality,
            businessMainPhone: lead.normalized_phone,
          }
        : null,
      owner: snapshot.enrichment?.personName
        ? { name: snapshot.enrichment.personName, title: snapshot.enrichment.title ?? "" }
        : null,
      phones,
      email,
      generated,
      suppressed,
    });
  }
  return results;
}

export async function reviewRun(
  app: AppContainer,
  runId: string,
  decision: { reviewStatus: Extract<ReviewStatus, "approved" | "rejected" | "regenerate">; itemIds: string[] | "all" },
): Promise<{ updated: number }> {
  const run = await getRun(app.db.kysely, runId);
  if (run.status === "running") {
    throw new AppError("CONFLICT", "Run is executing; review at the review gate (waiting_review) or after completion.", { runId });
  }
  if (decision.itemIds !== "all" && decision.itemIds.length === 0) {
    throw new AppError("VALIDATION_FAILED", "Provide --item ids or an explicit --all.", {});
  }
  const updated = await reviewRunItems(app.db.kysely, runId, decision.itemIds, decision.reviewStatus, app.actor);
  return { updated };
}

/**
 * `run resume`: reclaim after a crash, continue past the review gate
 * (recording the operator as the gate actor), or lift a credit-cap pause —
 * the latter ONLY by consuming a fresh approval token covering the new
 * budget/cap (issued by a new `run preview` of the widened scope).
 */
export async function resumeRun(
  app: AppContainer,
  runId: string,
  options: { approval?: string; budget?: number; cap?: number },
): Promise<RunRow> {
  await prepareResume(app, runId, options);
  return await app.worker.runToBoundary(runId);
}

/**
 * Everything `run resume` does except executing: consume a fresh approval for a
 * budget/cap change and move the run back to `running`. The web API responds
 * after this and kicks execution in the background so approval and state
 * errors still surface synchronously.
 */
export async function prepareResume(
  app: AppContainer,
  runId: string,
  options: { approval?: string; budget?: number; cap?: number },
): Promise<RunRow> {
  const run = await getRun(app.db.kysely, runId);

  if (options.budget !== undefined || options.cap !== undefined) {
    const version = await getVersion(app.db.kysely, run.workflow_version_id);
    const definition = parseWorkflowDefinition(version.definition);
    const plan = resolvePlan({
      definition,
      workflowChecksum: version.checksum,
      inputs: run.inputs,
      profile: run.enrichment_profile,
      overrides: parseOverrides(run.overrides),
      requestedCap: options.cap ?? run.paid_record_cap,
      requestedBudget: options.budget ?? num(run.credit_limit),
      providers: app.providers,
    });
    const approvalToken = options.approval;
    if (!approvalToken) {
      throw new AppError(
        "APPROVAL_REQUIRED",
        "Changing budget or cap requires a fresh approval: preview the new scope and pass the token it issues via --approval.",
        { expected: plan.planHash },
      );
    }
    await app.db.kysely.transaction().execute(async (trx) => {
      const consumed = await consumeApprovalToken(trx, approvalToken, plan.planHash);
      await appendApproval(
        trx,
        runId,
        {
          id: consumed.id,
          planHash: plan.planHash,
          profile: plan.profile,
          overrides: plan.overrides,
          paidRecordCap: plan.paidRecordCap,
          creditLimit: plan.creditLimit,
          estimatedPaidActions: plan.estimatedPaidActions,
          approvedAt: consumed.consumedAt,
          source: app.actor,
          expiresAt: consumed.expiresAt,
          consumedAt: consumed.consumedAt,
        },
        {
          planHash: plan.planHash,
          paidRecordCap: plan.paidRecordCap,
          creditLimit: plan.creditLimit,
          profile: plan.profile,
          overrides: plan.overrides,
          resolvedPlan: plan as unknown as JsonObject,
        },
      );
      await linkApprovalToRun(trx, consumed.id, runId);
    });
  }

  const fresh = await getRun(app.db.kysely, runId);
  if (fresh.status === "waiting_review") {
    if (!fresh.review_gate_passed_at) await passReviewGate(app.db.kysely, runId, app.actor);
    assertRunTransition("waiting_review", "running");
    await setRunStatus(app.db.kysely, runId, "running");
  } else if (fresh.status === "paused") {
    assertRunTransition("paused", "running");
    await setRunStatus(app.db.kysely, runId, "running", { pauseReason: null, resumeAt: null });
  } else if (fresh.status === "completed" || fresh.status === "failed" || fresh.status === "cancelled") {
    throw new AppError("RUN_NOT_RUNNABLE", `Run is ${fresh.status}; use 'run retry' for failed items.`, { runId });
  }
  return await getRun(app.db.kysely, runId);
}

/**
 * Auto-resume a run paused ONLY by a provider-side wait — a rate limit or a
 * pending async vendor job (awaiting_provider, ADR-029) — whose resume_at has
 * arrived. Never lifts a credit-cap or operator pause — those require explicit
 * operator action / a fresh approval. Budget/cap are unchanged, so no approval
 * token is needed. Used by the job drivers' schedulers (in-process self-heal
 * and the pg-boss delayed job).
 */
export async function autoResumeRun(app: AppContainer, runId: string): Promise<RunRow> {
  const run = await getRun(app.db.kysely, runId);
  if (run.status !== "paused" || (run.pause_reason !== "rate_limited" && run.pause_reason !== "awaiting_provider")) {
    return run;
  }
  if (run.resume_at !== null && new Date(run.resume_at) > new Date()) return run; // not due yet
  assertRunTransition("paused", "running");
  await setRunStatus(app.db.kysely, runId, "running", { pauseReason: null, resumeAt: null });
  return await app.worker.runToBoundary(runId);
}

/** `run retry`: requeue failed steps/items (rotating request keys) and continue. needs_review is untouched. */
export async function retryRun(app: AppContainer, runId: string): Promise<RunRow> {
  const { run, requeued } = await prepareRetry(app, runId);
  if (requeued === 0) return run;
  return await app.worker.runToBoundary(runId);
}

/** Everything `run retry` does except executing (see prepareResume). */
export async function prepareRetry(app: AppContainer, runId: string): Promise<{ run: RunRow; requeued: number }> {
  const run = await getRun(app.db.kysely, runId);
  if (run.status === "running" || run.status === "waiting_review" || run.status === "paused") {
    throw new AppError("RUN_NOT_RUNNABLE", `Run is ${run.status}; retry applies to completed or failed runs.`, { runId });
  }
  if (run.status === "cancelled") {
    throw new AppError("RUN_NOT_RUNNABLE", "Cancelled runs are not retried.", { runId });
  }
  const requeuedSteps = await requeueFailedSteps(app.db.kysely, runId);
  // Failed source searches are equally retryable (they cost nothing when they
  // failed; completed/needs_review rows are untouched, so no double-spend).
  const sourceRequeue = await requeueFailedSourceRequests(app.db.kysely, runId);
  // M5 regeneration: items marked 'regenerate' re-run their generate steps
  // (free) and return to 'unreviewed' on success. needs_review stays untouched.
  const plan = run.resolved_plan as unknown as { steps?: { id: string; type: string; willRun?: boolean }[] };
  const generateStepIds = (plan.steps ?? []).filter((s) => s.type === "generate").map((s) => s.id);
  const regenerated = await requeueRegenerateSteps(app.db.kysely, runId, generateStepIds);
  const requeued = requeuedSteps + sourceRequeue.requeued + regenerated;
  if (requeued === 0) return { run, requeued: 0 };
  // Clear completed markers for re-entry (item steps recompute from the ledger).
  assertRunTransition(run.status, "running");
  await setRunStatus(app.db.kysely, runId, "running", { completedAt: undefined, lastError: null });
  await clearStepProgressForRetry(app, runId, sourceRequeue.stepIds);
  return { run: await getRun(app.db.kysely, runId), requeued };
}

async function clearStepProgressForRetry(app: AppContainer, runId: string, reopenedSourceStepIds: string[]): Promise<void> {
  // Item-step markers must re-open so requeued ledger rows are revisited;
  // review_gate/export markers stay (the gate stays passed; export re-runs only
  // via `export csv`). A source marker stays UNLESS one of its ledger rows was
  // requeued — then the source step must re-enter (completed requests are
  // skipped by the run_source_requests ledger, so nothing re-pays).
  const run = await getRun(app.db.kysely, runId);
  const plan = run.resolved_plan as unknown as { steps?: { id: string; type: string }[] };
  const keep: Record<string, string> = {};
  for (const [stepId, marker] of Object.entries(run.step_progress)) {
    const planStep = plan.steps?.find((s) => s.id === stepId);
    if (!planStep) continue;
    if (planStep.type === "review_gate") keep[stepId] = marker;
    if (planStep.type === "source" && !reopenedSourceStepIds.includes(stepId)) keep[stepId] = marker;
  }
  const { kysely } = app.db;
  await kysely
    .updateTable("runs")
    .set({ step_progress: JSON.stringify(keep), updated_at: new Date() })
    .where("id", "=", runId)
    .execute();
}

export async function cancelRun(app: AppContainer, runId: string): Promise<RunRow> {
  const run = await getRun(app.db.kysely, runId);
  if (run.status === "completed" || run.status === "failed" || run.status === "cancelled") {
    throw new AppError("RUN_NOT_RUNNABLE", `Run is already ${run.status}.`, { runId });
  }
  await requestCancel(app.db.kysely, runId);
  if (run.status === "pending" || run.status === "waiting_review" || run.status === "paused") {
    assertRunTransition(run.status, "cancelled");
    await setRunStatus(app.db.kysely, runId, "cancelled", { completedAt: new Date() });
  }
  return await getRun(app.db.kysely, runId);
}

export async function exportRunCsv(app: AppContainer, runId: string, force: boolean): Promise<ExportResult> {
  return await exportRun(app.db, { runId, exportDir: app.env.EXPORT_DIR, force });
}

export function approvalSummary(run: RunRow): ApprovalEntry | undefined {
  return latestApproval(run);
}
