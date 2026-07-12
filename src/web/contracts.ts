import { z } from "zod";

import { overridesSchema } from "../engine/workflow-schema/overrides.js";
import { profileSchema } from "../engine/workflow-schema/steps.js";

/**
 * The single wire-contract seam between the web API and the React client.
 * Request bodies are Zod-validated here (reusing the engine's own schemas);
 * response DTOs are `export type` re-exports of the application services'
 * return types, so the client type-checks against exactly what the server
 * sends without importing any server code at runtime.
 */

export type {
  PreviewResult,
  RunItemResult,
  RunListItem,
  RunOptions,
  RunStatusSummary,
} from "../app/run-service.js";
export type { WorkflowSummary } from "../app/workflow-service.js";
export type { Confidence, FieldSuggestion, InterpretedRequest } from "../app/request-interpreter.js";
export type { CapabilityOverrides } from "../engine/workflow-schema/overrides.js";
export type { Profile } from "../engine/workflow-schema/steps.js";
export type { PlannedStep, ResolvedPlan } from "../engine/workflow-schema/plan.js";

export interface ApiSuccess<T> {
  ok: true;
  data: T;
  warnings: string[];
  requestId: string;
}

export interface ApiFailure {
  ok: false;
  error: { code: string; message: string; details?: Record<string, unknown> };
  requestId: string;
}

export type ApiEnvelope<T> = ApiSuccess<T> | ApiFailure;

export type { ProviderStatusEntry as ProviderStatusInfo, ProviderTestResult } from "../app/provider-service.js";

export interface WorkflowCreateResponse {
  workflowId: string;
  slug: string;
  version: number;
  versionId: string;
  checksum: string;
  /** false when the template already existed and was returned as-is. */
  created: boolean;
}

export interface StartRunResponse {
  runId: string;
  status: string;
}

export interface RetryRunResponse {
  runId: string;
  status: string;
  requeued: number;
}

export interface CancelRunResponse {
  runId: string;
  status: string;
  cancelRequested: boolean;
}

export interface ResultsPage<T> {
  items: T[];
  page: { offset: number; limit: number; total: number; nextCursor: string | null };
}

/** Browser-facing export result: file name and download URL, never a server path. */
export interface WebExportResult {
  exportId: string;
  fileName: string;
  rowCount: number;
  noop: boolean;
  downloadUrl: string;
}

export const interpretBodySchema = z.object({ text: z.string().min(1).max(2000) }).strict();

/** Mirrors the MCP `runOptionsShape`; reuses the engine's profile/overrides schemas. */
export const runOptionsBodySchema = z
  .object({
    inputs: z.record(z.string(), z.unknown()).optional(),
    profile: profileSchema.optional(),
    overrides: overridesSchema.optional(),
    cap: z.number().int().min(0).max(100).optional(),
    budget: z.number().min(0).optional(),
  })
  .strict();

export const startBodySchema = runOptionsBodySchema.extend({ approval: z.string().min(1) }).strict();

export const resumeBodySchema = z
  .object({
    approval: z.string().min(1).optional(),
    budget: z.number().min(0).optional(),
    cap: z.number().int().min(0).max(100).optional(),
  })
  .strict();

export const reviewBodySchema = z
  .object({
    decision: z.enum(["approved", "rejected"]),
    itemIds: z.array(z.string()).min(1).optional(),
    all: z.boolean().optional(),
  })
  .strict();

export const createWorkflowBodySchema = z.union([
  z.object({ definition: z.record(z.string(), z.unknown()) }).strict(),
  z.object({ template: z.enum(["local-service-demo", "local-business-quick-list"]) }).strict(),
]);

export const exportBodySchema = z.object({ force: z.boolean().optional() }).strict();

export const resultsQuerySchema = z.object({
  reviewStatus: z.enum(["unreviewed", "approved", "rejected", "regenerate"]).optional(),
  status: z.enum(["pending", "in_progress", "completed", "failed", "skipped"]).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const runsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
