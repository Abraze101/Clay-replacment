import type { Kysely, Selectable } from "kysely";

import type { Database, IdentifierType, IdentityConflictsTable } from "../database-types.js";

export type IdentityConflictRow = Selectable<IdentityConflictsTable>;

/**
 * Persist a "flag, do not merge automatically" record (M4). The pair is
 * canonicalized to satisfy identity_conflicts_ordered_ck (lead_id_a <
 * lead_id_b; lowercase-canonical uuid string order matches Postgres uuid
 * byte order), and ON CONFLICT DO NOTHING makes a retried dedupe/enrich step
 * re-raise the same conflict as a no-op. M4 writes only 'open' rows; there is
 * deliberately no resolve/merge writer here.
 */
export async function insertIdentityConflict(
  db: Kysely<Database>,
  conflict: {
    leadIdA: string;
    leadIdB: string;
    identifierType: IdentifierType;
    identifierValue: string;
    runId?: string | null;
  },
): Promise<void> {
  const first = conflict.leadIdA.toLowerCase();
  const second = conflict.leadIdB.toLowerCase();
  if (first === second) return;
  const [a, b] = first < second ? [first, second] : [second, first];
  await db
    .insertInto("identity_conflicts")
    .values({
      lead_id_a: a,
      lead_id_b: b,
      identifier_type: conflict.identifierType,
      identifier_value: conflict.identifierValue,
      run_id: conflict.runId ?? null,
    })
    .onConflict((oc) => oc.doNothing())
    .execute();
}

export async function listConflictsForRun(db: Kysely<Database>, runId: string): Promise<IdentityConflictRow[]> {
  return await db
    .selectFrom("identity_conflicts")
    .selectAll()
    .where("run_id", "=", runId)
    .orderBy("detected_at")
    .execute();
}

export async function listOpenConflictsForLead(db: Kysely<Database>, leadId: string): Promise<IdentityConflictRow[]> {
  return await db
    .selectFrom("identity_conflicts")
    .selectAll()
    .where("status", "=", "open")
    .where((eb) => eb.or([eb("lead_id_a", "=", leadId), eb("lead_id_b", "=", leadId)]))
    .orderBy("detected_at")
    .execute();
}
