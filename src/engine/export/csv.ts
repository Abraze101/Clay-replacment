import { stringify } from "csv-stringify/sync";

/**
 * CSV rendering rules (locked defaults): RFC 4180 CRLF records, UTF-8 BOM,
 * formula neutralization ON (CSV-injection defense), fixed column whitelist —
 * never raw provider payload spill.
 *
 * M5 call-ready shape (schema doc §16): a public business main line, a direct
 * number, and a mobile number are ALWAYS distinct column groups — never
 * conflated. Each group carries the number plus exactly what was checked:
 * `<role>_validation_level` names the DEEPEST check performed
 * (none | format | line_status | identity_match), `<role>_validation_result`
 * its stored outcome, `<role>_last_checked_at` when. A format-only number is
 * visibly level 'format' — it is never presented as verified.
 */
export const EXPORT_COLUMNS = [
  "business_name",
  "category",
  "website",
  "domain",
  "address",
  "locality",
  "region",
  "country",
  "timezone",
  "rating",
  "review_count",
  "business_main_phone",
  "business_main_phone_e164",
  "business_main_line_type",
  "business_main_validation_level",
  "business_main_validation_result",
  "business_main_last_checked_at",
  "direct_phone_e164",
  "direct_line_type",
  "direct_validation_level",
  "direct_validation_result",
  "direct_last_checked_at",
  "mobile_phone_e164",
  "mobile_line_type",
  "mobile_validation_level",
  "mobile_validation_result",
  "mobile_last_checked_at",
  "owner_name",
  "owner_title",
  "work_email",
  "work_email_status",
  "work_email_last_checked_at",
  "verified_email",
  "score",
  "review_status",
  "call_readiness_status",
  "call_readiness_reason",
  "suppression_status",
  "source_provider",
  "source_record_id",
  "source_url",
  "retrieved_at",
  "run_item_id",
] as const;

export type ExportColumn = (typeof EXPORT_COLUMNS)[number];
export type ExportRowData = Record<ExportColumn, string | number | boolean | null>;

export function renderCsv(rows: ExportRowData[]): string {
  return stringify(rows, {
    header: true,
    columns: EXPORT_COLUMNS as unknown as string[],
    bom: true,
    record_delimiter: "\r\n",
    escape_formulas: true,
    cast: {
      boolean: (value) => (value ? "true" : "false"),
    },
  });
}
