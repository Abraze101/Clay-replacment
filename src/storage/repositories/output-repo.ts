import type { Kysely, Selectable } from "kysely";

import type { Database, EvidenceRef, GeneratedOutputsTable, OutputKind } from "../database-types.js";
import { toJson } from "./repo-util.js";

export type GeneratedOutputRow = Selectable<GeneratedOutputsTable>;

/** Append-only: regeneration appends; latest wins by created_at. No UPDATE/DELETE exposed. */
export async function appendGeneratedOutput(
  db: Kysely<Database>,
  output: {
    leadId: string;
    runId: string;
    runItemId?: string | null;
    kind: OutputKind;
    promptVersion: string;
    modelProvider?: string | null;
    model?: string | null;
    content: Record<string, unknown>;
    evidence: EvidenceRef[];
  },
): Promise<GeneratedOutputRow> {
  return await db
    .insertInto("generated_outputs")
    .values({
      lead_id: output.leadId,
      run_id: output.runId,
      run_item_id: output.runItemId ?? null,
      kind: output.kind,
      prompt_version: output.promptVersion,
      model_provider: output.modelProvider ?? null,
      model: output.model ?? null,
      content: toJson(output.content),
      evidence: toJson(output.evidence),
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

export async function latestOutput(
  db: Kysely<Database>,
  runId: string,
  leadId: string,
  kind: OutputKind,
): Promise<GeneratedOutputRow | undefined> {
  return await db
    .selectFrom("generated_outputs")
    .selectAll()
    .where("run_id", "=", runId)
    .where("lead_id", "=", leadId)
    .where("kind", "=", kind)
    .orderBy("created_at", "desc")
    .limit(1)
    .executeTakeFirst();
}

export async function listOutputsForRun(db: Kysely<Database>, runId: string): Promise<GeneratedOutputRow[]> {
  return await db.selectFrom("generated_outputs").selectAll().where("run_id", "=", runId).execute();
}
