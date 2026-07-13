import { parse } from "csv-parse/sync";
import { z } from "zod";

import { AppError } from "../../shared/errors.js";
import type { ImportRow } from "../../providers/types.js";

/**
 * Bounded, typed CSV import for the imported-list workflow (ADR-019:
 * csv-parse v7, sync API over inline text — streaming is unnecessary under
 * the 512 KiB ceiling). Structural problems fail the WHOLE file with a
 * machine-readable VALIDATION_FAILED (unknown headers listed, inconsistent
 * column counts with their line number, too many rows, zero accepted rows);
 * row-level problems reject ONLY that row, bounded and visible (first 20
 * detailed, all counted). Accepted rows only are what the approval hash
 * binds. No arbitrary columns: silently dropping data would hide loss.
 */
export const IMPORT_MAX_ROWS = 500;
export const IMPORT_MAX_BYTES = 512 * 1024;
const MAX_DETAILED_REJECTS = 20;

export const importRowSchema = z
  .object({
    name: z.string().trim().min(1).max(300).optional(),
    website: z.string().trim().min(1).max(500).optional(),
    phone: z.string().trim().min(1).max(50).optional(),
    email: z.string().trim().min(1).max(320).optional(),
    linkedinUrl: z.string().trim().min(1).max(500).optional(),
    contactName: z.string().trim().min(1).max(200).optional(),
    title: z.string().trim().min(1).max(200).optional(),
    address: z.string().trim().min(1).max(300).optional(),
    locality: z.string().trim().min(1).max(120).optional(),
    region: z.string().trim().min(1).max(120).optional(),
    country: z.string().trim().min(1).max(120).optional(),
  })
  .strict()
  .refine((r) => r.name || r.website || r.email || r.linkedinUrl, {
    message: "row needs at least one identifier: company/name, website/domain, email, or linkedin_url",
  });
// The Zod schema is the source of truth; the neutral ImportRow interface in
// providers/types.ts must stay assignable from it (compile-time check only).
type AssertAssignable<T extends ImportRow> = T;
export type ImportRowSchemaCheck = AssertAssignable<z.infer<typeof importRowSchema>>;

/** Case-insensitive header aliases → canonical ImportRow field. */
const HEADER_ALIASES: Record<string, keyof ImportRow | "first_name" | "last_name"> = {
  name: "name",
  company: "name",
  company_name: "name",
  business: "name",
  business_name: "name",
  organization: "name",
  website: "website",
  url: "website",
  domain: "website",
  company_website: "website",
  phone: "phone",
  phone_number: "phone",
  email: "email",
  work_email: "email",
  linkedin: "linkedinUrl",
  linkedin_url: "linkedinUrl",
  contact: "contactName",
  contact_name: "contactName",
  full_name: "contactName",
  first_name: "first_name",
  last_name: "last_name",
  title: "title",
  job_title: "title",
  role: "title",
  address: "address",
  street: "address",
  city: "locality",
  locality: "locality",
  state: "region",
  region: "region",
  country: "country",
};

export interface ImportParseResult {
  rows: ImportRow[];
  /** First MAX_DETAILED_REJECTS row-level rejects; rejectedCount has them all. */
  rejected: { line: number; reason: string }[];
  rejectedCount: number;
  warnings: string[];
}

function normalizeHeader(raw: string): string {
  return raw
    .replace(/^\uFEFF/, "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

export function parseImportCsv(text: string): ImportParseResult {
  if (Buffer.byteLength(text, "utf8") > IMPORT_MAX_BYTES) {
    throw new AppError("VALIDATION_FAILED", `Import CSV exceeds ${IMPORT_MAX_BYTES / 1024} KiB.`, {
      maxBytes: IMPORT_MAX_BYTES,
    });
  }

  const unknownHeaders: string[] = [];
  let rawRows: Record<string, string>[];
  try {
    rawRows = parse(text, {
      bom: true,
      trim: true,
      skip_empty_lines: true,
      relax_column_count: false,
      columns: (headerRow: string[]) =>
        headerRow.map((raw) => {
          const canonical = HEADER_ALIASES[normalizeHeader(raw)];
          if (!canonical) {
            unknownHeaders.push(raw.trim());
            return "__unknown__";
          }
          return canonical;
        }),
    });
  } catch (err) {
    const detail = err as { code?: string; lines?: number; message?: string };
    throw new AppError("VALIDATION_FAILED", `Import CSV could not be parsed: ${detail.message ?? String(err)}`, {
      code: detail.code ?? "CSV_PARSE_ERROR",
      ...(detail.lines !== undefined ? { line: detail.lines } : {}),
    });
  }

  if (unknownHeaders.length > 0) {
    // Silently dropping a column hides data loss; name the offenders instead.
    throw new AppError("VALIDATION_FAILED", `Import CSV has unrecognized column header(s): ${unknownHeaders.join(", ")}.`, {
      unknownHeaders,
      knownHeaders: Object.keys(HEADER_ALIASES),
    });
  }
  if (rawRows.length > IMPORT_MAX_ROWS) {
    throw new AppError("VALIDATION_FAILED", `Import CSV has ${rawRows.length} data rows; the maximum is ${IMPORT_MAX_ROWS}.`, {
      rows: rawRows.length,
      maxRows: IMPORT_MAX_ROWS,
    });
  }

  const rows: ImportRow[] = [];
  const rejected: { line: number; reason: string }[] = [];
  let rejectedCount = 0;
  const warnings: string[] = [];

  rawRows.forEach((raw, i) => {
    const line = i + 2; // 1-based, after the header row
    const candidate: Record<string, string> = {};
    for (const [key, value] of Object.entries(raw)) {
      if (key === "__unknown__" || value === undefined || value.trim() === "") continue;
      candidate[key] = value;
    }
    // first_name/last_name combine into contactName (explicit contact wins).
    const first = candidate["first_name"];
    const last = candidate["last_name"];
    delete candidate["first_name"];
    delete candidate["last_name"];
    if (!candidate["contactName"] && (first || last)) {
      candidate["contactName"] = [first, last].filter(Boolean).join(" ");
    }
    // A non-LinkedIn value in the linkedin column is dropped (row kept): it is
    // an identifier column, and the guardrail allows only real profile URLs.
    if (candidate["linkedinUrl"] && !/linkedin\.com/i.test(candidate["linkedinUrl"])) {
      warnings.push(`line ${line}: ignored non-LinkedIn value in the linkedin column`);
      delete candidate["linkedinUrl"];
    }

    const parsed = importRowSchema.safeParse(candidate);
    if (!parsed.success) {
      rejectedCount += 1;
      if (rejected.length < MAX_DETAILED_REJECTS) {
        rejected.push({ line, reason: parsed.error.issues[0]?.message ?? "invalid row" });
      }
      return;
    }
    rows.push(parsed.data);
  });

  if (rows.length === 0) {
    throw new AppError("VALIDATION_FAILED", "Import CSV contains no usable rows.", {
      rejectedCount,
      rejected: rejected.slice(0, MAX_DETAILED_REJECTS),
    });
  }
  if (rejectedCount > 0) {
    warnings.push(
      `Accepted ${rows.length} of ${rows.length + rejectedCount} rows; ${rejectedCount} rejected (first ${Math.min(
        rejectedCount,
        MAX_DETAILED_REJECTS,
      )} detailed).`,
    );
  }
  return { rows, rejected, rejectedCount, warnings };
}
