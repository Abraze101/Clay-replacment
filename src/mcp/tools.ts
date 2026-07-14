import { randomUUID } from "node:crypto";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import type { AppContainer } from "../app/container.js";
import {
  createWorkflowFromDefinition,
  listWorkflowSummaries,
  validateWorkflow,
} from "../app/workflow-service.js";
import {
  cancelRun,
  exportRunCsv,
  previewRun,
  resumeRun,
  retryRun,
  reviewRun,
  runResults,
  runStatus,
  startRun,
  type RunOptions,
} from "../app/run-service.js";
import { loadTemplateDefinition, templateIds } from "../app/template-service.js";
import { overridesSchema } from "../engine/workflow-schema/overrides.js";
import { profileSchema } from "../engine/workflow-schema/steps.js";
import { AppError, isAppError } from "../shared/errors.js";
import { decodeCursor, encodeCursor } from "../shared/pagination.js";

/**
 * The 12-tool model-neutral contract (M1). Handlers are thin calls into the
 * shared application services — the same code the CLI and the M2 UI use — and
 * every result returns the envelope {ok, data, summary, warnings, requestId,
 * nextActions} as structuredContent plus a human-readable text summary.
 * Errors map to machine-readable codes; stack traces never cross the wire.
 */

export interface ToolEnvelope {
  ok: boolean;
  data?: unknown;
  summary: string;
  warnings: string[];
  requestId: string;
  nextActions: string[];
  error?: { code: string; message: string; details?: Record<string, unknown> };
}

const envelopeShape = {
  ok: z.boolean(),
  data: z.unknown().optional(),
  summary: z.string(),
  warnings: z.array(z.string()),
  requestId: z.string(),
  nextActions: z.array(z.string()),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
      details: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
};

interface ToolBody {
  data?: unknown;
  summary: string;
  warnings?: string[];
  nextActions?: string[];
}

function toResult(envelope: ToolEnvelope, isError: boolean): CallToolResult {
  const lines = [envelope.summary, ...envelope.warnings.map((w) => `warning: ${w}`)];
  return {
    content: [{ type: "text", text: lines.join("\n") }],
    structuredContent: envelope as unknown as Record<string, unknown>,
    ...(isError ? { isError: true } : {}),
  };
}

async function respond(fn: () => Promise<ToolBody>): Promise<CallToolResult> {
  const requestId = randomUUID();
  try {
    const body = await fn();
    return toResult(
      {
        ok: true,
        data: body.data,
        summary: body.summary,
        warnings: body.warnings ?? [],
        requestId,
        nextActions: body.nextActions ?? [],
      },
      false,
    );
  } catch (err) {
    const code = isAppError(err) ? err.code : "INTERNAL";
    const message = err instanceof Error ? err.message : String(err);
    const details = isAppError(err) ? err.details : undefined;
    return toResult(
      {
        ok: false,
        summary: `error [${code}]: ${message}`,
        warnings: [],
        requestId,
        nextActions: code.startsWith("APPROVAL_") ? ["run_preview"] : [],
        error: { code, message, ...(details && Object.keys(details).length > 0 ? { details } : {}) },
      },
      true,
    );
  }
}

function nextActionsForRunStatus(status: string): string[] {
  switch (status) {
    case "waiting_review":
      return ["run_results", "lead_review_update", "run_resume"];
    case "paused":
      return ["run_status", "run_resume"];
    case "completed":
      return ["run_results", "run_export_csv"];
    case "failed":
      return ["run_status", "run_retry"];
    default:
      return ["run_status"];
  }
}

const workflowDefinitionField = z
  .record(z.string(), z.unknown())
  .describe("Complete workflow definition (id, name, inputs, steps[]) using only the approved step types.");

const runOptionsShape = {
  inputs: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      "Run inputs merged over the workflow's defaults (e.g. businessType, locations, limit, personTitles). Selected-lead continuation: pass inputs.continueFromRunId (a prior run id) on a run-continuation workflow — the engine resolves that run's APPROVED leads at preview, binds them into the approval, and re-sources nothing.",
    ),
  profile: profileSchema.optional().describe("Enrichment profile: quick_list, call_ready, or full."),
  overrides: overridesSchema.optional().describe("Typed per-capability overrides; bound into the approval scope."),
  cap: z.number().int().min(0).max(100).optional().describe("Paid record cap (hard maximum 100 per run)."),
  budget: z.number().min(0).optional().describe("Credit limit for paid steps; the run pauses when it is reached."),
  importCsv: z
    .string()
    .max(524_288)
    .optional()
    .describe(
      "Raw CSV text for imported-list workflows (≤512 KiB, ≤500 rows; recognized headers: company/name, website/domain, phone, email, linkedin, first/last/contact name, title, address, city, state, country). Pass the SAME text to run_preview and run_start — the approval binds the row content. Structured callers may pass inputs.importRows instead (never both).",
    ),
};

function toRunOptions(args: {
  inputs?: Record<string, unknown>;
  profile?: "quick_list" | "call_ready" | "full";
  overrides?: Record<string, unknown>;
  cap?: number;
  budget?: number;
  importCsv?: string;
}): RunOptions {
  return {
    inputs: args.inputs,
    profile: args.profile,
    overrides: args.overrides,
    cap: args.cap,
    budget: args.budget,
    importCsv: args.importCsv,
  };
}

const runIdField = z.string().describe("Durable run id returned by run_start.");

const readOnly: ToolAnnotations = { readOnlyHint: true, openWorldHint: false };
const mutating: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };

export function registerTools(server: McpServer, getApp: () => AppContainer): void {
  server.registerTool(
    "workflow_create",
    {
      title: "Create a workflow",
      description:
        "Validate a typed workflow definition (10-step allowlist; no arbitrary code) and persist it with immutable version 1. Instead of a definition, pass `template` to seed a built-in template: local-service-demo, local-business-quick-list, professional-executive, or imported-list-enrich.",
      inputSchema: {
        definition: workflowDefinitionField.optional(),
        template: z
          .string()
          .optional()
          .describe("Built-in template id to seed (XOR with definition)."),
      },
      outputSchema: envelopeShape,
      annotations: mutating,
    },
    async ({ definition, template }) =>
      await respond(async () => {
        if ((definition === undefined) === (template === undefined)) {
          throw new AppError("VALIDATION_FAILED", "Pass exactly one of 'definition' or 'template'.", {
            templates: templateIds(),
          });
        }
        const raw = definition ?? (await loadTemplateDefinition(template!));
        const created = await createWorkflowFromDefinition(getApp(), raw);
        return {
          data: created,
          summary: `Workflow '${created.slug}' created at version ${created.version}.`,
          nextActions: ["run_preview"],
        };
      }),
  );

  server.registerTool(
    "workflow_validate",
    {
      title: "Validate a workflow",
      description:
        "Validate the stored draft (or a new definition, which updates the draft) and create the next immutable version. Unchanged definitions return the existing version.",
      inputSchema: {
        workflow: z.string().describe("Workflow id or slug."),
        definition: workflowDefinitionField.optional(),
      },
      outputSchema: envelopeShape,
      annotations: { ...mutating, idempotentHint: true },
    },
    async ({ workflow, definition }) =>
      await respond(async () => {
        const validated = await validateWorkflow(getApp(), workflow, definition);
        return {
          data: validated,
          summary: `Workflow '${validated.slug}' is valid at version ${validated.version}.`,
          nextActions: ["run_preview"],
        };
      }),
  );

  server.registerTool(
    "workflow_list",
    {
      title: "List workflows",
      description: "List active workflows with their latest validated version.",
      inputSchema: {},
      outputSchema: envelopeShape,
      annotations: readOnly,
    },
    async () =>
      await respond(async () => {
        const workflows = await listWorkflowSummaries(getApp());
        return {
          data: { workflows },
          summary: `${workflows.length} workflow(s).`,
          nextActions: ["run_preview", "workflow_create"],
        };
      }),
  );

  server.registerTool(
    "run_preview",
    {
      title: "Preview a run and issue an approval token (no spend)",
      description:
        "Resolve the exact execution plan — steps, providers, free vs paid actions, record cap, budget, and estimated cost — and issue a single-use approval token bound to that scope. Nothing is spent. The human user must approve before run_start.",
      inputSchema: { workflow: z.string().describe("Workflow id or slug."), ...runOptionsShape },
      outputSchema: envelopeShape,
      annotations: mutating,
    },
    async ({ workflow, ...options }) =>
      await respond(async () => {
        const preview = await previewRun(getApp(), workflow, toRunOptions(options));
        const plan = preview.plan;
        return {
          data: preview,
          warnings: plan.warnings,
          summary: `Plan for '${workflow}' v${preview.workflowVersion} (${plan.profile}): ${plan.steps.filter((s) => s.willRun).length} steps, cap ${plan.paidRecordCap} paid records, estimated cost ${plan.estimatedCost}, budget ${plan.creditLimit}. Approval token expires ${preview.approval.expiresAt}.`,
          nextActions: ["run_start"],
        };
      }),
  );

  server.registerTool(
    "run_start",
    {
      title: "Start an approved run (spends within the approved budget)",
      description:
        "Consume a single-use approval token from run_preview and start the run. The engine rejects missing, expired, consumed, or scope-changed tokens — changing profile, overrides, cap, budget, inputs, or the workflow version requires a new preview.",
      inputSchema: {
        workflow: z.string().describe("Workflow id or slug."),
        approval: z.string().describe("Single-use approval token from run_preview."),
        ...runOptionsShape,
      },
      outputSchema: envelopeShape,
      annotations: mutating,
    },
    async ({ workflow, approval, ...options }) =>
      await respond(async () => {
        const app = getApp();
        const run = await startRun(app, workflow, approval, toRunOptions(options));
        const status = await runStatus(app, run.id);
        return {
          data: status,
          summary: `Run ${run.id} is ${run.status} (${status.counts.items} items, credits ${status.creditsUsed}/${status.creditLimit}).`,
          nextActions: nextActionsForRunStatus(run.status),
        };
      }),
  );

  server.registerTool(
    "run_status",
    {
      title: "Run status",
      description: "Durable run status, step progress, counts, and credit usage. Safe to poll from any client.",
      inputSchema: { runId: runIdField },
      outputSchema: envelopeShape,
      annotations: readOnly,
    },
    async ({ runId }) =>
      await respond(async () => {
        const status = await runStatus(getApp(), runId);
        return {
          data: status,
          summary: `Run ${runId}: ${status.status}${status.pauseReason ? ` (${status.pauseReason})` : ""} — ${status.counts.completed}/${status.counts.items} completed, ${status.counts.failed} failed, credits ${status.creditsUsed}/${status.creditLimit}.`,
          nextActions: nextActionsForRunStatus(status.status),
        };
      }),
  );

  server.registerTool(
    "run_results",
    {
      title: "Run results (paginated)",
      description:
        "List run items with lead summaries. Paginated: pass limit (default 50, max 200) and the nextCursor from the previous page.",
      inputSchema: {
        runId: runIdField,
        reviewStatus: z.enum(["unreviewed", "approved", "rejected", "regenerate"]).optional(),
        status: z.enum(["pending", "in_progress", "completed", "failed", "skipped"]).optional(),
        cursor: z.string().optional().describe("Opaque cursor from the previous page's nextCursor."),
        limit: z.number().int().min(1).max(200).optional().describe("Page size (default 50)."),
      },
      outputSchema: envelopeShape,
      annotations: readOnly,
    },
    async ({ runId, reviewStatus, status, cursor, limit }) =>
      await respond(async () => {
        const offset = decodeCursor(cursor);
        const pageSize = limit ?? 50;
        const all = await runResults(getApp(), runId, { reviewStatus, status });
        const items = all.slice(offset, offset + pageSize);
        const nextCursor = offset + pageSize < all.length ? encodeCursor(offset + pageSize) : null;
        return {
          data: { items, page: { offset, limit: pageSize, total: all.length, nextCursor } },
          summary: `${items.length} of ${all.length} item(s)${nextCursor ? "; more pages remain" : ""}.`,
          nextActions: nextCursor ? ["run_results"] : ["lead_review_update", "run_export_csv"],
        };
      }),
  );

  server.registerTool(
    "run_cancel",
    {
      title: "Cancel a run",
      description: "Request cancellation. Completed work and partial results are kept; the run cannot be restarted.",
      inputSchema: { runId: runIdField },
      outputSchema: envelopeShape,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async ({ runId }) =>
      await respond(async () => {
        const run = await cancelRun(getApp(), runId);
        return { data: { runId, status: run.status }, summary: `Run ${runId} is ${run.status}.` };
      }),
  );

  server.registerTool(
    "run_resume",
    {
      title: "Resume a run (budget/cap change requires a fresh approval token)",
      description:
        "Continue past the review gate, lift a credit-cap pause, or reclaim after a crash. Raising the budget or cap requires a fresh approval token from a new run_preview of the widened scope.",
      inputSchema: {
        runId: runIdField,
        approval: z.string().optional().describe("Fresh approval token; required when changing budget or cap."),
        budget: z.number().min(0).optional().describe("New credit limit (requires approval)."),
        cap: z.number().int().min(0).max(100).optional().describe("New paid record cap (requires approval)."),
      },
      outputSchema: envelopeShape,
      annotations: mutating,
    },
    async ({ runId, approval, budget, cap }) =>
      await respond(async () => {
        const app = getApp();
        const run = await resumeRun(app, runId, { approval, budget, cap });
        const status = await runStatus(app, runId);
        return {
          data: status,
          summary: `Run ${runId} is ${run.status} (credits ${status.creditsUsed}/${status.creditLimit}).`,
          nextActions: nextActionsForRunStatus(run.status),
        };
      }),
  );

  server.registerTool(
    "run_retry",
    {
      title: "Retry failed items",
      description:
        "Requeue failed steps/items and continue the run; also re-runs generation for items marked 'regenerate' (free). Steps in needs_review (possibly-completed paid calls) are never auto-retried.",
      inputSchema: { runId: runIdField },
      outputSchema: envelopeShape,
      annotations: mutating,
    },
    async ({ runId }) =>
      await respond(async () => {
        const app = getApp();
        const run = await retryRun(app, runId);
        const status = await runStatus(app, runId);
        return {
          data: status,
          summary: `Run ${runId} is ${run.status} (${status.counts.failed} failed item(s) remaining).`,
          nextActions: nextActionsForRunStatus(run.status),
        };
      }),
  );

  server.registerTool(
    "lead_review_update",
    {
      title: "Review leads",
      description:
        "Approve, reject, or mark run items for copy regeneration at the review gate or after completion. Pass itemIds for specific leads or all=true for every non-skipped item. 'regenerate' re-runs the item's generate step on the next run_retry (free) and returns it to 'unreviewed'.",
      inputSchema: {
        runId: runIdField,
        decision: z.enum(["approved", "rejected", "regenerate"]),
        itemIds: z.array(z.string()).min(1).optional().describe("Specific run item ids."),
        all: z.boolean().optional().describe("Apply to all non-skipped items (explicit)."),
      },
      outputSchema: envelopeShape,
      annotations: mutating,
    },
    async ({ runId, decision, itemIds, all }) =>
      await respond(async () => {
        if (Boolean(all) === Boolean(itemIds && itemIds.length > 0)) {
          throw new AppError("VALIDATION_FAILED", "Pass exactly one of itemIds or all=true.", {});
        }
        const result = await reviewRun(getApp(), runId, {
          reviewStatus: decision,
          itemIds: all ? "all" : (itemIds ?? []),
        });
        return {
          data: result,
          summary: `${result.updated} item(s) ${decision}.`,
          nextActions: ["run_resume", "run_export_csv"],
        };
      }),
  );

  server.registerTool(
    "run_export_csv",
    {
      title: "Export approved leads to CSV",
      description:
        "Export approved, completed leads to a CSV file in the engine's export directory (review gate enforced; formula-escaped). Re-export is idempotent unless force=true.",
      inputSchema: {
        runId: runIdField,
        force: z.boolean().optional().describe("Rewrite even when the dataset checksum is unchanged."),
      },
      outputSchema: envelopeShape,
      annotations: { ...mutating, idempotentHint: true },
    },
    async ({ runId, force }) =>
      await respond(async () => {
        const result = await exportRunCsv(getApp(), runId, Boolean(force));
        return {
          data: result,
          summary: result.noop
            ? `Export unchanged (dataset checksum match): ${result.filePath}`
            : `Exported ${result.rowCount} row(s) to ${result.filePath}.`,
        };
      }),
  );
}
