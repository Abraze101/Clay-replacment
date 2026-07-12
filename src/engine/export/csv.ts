import { stringify } from "csv-stringify/sync";

/**
 * CSV rendering rules (locked defaults): RFC 4180 CRLF records, UTF-8 BOM,
 * formula neutralization ON (CSV-injection defense), fixed column whitelist —
 * never raw provider payload spill.
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
  "business_main_phone",
  "business_main_phone_e164",
  "business_main_phone_format_valid",
  "business_main_phone_format_checked_at",
  "owner_name",
  "owner_title",
  "direct_phone_e164",
  "direct_phone_format_valid",
  "work_email",
  "work_email_status",
  "score",
  "review_status",
  "suppression_status",
  "source_provider",
  "source_record_id",
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
