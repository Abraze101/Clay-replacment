import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { checksumOf, sha256Hex } from "../../shared/checksum.js";
import { iso } from "../../shared/clock.js";
import { AppError } from "../../shared/errors.js";
import type { Db } from "../../storage/db.js";
import { num } from "../../storage/database-types.js";
import { getLead, listContactPoints } from "../../storage/repositories/lead-repo.js";
import { completeExport, upsertExportRequest } from "../../storage/repositories/export-repo.js";
import { getRun, listRunItems } from "../../storage/repositories/run-repo.js";
import type { ExportRowData } from "./csv.js";
import { renderCsv } from "./csv.js";

export interface ExportResult {
  exportId: string;
  filePath: string;
  rowCount: number;
  datasetChecksum: string;
  contentChecksum: string;
  noop: boolean;
}

/**
 * Materialize the reviewed result set as CSV.
 *
 * Correctness rule (schema doc §16): request identity is (run, kind, filters);
 * the no-op decision is the recomputed dataset_checksum over the ordered
 * selected row set PLUS a content match of the on-disk file. A new review
 * decision always produces a fresh file. `--force` is a manual override,
 * never the correctness mechanism. The export executor independently asserts
 * review-gate passage (REVIEW_REQUIRED) — it never trusts the caller.
 */
export async function exportRun(
  db: Db,
  args: { runId: string; exportDir: string; force?: boolean },
): Promise<ExportResult> {
  const run = await getRun(db.kysely, args.runId);
  if (!run.review_gate_passed_at) {
    throw new AppError("REVIEW_REQUIRED", "Export requires the run to have passed its review gate.", {
      runId: args.runId,
    });
  }

  const filters = { reviewStatus: "approved" as const };
  const filtersChecksum = checksumOf(filters);
  const exportRow = await upsertExportRequest(db.kysely, {
    runId: args.runId,
    kind: "csv",
    filters,
    filtersChecksum,
  });

  // Selection: approved, completed items, oldest-first by (position, id) —
  // the M0 quick-list ordering rule. (M5 adds suppression/line-status rules.)
  const items = await listRunItems(db.kysely, args.runId, { reviewStatuses: ["approved"] });
  const selected = items.filter((i) => i.status === "completed" && i.lead_id !== null);

  const rows: ExportRowData[] = [];
  const datasetBasis: unknown[] = [];
  for (const item of selected) {
    const lead = await getLead(db.kysely, item.lead_id as string);
    if (!lead) continue;
    const contactPoints = await listContactPoints(db.kysely, lead.id);
    const businessMain = contactPoints.find((cp) => cp.type === "phone" && cp.role === "business_main");
    const direct = contactPoints.find((cp) => cp.type === "phone" && cp.role === "direct");
    const workEmail = contactPoints.find((cp) => cp.type === "email" && cp.role === "work");
    const snapshot = item.snapshot as {
      enrichment?: { personName?: string; title?: string };
      sourceRetrievedAt?: string;
    };

    rows.push({
      business_name: lead.display_name,
      category: lead.category,
      website: lead.website_url,
      domain: lead.normalized_domain,
      address: lead.address_line,
      locality: lead.locality,
      region: lead.region,
      country: lead.country,
      business_main_phone: businessMain?.raw_value ?? null,
      business_main_phone_e164: businessMain?.normalized_value ?? null,
      business_main_phone_format_valid: businessMain ? (businessMain.format_valid ?? null) : null,
      business_main_phone_format_checked_at: iso(businessMain?.format_checked_at ?? null),
      owner_name: snapshot.enrichment?.personName ?? null,
      owner_title: snapshot.enrichment?.title ?? null,
      direct_phone_e164: direct?.normalized_value ?? null,
      direct_phone_format_valid: direct ? (direct.format_valid ?? null) : null,
      work_email: workEmail?.normalized_value ?? null,
      work_email_status: workEmail?.email_status ?? null,
      score: item.score === null ? null : num(item.score),
      review_status: item.review_status,
      // Suppression evaluation arrives at M5; 'unchecked' is never rendered as cleared.
      suppression_status: "unchecked",
      source_provider: lead.source_provider,
      source_record_id: lead.source_provider_id,
      retrieved_at: snapshot.sourceRetrievedAt ?? null,
      run_item_id: item.id,
    });

    datasetBasis.push({
      runItemId: item.id,
      reviewStatus: item.review_status,
      score: item.score === null ? null : num(item.score),
      leadId: lead.id,
      suppression: "unchecked",
      contactPoints: contactPoints
        .map((cp) => ({
          id: cp.id,
          type: cp.type,
          role: cp.role,
          normalizedValue: cp.normalized_value,
          formatValid: cp.format_valid,
          formatCheckedAt: iso(cp.format_checked_at),
          emailStatus: cp.email_status,
        }))
        .sort((a, b) => (a.id < b.id ? -1 : 1)),
    });
  }

  const datasetChecksum = checksumOf(datasetBasis);
  const filePath = path.resolve(args.exportDir, `run-${args.runId}.csv`);

  if (!args.force && exportRow.status === "completed" && exportRow.dataset_checksum === datasetChecksum) {
    const onDisk = await readFile(filePath, "utf8").catch(() => null);
    if (onDisk !== null && sha256Hex(onDisk) === exportRow.content_checksum) {
      return {
        exportId: exportRow.id,
        filePath,
        rowCount: exportRow.row_count ?? rows.length,
        datasetChecksum,
        contentChecksum: exportRow.content_checksum ?? "",
        noop: true,
      };
    }
  }

  const csv = renderCsv(rows);
  const contentChecksum = sha256Hex(csv);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, csv, "utf8");
  await completeExport(db.kysely, exportRow.id, {
    datasetChecksum,
    contentChecksum,
    filePath,
    rowCount: rows.length,
  });

  return { exportId: exportRow.id, filePath, rowCount: rows.length, datasetChecksum, contentChecksum, noop: false };
}
