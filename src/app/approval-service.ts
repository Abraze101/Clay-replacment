import { randomBytes } from "node:crypto";

import type { Kysely } from "kysely";

import type { ResolvedPlan } from "../engine/workflow-schema/plan.js";
import { iso } from "../shared/clock.js";
import { AppError } from "../shared/errors.js";
import type { Database } from "../storage/database-types.js";
import { toJson } from "../storage/repositories/repo-util.js";

/**
 * Engine-level approval tokens (M1). `run_preview` issues a token bound to
 * the full approval scope — plan hash, profile, overrides, record cap,
 * budget, and estimated paid actions — and `run_start`/`run resume` consume
 * it exactly once. Harness-side approval prompts are a courtesy; this
 * registry is the enforcement.
 */

export interface IssuedApproval {
  id: string;
  token: string;
  expiresAt: string;
}

export interface ConsumedApproval {
  id: string;
  expiresAt: string;
  consumedAt: string;
}

export async function issueApprovalToken(
  db: Kysely<Database>,
  args: {
    agencyId: string;
    workflowVersionId: string;
    plan: ResolvedPlan;
    ttlMinutes: number;
  },
): Promise<IssuedApproval> {
  const token = `apv_${randomBytes(24).toString("base64url")}`;
  const expiresAt = new Date(Date.now() + args.ttlMinutes * 60_000);
  const row = await db
    .insertInto("approval_tokens")
    .values({
      agency_id: args.agencyId,
      workflow_version_id: args.workflowVersionId,
      nonce: token,
      scope_hash: args.plan.planHash,
      enrichment_profile: args.plan.profile,
      overrides: toJson(args.plan.overrides),
      paid_record_cap: args.plan.paidRecordCap,
      credit_limit: args.plan.creditLimit,
      estimated_paid_actions: toJson(args.plan.estimatedPaidActions),
      expires_at: expiresAt,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return { id: row.id, token, expiresAt: expiresAt.toISOString() };
}

/**
 * Consume a token for the recomputed plan hash. Order matters:
 * 1. unknown nonce            → APPROVAL_REQUIRED (no token was issued for this);
 * 2. scope hash differs       → APPROVAL_MISMATCH (scope changed; the token is NOT burned);
 * 3. atomic UPDATE … WHERE consumed_at IS NULL AND expires_at > now()
 *    loses                    → APPROVAL_CONSUMED or APPROVAL_EXPIRED.
 */
export async function consumeApprovalToken(
  db: Kysely<Database>,
  token: string,
  expectedPlanHash: string,
): Promise<ConsumedApproval> {
  const row = await db.selectFrom("approval_tokens").selectAll().where("nonce", "=", token).executeTakeFirst();
  if (!row) {
    throw new AppError(
      "APPROVAL_REQUIRED",
      "Unknown approval token. Run 'run_preview' and pass the token it issues.",
      {},
    );
  }
  if (row.scope_hash !== expectedPlanHash) {
    throw new AppError(
      "APPROVAL_MISMATCH",
      "Approval token does not match the current plan (workflow version, inputs, profile, overrides, cap, or budget changed). Preview again and approve the new plan.",
      { expected: expectedPlanHash },
    );
  }
  const consumedAt = new Date();
  const updated = await db
    .updateTable("approval_tokens")
    .set({ consumed_at: consumedAt })
    .where("id", "=", row.id)
    .where("consumed_at", "is", null)
    .where("expires_at", ">", consumedAt)
    .returning(["id", "expires_at"])
    .executeTakeFirst();
  if (!updated) {
    // Re-read: a concurrent consumer may have won between the SELECT and UPDATE.
    const fresh = await db
      .selectFrom("approval_tokens")
      .select(["consumed_at", "expires_at"])
      .where("id", "=", row.id)
      .executeTakeFirst();
    if (fresh?.consumed_at) {
      throw new AppError(
        "APPROVAL_CONSUMED",
        "Approval token was already consumed; each start needs a fresh preview and token.",
        { consumedAt: iso(fresh.consumed_at) },
      );
    }
    throw new AppError("APPROVAL_EXPIRED", "Approval token expired. Preview again for a fresh token.", {
      expiredAt: iso(fresh?.expires_at ?? row.expires_at),
    });
  }
  const expiresAtIso = iso(updated.expires_at);
  return {
    id: updated.id,
    expiresAt: expiresAtIso ?? consumedAt.toISOString(),
    consumedAt: consumedAt.toISOString(),
  };
}

/** Record which run consumed the token (set in the same transaction as run creation). */
export async function linkApprovalToRun(db: Kysely<Database>, tokenId: string, runId: string): Promise<void> {
  await db.updateTable("approval_tokens").set({ consumed_by_run_id: runId }).where("id", "=", tokenId).execute();
}
