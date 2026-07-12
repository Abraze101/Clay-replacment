import type { Kysely, Selectable } from "kysely";

import type { Database, ExportsTable } from "../database-types.js";
import { toJson } from "./repo-util.js";

export type ExportRow = Selectable<ExportsTable>;

/**
 * Request identity: UNIQUE (run_id, kind, filters_checksum) — a repeated
 * command targets the same row instead of forking files. Correctness is the
 * recomputed dataset_checksum, deliberately NOT this constraint.
 */
export async function upsertExportRequest(
  db: Kysely<Database>,
  input: { runId: string; kind: "csv"; filters: Record<string, unknown>; filtersChecksum: string },
): Promise<ExportRow> {
  const inserted = await db
    .insertInto("exports")
    .values({
      run_id: input.runId,
      kind: input.kind,
      filters: toJson(input.filters),
      filters_checksum: input.filtersChecksum,
    })
    .onConflict((oc) => oc.columns(["run_id", "kind", "filters_checksum"]).doNothing())
    .returningAll()
    .executeTakeFirst();
  if (inserted) return inserted;
  return await db
    .selectFrom("exports")
    .selectAll()
    .where("run_id", "=", input.runId)
    .where("kind", "=", input.kind)
    .where("filters_checksum", "=", input.filtersChecksum)
    .executeTakeFirstOrThrow();
}

export async function completeExport(
  db: Kysely<Database>,
  exportId: string,
  result: { datasetChecksum: string; contentChecksum: string; filePath: string; rowCount: number },
): Promise<void> {
  await db
    .updateTable("exports")
    .set({
      dataset_checksum: result.datasetChecksum,
      content_checksum: result.contentChecksum,
      file_path: result.filePath,
      row_count: result.rowCount,
      status: "completed",
      completed_at: new Date(),
    })
    .where("id", "=", exportId)
    .execute();
}

export async function failExport(db: Kysely<Database>, exportId: string): Promise<void> {
  await db.updateTable("exports").set({ status: "failed" }).where("id", "=", exportId).execute();
}

export async function listExports(db: Kysely<Database>, runId: string): Promise<ExportRow[]> {
  return await db.selectFrom("exports").selectAll().where("run_id", "=", runId).orderBy("created_at").execute();
}
