import type { ExpressionBuilder, Kysely, Selectable } from "kysely";

import type { Database, SuppressionScope, SuppressionsTable } from "../database-types.js";

export type SuppressionRow = Selectable<SuppressionsTable>;

/**
 * Entity-specific do-not-contact registry (0005_m5). Values arrive already
 * normalized (E.164 / lowercase email / registrable domain / lead uuid text).
 * Release is an UPDATE, never a DELETE — history stays; the partial unique
 * index on active rows lets a released value be re-suppressed as a new row.
 */
export async function addSuppression(
  db: Kysely<Database>,
  input: {
    agencyId: string;
    scope: SuppressionScope;
    normalizedValue: string;
    reason: string;
    requestedBy: string;
  },
): Promise<SuppressionRow> {
  const inserted = await db
    .insertInto("suppressions")
    .values({
      agency_id: input.agencyId,
      scope: input.scope,
      normalized_value: input.normalizedValue,
      reason: input.reason,
      requested_by: input.requestedBy,
    })
    .onConflict((oc) => oc.doNothing())
    .returningAll()
    .executeTakeFirst();
  if (inserted) return inserted;
  // Idempotent re-suppress: the active row already exists; return it unchanged.
  return await db
    .selectFrom("suppressions")
    .selectAll()
    .where("agency_id", "=", input.agencyId)
    .where("scope", "=", input.scope)
    .where("normalized_value", "=", input.normalizedValue)
    .where("released_at", "is", null)
    .executeTakeFirstOrThrow();
}

/** Returns false when the row is unknown or already released (no error — release is idempotent-ish). */
export async function releaseSuppression(
  db: Kysely<Database>,
  input: { id: string; agencyId: string; releasedBy: string },
): Promise<boolean> {
  const result = await db
    .updateTable("suppressions")
    .set({ released_at: new Date(), released_by: input.releasedBy })
    .where("id", "=", input.id)
    .where("agency_id", "=", input.agencyId)
    .where("released_at", "is", null)
    .executeTakeFirst();
  return result.numUpdatedRows > 0n;
}

export async function listSuppressions(
  db: Kysely<Database>,
  agencyId: string,
  opts: { scope?: SuppressionScope; includeReleased?: boolean } = {},
): Promise<SuppressionRow[]> {
  let query = db.selectFrom("suppressions").selectAll().where("agency_id", "=", agencyId);
  if (opts.scope) query = query.where("scope", "=", opts.scope);
  if (!opts.includeReleased) query = query.where("released_at", "is", null);
  return await query.orderBy("created_at", "desc").execute();
}

export interface SuppressionCriteria {
  phones?: string[];
  emails?: string[];
  domains?: string[];
  leadIds?: string[];
}

/**
 * One query over all scopes: which of these normalized identifiers are
 * actively suppressed right now? Used by the call-readiness recompute and by
 * the export-time evaluation (which is never stored — suppressions change
 * after a run, so exports always re-evaluate live).
 */
export async function findActiveSuppressions(
  db: Kysely<Database>,
  agencyId: string,
  criteria: SuppressionCriteria,
): Promise<SuppressionRow[]> {
  const groups: { scope: SuppressionScope; values: string[] }[] = [
    { scope: "phone", values: criteria.phones ?? [] },
    { scope: "email", values: criteria.emails ?? [] },
    { scope: "domain", values: criteria.domains ?? [] },
    { scope: "lead", values: criteria.leadIds ?? [] },
  ].filter((g) => g.values.length > 0) as { scope: SuppressionScope; values: string[] }[];
  if (groups.length === 0) return [];
  return await db
    .selectFrom("suppressions")
    .selectAll()
    .where("agency_id", "=", agencyId)
    .where("released_at", "is", null)
    .where((eb: ExpressionBuilder<Database, "suppressions">) =>
      eb.or(groups.map((g) => eb.and([eb("scope", "=", g.scope), eb("normalized_value", "in", g.values)]))),
    )
    .execute();
}
