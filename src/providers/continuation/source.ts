import type { Kysely } from "kysely";

import { AppError } from "../../shared/errors.js";
import type { Database } from "../../storage/database-types.js";
import type { SourceProvider, SourceQuery, SourceRecord } from "../types.js";

/**
 * Selected-lead continuation source (M5): re-emits the persisted source
 * records of a prior run's APPROVED leads straight from the database — zero
 * provider calls, zero credits. Each record keeps its ORIGINAL sourceKey, so
 * normalize replays deterministically and dedupe re-attaches every lead as
 * 'matched' instead of creating duplicates. The lead-id set is resolved at
 * preview from durable review state and bound into the approval plan hash
 * (the importRows pattern): a review flip between preview and start yields a
 * different hash and APPROVAL_MISMATCH by construction.
 */
export class RunContinuationSource implements SourceProvider {
  readonly name = "run-continuation";

  constructor(private readonly db: Kysely<Database>) {}

  validateQuery(query: SourceQuery): void {
    if (!query.continuation) {
      throw new AppError(
        "VALIDATION_FAILED",
        "The run-continuation source needs inputs.continueFromRunId (the prior run whose approved leads continue).",
        {},
      );
    }
    if (query.continuation.leadIds.length === 0) {
      throw new AppError("VALIDATION_FAILED", "Continuation has no approved leads to continue.", {
        runId: query.continuation.runId,
      });
    }
    if (query.importRows !== undefined) {
      throw new AppError("VALIDATION_FAILED", "A continuation run cannot also import rows.", {});
    }
  }

  async search(query: SourceQuery): Promise<{ records: SourceRecord[]; requestId: string; coverageNote?: string }> {
    const continuation = query.continuation;
    if (!continuation) throw new AppError("INTERNAL", "run-continuation searched without continuation inputs.", {});

    const run = await this.db
      .selectFrom("runs")
      .select(["id"])
      .where("id", "=", continuation.runId)
      .executeTakeFirst();
    if (!run) {
      throw new AppError("NOT_FOUND", `Continuation source: prior run '${continuation.runId}' not found.`, {});
    }

    const items = await this.db
      .selectFrom("run_items")
      .select(["lead_id", "source_key", "position", "snapshot"])
      .where("run_id", "=", continuation.runId)
      .where("lead_id", "in", continuation.leadIds)
      .orderBy("position")
      .execute();

    const records: SourceRecord[] = [];
    for (const item of items) {
      const source = (item.snapshot as { source?: SourceRecord }).source;
      if (!source) continue; // defensive: an item without a persisted source record cannot be re-emitted
      records.push(source);
    }
    return {
      records,
      requestId: `continuation-${continuation.runId}`,
      coverageNote: `Continuation of run ${continuation.runId}: ${records.length} approved lead(s); source is free (no provider calls).`,
    };
  }
}
