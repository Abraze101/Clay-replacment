import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { checksumOf, sha256Hex } from "../../shared/checksum.js";
import { iso } from "../../shared/clock.js";
import { AppError } from "../../shared/errors.js";
import type { Db } from "../../storage/db.js";
import { num } from "../../storage/database-types.js";
import type { ContactPointRow } from "../../storage/repositories/lead-repo.js";
import { getLead, listContactPoints } from "../../storage/repositories/lead-repo.js";
import { completeExport, upsertExportRequest } from "../../storage/repositories/export-repo.js";
import { findActiveSuppressions } from "../../storage/repositories/suppression-repo.js";
import { getRun, listRunItems } from "../../storage/repositories/run-repo.js";
import { acceptedPhoneRoles } from "../policy/call-readiness.js";
import type { PlanPolicy } from "../workflow-schema/plan.js";
import type { ExportRowData } from "./csv.js";
import { renderCsv } from "./csv.js";

const DEFAULT_EXPORT_POLICY: PlanPolicy = {
  requireDirectPhone: false,
  acceptBusinessMainPhone: true,
  acceptCatchAllEmail: false,
  phoneValidationRequested: false,
  emailVerificationRequested: false,
};

export interface ExportResult {
  exportId: string;
  filePath: string;
  rowCount: number;
  datasetChecksum: string;
  contentChecksum: string;
  noop: boolean;
}

type PhoneRoleGroup = "business_main" | "direct" | "mobile";

interface PhonePick {
  raw: string | null;
  e164: string | null;
  lineType: string | null;
  validationLevel: "none" | "format" | "line_status" | "identity_match";
  validationResult: string | null;
  lastCheckedAt: string | null;
  contactPointId: string | null;
}

const EMPTY_PICK: PhonePick = {
  raw: null,
  e164: null,
  lineType: null,
  validationLevel: "none",
  validationResult: null,
  lastCheckedAt: null,
  contactPointId: null,
};

function describeValidation(cp: ContactPointRow): Pick<PhonePick, "validationLevel" | "validationResult" | "lastCheckedAt"> {
  // Deepest check performed wins the level; the timestamps stay honest.
  const times = [cp.format_checked_at, cp.line_status_checked_at, cp.identity_match_checked_at]
    .filter((v): v is Date | string => v !== null)
    .map((v) => new Date(v).getTime());
  const lastCheckedAt = times.length > 0 ? iso(new Date(Math.max(...times))) : null;
  if (cp.identity_match_checked_at !== null) {
    return { validationLevel: "identity_match", validationResult: cp.identity_match, lastCheckedAt };
  }
  if (cp.line_status_checked_at !== null) {
    return { validationLevel: "line_status", validationResult: cp.line_status, lastCheckedAt };
  }
  if (cp.format_checked_at !== null) {
    return { validationLevel: "format", validationResult: cp.format_valid ? "valid" : "invalid", lastCheckedAt };
  }
  return { validationLevel: "none", validationResult: null, lastCheckedAt: null };
}

function isDisqualifiedPhone(cp: ContactPointRow): boolean {
  return cp.line_status === "inactive" || cp.line_status === "unreachable" || cp.identity_match === "mismatch";
}

/**
 * Pick one number per role group: suppressed and affirmatively-disqualified
 * numbers never export (retained in the database untouched); within the rest,
 * validated-active first, then format-valid, then most recently checked. On
 * legacy (pre-capability) rows a format-invalid number may still surface —
 * visibly labeled level 'format' / result 'invalid' — so quick lists keep
 * their source phones; capability rows drop it.
 */
function pickPhone(
  contactPoints: ContactPointRow[],
  role: PhoneRoleGroup,
  suppressedValues: Set<string>,
  capabilityRow: boolean,
): PhonePick {
  const candidates = contactPoints
    .filter((cp) => cp.type === "phone" && cp.role === role)
    .filter((cp) => cp.normalized_value === null || !suppressedValues.has(cp.normalized_value))
    .filter((cp) => !isDisqualifiedPhone(cp))
    .filter((cp) => !capabilityRow || (cp.format_valid !== false && cp.normalized_value !== null))
    .sort((a, b) => {
      const active = Number(b.line_status === "active") - Number(a.line_status === "active");
      if (active !== 0) return active;
      const format = Number(b.format_valid === true) - Number(a.format_valid === true);
      if (format !== 0) return format;
      const ts = (cp: ContactPointRow): number => {
        const v = cp.line_status_checked_at ?? cp.format_checked_at;
        return v === null ? -1 : new Date(v).getTime();
      };
      const checked = ts(b) - ts(a);
      if (checked !== 0) return checked;
      return a.id.localeCompare(b.id);
    });
  const cp = candidates[0];
  if (!cp) return EMPTY_PICK;
  return {
    raw: cp.raw_value,
    e164: cp.normalized_value,
    lineType: cp.line_type,
    contactPointId: cp.id,
    ...describeValidation(cp),
  };
}

/**
 * Materialize the reviewed result set as CSV.
 *
 * Correctness rule (schema doc §16): request identity is (run, kind, filters);
 * the no-op decision is the recomputed dataset_checksum over the ordered
 * selected row set PLUS a content match of the on-disk file. Suppressions are
 * evaluated LIVE on every invocation and feed the dataset basis, so a
 * suppression added after the run always re-materializes the file. A new
 * review decision always produces a fresh file. `--force` is a manual
 * override, never the correctness mechanism. The export executor
 * independently asserts review-gate passage (REVIEW_REQUIRED).
 *
 * Row selection: approved + completed, oldest-first by (position, id). Rows
 * whose stored call-readiness is 'invalid', and rows suppressed at export
 * time, are EXCLUDED from the default call-ready export (retained in the
 * database); 'uncertain'/'unchecked' rows stay, visibly labeled. Legacy rows
 * (no capability step ran → NULL readiness) keep the M0 selection.
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

  const items = await listRunItems(db.kysely, args.runId, { reviewStatuses: ["approved"] });
  const baseSelected = items.filter((i) => i.status === "completed" && i.lead_id !== null);
  const capabilityRun = baseSelected.some((i) => i.call_readiness_status !== null);
  const policy = ((run.resolved_plan as { policy?: PlanPolicy }).policy ?? DEFAULT_EXPORT_POLICY);
  const callableRoles = new Set<string>(acceptedPhoneRoles(policy));

  const filters = {
    reviewStatus: "approved" as const,
    selection: capabilityRun ? ("call_ready_default_v1" as const) : ("m0_approved_v1" as const),
  };
  const filtersChecksum = checksumOf(filters);
  const exportRow = await upsertExportRequest(db.kysely, {
    runId: args.runId,
    kind: "csv",
    filters,
    filtersChecksum,
  });

  const rows: ExportRowData[] = [];
  const datasetBasis: unknown[] = [];
  for (const item of baseSelected) {
    const lead = await getLead(db.kysely, item.lead_id as string);
    if (!lead) continue;
    const contactPoints = await listContactPoints(db.kysely, lead.id);

    // LIVE suppression evaluation — never stored; suppressions change after runs.
    const phoneValues = contactPoints
      .filter((cp) => cp.type === "phone" && cp.normalized_value !== null)
      .map((cp) => cp.normalized_value as string);
    const emailValues = contactPoints
      .filter((cp) => cp.type === "email" && cp.normalized_value !== null)
      .map((cp) => cp.normalized_value as string);
    const matches = await findActiveSuppressions(db.kysely, run.agency_id, {
      phones: phoneValues,
      emails: emailValues,
      domains: lead.normalized_domain ? [lead.normalized_domain] : [],
      leadIds: [lead.id],
    });
    const leadScopeSuppressed = matches.some((m) => m.scope === "lead" || m.scope === "domain");
    const suppressedPhones = new Set(matches.filter((m) => m.scope === "phone").map((m) => m.normalized_value));
    const suppressedEmails = new Set(matches.filter((m) => m.scope === "email").map((m) => m.normalized_value));

    const capabilityRow = item.call_readiness_status !== null;
    const allContactsSuppressed =
      (phoneValues.length > 0 || emailValues.length > 0) &&
      phoneValues.every((v) => suppressedPhones.has(v)) &&
      emailValues.every((v) => suppressedEmails.has(v));
    // On a call-ready row the CALLABLE numbers are what matters: when every
    // policy-acceptable number is suppressed, the row is not callable even if
    // an unacceptable line (e.g. a business main under requireDirectPhone)
    // remains unsuppressed.
    const callableValues = contactPoints
      .filter((cp) => cp.type === "phone" && cp.normalized_value !== null && callableRoles.has(cp.role))
      .map((cp) => cp.normalized_value as string);
    const callablesSuppressed =
      capabilityRow && callableValues.length > 0 && callableValues.every((v) => suppressedPhones.has(v));
    const rowSuppressed =
      leadScopeSuppressed || item.call_readiness_status === "suppressed" || allContactsSuppressed || callablesSuppressed;

    // Exclusion from the default call-ready export (retained in the DB):
    // - readiness-invalid rows, only when the campaign requested phone
    //   validation AND the row actually has numbers (their numbers are bad or
    //   unacceptable). A phone-less business stays a usable lead.
    // - rows suppressed at export time (capability runs).
    const hasPhoneContactPoint = contactPoints.some((cp) => cp.type === "phone");
    const excluded =
      (capabilityRow &&
        policy.phoneValidationRequested &&
        item.call_readiness_status === "invalid" &&
        hasPhoneContactPoint) ||
      (capabilityRun && rowSuppressed);

    // Excluded rows still shape the dataset basis: a suppression added after
    // the last export changes the basis and re-materializes the file.
    const basisEntry: Record<string, unknown> = {
      runItemId: item.id,
      reviewStatus: item.review_status,
      excluded,
      suppression: rowSuppressed ? "suppressed" : "cleared",
      callReadinessStatus: item.call_readiness_status,
      callReadinessReason: item.call_readiness_reason,
      score: item.score === null ? null : num(item.score),
      leadId: lead.id,
      verifiedEmail: lead.verified_email,
      timezone: lead.timezone,
      contactPoints: contactPoints
        .map((cp) => ({
          id: cp.id,
          type: cp.type,
          role: cp.role,
          normalizedValue: cp.normalized_value,
          formatValid: cp.format_valid,
          formatCheckedAt: iso(cp.format_checked_at),
          lineType: cp.line_type,
          lineStatus: cp.line_status,
          lineStatusCheckedAt: iso(cp.line_status_checked_at),
          identityMatch: cp.identity_match,
          identityMatchCheckedAt: iso(cp.identity_match_checked_at),
          emailStatus: cp.email_status,
          emailStatusCheckedAt: iso(cp.email_status_checked_at),
          suppressed: cp.normalized_value !== null && (suppressedPhones.has(cp.normalized_value) || suppressedEmails.has(cp.normalized_value)),
        }))
        .sort((a, b) => (a.id < b.id ? -1 : 1)),
    };
    datasetBasis.push(basisEntry);
    if (excluded) continue;

    const businessMain = pickPhone(contactPoints, "business_main", suppressedPhones, capabilityRow);
    const direct = pickPhone(contactPoints, "direct", suppressedPhones, capabilityRow);
    const mobile = pickPhone(contactPoints, "mobile", suppressedPhones, capabilityRow);
    const workEmail = contactPoints.find(
      (cp) =>
        cp.type === "email" &&
        cp.role === "work" &&
        (cp.normalized_value === null || !suppressedEmails.has(cp.normalized_value)),
    );
    const snapshot = item.snapshot as {
      enrichment?: { personName?: string; title?: string };
      sourceRetrievedAt?: string;
      source?: { sourceUrl?: string };
      normalized?: { rating?: number | null; reviewCount?: number | null };
    };
    const rating = snapshot.normalized?.rating ?? null;
    const reviewCount = snapshot.normalized?.reviewCount ?? null;
    const sourceUrl = snapshot.source?.sourceUrl ?? null;

    rows.push({
      business_name: lead.display_name,
      category: lead.category,
      website: lead.website_url,
      domain: lead.normalized_domain,
      address: lead.address_line,
      locality: lead.locality,
      region: lead.region,
      country: lead.country,
      timezone: lead.timezone,
      rating,
      review_count: reviewCount,
      business_main_phone: businessMain.raw,
      business_main_phone_e164: businessMain.e164,
      business_main_line_type: businessMain.lineType,
      business_main_validation_level: businessMain.validationLevel,
      business_main_validation_result: businessMain.validationResult,
      business_main_last_checked_at: businessMain.lastCheckedAt,
      direct_phone_e164: direct.e164,
      direct_line_type: direct.lineType,
      direct_validation_level: direct.validationLevel,
      direct_validation_result: direct.validationResult,
      direct_last_checked_at: direct.lastCheckedAt,
      mobile_phone_e164: mobile.e164,
      mobile_line_type: mobile.lineType,
      mobile_validation_level: mobile.validationLevel,
      mobile_validation_result: mobile.validationResult,
      mobile_last_checked_at: mobile.lastCheckedAt,
      owner_name: snapshot.enrichment?.personName ?? null,
      owner_title: snapshot.enrichment?.title ?? null,
      work_email: workEmail?.normalized_value ?? null,
      work_email_status: workEmail?.email_status ?? null,
      work_email_last_checked_at: iso(workEmail?.email_status_checked_at ?? null),
      verified_email: lead.verified_email,
      score: item.score === null ? null : num(item.score),
      review_status: item.review_status,
      call_readiness_status: item.call_readiness_status,
      call_readiness_reason: item.call_readiness_reason,
      // Computed at export time from the LIVE suppression list, never stored;
      // 'cleared' only because the identifiers were actually evaluated above.
      suppression_status: rowSuppressed ? "suppressed" : "cleared",
      source_provider: lead.source_provider,
      source_record_id: lead.source_provider_id,
      source_url: sourceUrl,
      retrieved_at: snapshot.sourceRetrievedAt ?? null,
      run_item_id: item.id,
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
