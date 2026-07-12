import type { Kysely, Selectable } from "kysely";

import { checksumOf } from "../../shared/checksum.js";
import { AppError } from "../../shared/errors.js";
import type { Database, WorkflowsTable, WorkflowVersionsTable } from "../database-types.js";
import { toJson } from "./repo-util.js";

export type WorkflowRow = Selectable<WorkflowsTable>;
export type WorkflowVersionRow = Selectable<WorkflowVersionsTable>;

/**
 * Workflows hold the editable draft; workflow_versions are immutable validated
 * configurations. This repository intentionally exposes NO update path for
 * workflow_versions (immutability by construction, tested).
 */
export async function createWorkflow(
  db: Kysely<Database>,
  input: { agencyId: string; slug: string; name: string; description?: string; draft: unknown },
): Promise<WorkflowRow> {
  const existing = await findWorkflowBySlug(db, input.agencyId, input.slug);
  if (existing) {
    throw new AppError("CONFLICT", `An active workflow with slug '${input.slug}' already exists.`, {
      slug: input.slug,
    });
  }
  return await db
    .insertInto("workflows")
    .values({
      agency_id: input.agencyId,
      slug: input.slug,
      name: input.name,
      description: input.description ?? null,
      draft_definition: toJson(input.draft),
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

export async function updateDraft(db: Kysely<Database>, workflowId: string, draft: unknown): Promise<void> {
  await db
    .updateTable("workflows")
    .set({ draft_definition: toJson(draft), updated_at: new Date() })
    .where("id", "=", workflowId)
    .execute();
}

export async function findWorkflowBySlug(
  db: Kysely<Database>,
  agencyId: string,
  slug: string,
): Promise<WorkflowRow | undefined> {
  return await db
    .selectFrom("workflows")
    .selectAll()
    .where("agency_id", "=", agencyId)
    .where("slug", "=", slug)
    .where("archived_at", "is", null)
    .executeTakeFirst();
}

export async function getWorkflow(db: Kysely<Database>, idOrSlug: string, agencyId: string): Promise<WorkflowRow> {
  const bySlug = await findWorkflowBySlug(db, agencyId, idOrSlug);
  if (bySlug) return bySlug;
  const byId = UUID_RE.test(idOrSlug)
    ? await db.selectFrom("workflows").selectAll().where("id", "=", idOrSlug).executeTakeFirst()
    : undefined;
  if (!byId) throw new AppError("NOT_FOUND", `Workflow '${idOrSlug}' not found.`, { workflow: idOrSlug });
  return byId;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function listWorkflows(db: Kysely<Database>, agencyId: string): Promise<WorkflowRow[]> {
  return await db
    .selectFrom("workflows")
    .selectAll()
    .where("agency_id", "=", agencyId)
    .where("archived_at", "is", null)
    .orderBy("created_at")
    .execute();
}

/**
 * Create the next immutable version from a validated definition. Re-validating
 * an identical draft returns the existing version instead of forking a new one
 * (version numbering is the immutability contract).
 */
export async function createVersion(
  db: Kysely<Database>,
  workflowId: string,
  definition: unknown,
): Promise<WorkflowVersionRow> {
  const checksum = checksumOf(definition);
  const latest = await db
    .selectFrom("workflow_versions")
    .selectAll()
    .where("workflow_id", "=", workflowId)
    .orderBy("version", "desc")
    .limit(1)
    .executeTakeFirst();
  if (latest && latest.checksum === checksum) return latest;

  const nextVersion = (latest?.version ?? 0) + 1;
  return await db
    .insertInto("workflow_versions")
    .values({
      workflow_id: workflowId,
      version: nextVersion,
      definition: toJson(definition),
      checksum,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

export async function getVersion(db: Kysely<Database>, versionId: string): Promise<WorkflowVersionRow> {
  const row = await db.selectFrom("workflow_versions").selectAll().where("id", "=", versionId).executeTakeFirst();
  if (!row) throw new AppError("NOT_FOUND", `Workflow version ${versionId} not found.`, { versionId });
  return row;
}

export async function getLatestVersion(
  db: Kysely<Database>,
  workflowId: string,
): Promise<WorkflowVersionRow | undefined> {
  return await db
    .selectFrom("workflow_versions")
    .selectAll()
    .where("workflow_id", "=", workflowId)
    .orderBy("version", "desc")
    .limit(1)
    .executeTakeFirst();
}
