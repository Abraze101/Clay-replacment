import { iso } from "../shared/clock.js";
import type { WorkflowDefinition } from "../engine/workflow-schema/workflow.js";
import { parseWorkflowDefinition } from "../engine/workflow-schema/workflow.js";
import { SCORE_TEMPLATES } from "../engine/scoring/templates.js";
import { AppError } from "../shared/errors.js";
import type { AppContainer } from "./container.js";
import {
  createVersion,
  createWorkflow,
  getLatestVersion,
  getWorkflow,
  listWorkflows,
  updateDraft,
} from "../storage/repositories/workflow-repo.js";

export interface WorkflowSummary {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  latestVersion: number | null;
  versionId: string | null;
  checksum: string | null;
  createdAt: string | null;
}

/** Cross-step validation beyond the schema: providers and templates must be registered. */
function validateReferences(app: AppContainer, definition: WorkflowDefinition): void {
  for (const step of definition.steps) {
    if (step.type === "source" && !app.providers.sources.has(step.provider)) {
      throw new AppError("VALIDATION_FAILED", `Unknown source provider '${step.provider}'.`, { stepId: step.id });
    }
    if (step.type === "enrich" && !app.providers.enrichers.has(step.provider)) {
      throw new AppError("VALIDATION_FAILED", `Unknown enrich provider '${step.provider}'.`, { stepId: step.id });
    }
    if (step.type === "research" && !app.providers.researchers.has(step.provider)) {
      throw new AppError("VALIDATION_FAILED", `Unknown research provider '${step.provider}'.`, { stepId: step.id });
    }
    if (step.type === "score" && !SCORE_TEMPLATES.has(step.template)) {
      throw new AppError("VALIDATION_FAILED", `Unknown score template '${step.template}'.`, { stepId: step.id });
    }
  }
}

/** `workflow create --file`: validate the definition and persist workflow + immutable version 1. */
export async function createWorkflowFromDefinition(
  app: AppContainer,
  raw: unknown,
): Promise<{ workflowId: string; slug: string; version: number; versionId: string; checksum: string }> {
  const definition = parseWorkflowDefinition(raw);
  validateReferences(app, definition);
  const workflow = await createWorkflow(app.db.kysely, {
    agencyId: app.agencyId,
    slug: definition.id,
    name: definition.name,
    description: definition.description,
    draft: definition,
  });
  const version = await createVersion(app.db.kysely, workflow.id, definition);
  return {
    workflowId: workflow.id,
    slug: workflow.slug,
    version: version.version,
    versionId: version.id,
    checksum: version.checksum,
  };
}

/**
 * `workflow validate <id> [--file]`: validate a new definition (updating the
 * draft and creating the next immutable version) or re-validate the stored
 * draft (idempotent: an unchanged draft returns the existing version).
 */
export async function validateWorkflow(
  app: AppContainer,
  idOrSlug: string,
  raw?: unknown,
): Promise<{ workflowId: string; slug: string; version: number; versionId: string; checksum: string }> {
  const workflow = await getWorkflow(app.db.kysely, idOrSlug, app.agencyId);
  const definition = parseWorkflowDefinition(raw ?? workflow.draft_definition);
  validateReferences(app, definition);
  if (raw !== undefined) await updateDraft(app.db.kysely, workflow.id, definition);
  const version = await createVersion(app.db.kysely, workflow.id, definition);
  return {
    workflowId: workflow.id,
    slug: workflow.slug,
    version: version.version,
    versionId: version.id,
    checksum: version.checksum,
  };
}

export async function listWorkflowSummaries(app: AppContainer): Promise<WorkflowSummary[]> {
  const workflows = await listWorkflows(app.db.kysely, app.agencyId);
  const summaries: WorkflowSummary[] = [];
  for (const wf of workflows) {
    const latest = await getLatestVersion(app.db.kysely, wf.id);
    summaries.push({
      id: wf.id,
      slug: wf.slug,
      name: wf.name,
      description: wf.description,
      latestVersion: latest?.version ?? null,
      versionId: latest?.id ?? null,
      checksum: latest?.checksum ?? null,
      createdAt: iso(wf.created_at),
    });
  }
  return summaries;
}

export async function showWorkflow(
  app: AppContainer,
  idOrSlug: string,
): Promise<{ summary: WorkflowSummary; definition: unknown }> {
  const workflow = await getWorkflow(app.db.kysely, idOrSlug, app.agencyId);
  const latest = await getLatestVersion(app.db.kysely, workflow.id);
  return {
    summary: {
      id: workflow.id,
      slug: workflow.slug,
      name: workflow.name,
      description: workflow.description,
      latestVersion: latest?.version ?? null,
      versionId: latest?.id ?? null,
      checksum: latest?.checksum ?? null,
      createdAt: iso(workflow.created_at),
    },
    definition: latest?.definition ?? workflow.draft_definition,
  };
}
