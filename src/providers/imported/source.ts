import { AppError } from "../../shared/errors.js";
import { sha256Hex } from "../../shared/checksum.js";
import { nameKey, normalizeDomain, normalizeLinkedinUrl, normalizePhone } from "../../engine/records/normalize.js";
import type { ImportRow, SourceProvider, SourceQuery, SourceRecord } from "../types.js";

/**
 * The imported-list source (M4, Workflow 3): free, credential-less, always
 * registered. Rows arrive already validated (importRowSchema) via
 * inputs.importRows — parsed once at preview and bound into the approval
 * hash, so the source never touches the filesystem and a resume replays from
 * durable run state.
 *
 * sourceKey stability matters for dedupe and idempotent re-imports: the same
 * row always yields the same key, preferring strong identifiers over the
 * name hash. An import coverage note is honest by construction — the list
 * covers exactly what it contains.
 */
export class ImportedListSource implements SourceProvider {
  readonly name = "imported-list";

  validateQuery(query: SourceQuery): void {
    if (!query.importRows || query.importRows.length === 0) {
      throw new AppError(
        "VALIDATION_FAILED",
        "The imported-list source needs rows: pass a CSV via --import-csv / importCsv, or inputs.importRows.",
        { provider: this.name },
      );
    }
  }

  search(query: SourceQuery): Promise<{ records: SourceRecord[]; requestId: string; coverageNote?: string }> {
    this.validateQuery(query);
    const rows = query.importRows ?? [];
    const records = rows.slice(0, query.limit).map((row) => toRecord(row));
    const capped = rows.length > query.limit ? ` (capped at limit ${query.limit} of ${rows.length} rows)` : "";
    return Promise.resolve({
      records,
      // Deterministic id: the same accepted rows always replay identically.
      requestId: `imported-list-${sha256Hex(JSON.stringify(rows)).slice(0, 12)}`,
      coverageNote: `Imported list: ${records.length} row(s) accepted${capped}. An imported list covers only what it contains.`,
    });
  }
}

/** Stable identity precedence: domain → linkedin → email → phone → name hash. */
export function importSourceKey(row: ImportRow): string {
  const domain = normalizeDomain(row.website);
  // The domain tier carries a name discriminator: two same-domain rows with
  // DIFFERENT names must stay separate items so dedupe can FLAG them as a
  // conflict (multi-location businesses share websites) — collapsing them
  // here would be a silent merge. Identical rows still collapse.
  if (domain) return row.name ? `import:domain:${domain}:${sha256Hex(nameKey(row.name)).slice(0, 8)}` : `import:domain:${domain}`;
  const linkedin = normalizeLinkedinUrl(row.linkedinUrl);
  if (linkedin) return `import:li:${linkedin.slice("linkedin.com/in/".length)}`;
  const email = row.email?.trim().toLowerCase();
  if (email) return `import:email:${email}`;
  const phone = normalizePhone(row.phone);
  if (phone?.e164) return `import:phone:${phone.e164}`;
  return `import:name:${sha256Hex(nameKey(row.name ?? "")).slice(0, 16)}`;
}

function toRecord(row: ImportRow): SourceRecord {
  return {
    sourceKey: importSourceKey(row),
    // Every accepted row has at least one identifier; fall back through them
    // for a display name.
    name: row.name ?? row.contactName ?? row.website ?? row.email ?? "(imported row)",
    kind: "business",
    website: row.website,
    phone: row.phone,
    email: row.email,
    linkedinUrl: row.linkedinUrl,
    contactName: row.contactName,
    title: row.title,
    address: row.address,
    locality: row.locality,
    region: row.region,
    country: row.country,
  };
}
