import { canonicalJson } from "../../shared/checksum.js";
import { AppError } from "../../shared/errors.js";

/** Milestone 0 seeds exactly one agency with this fixed UUID (schema doc §1). */
export const DEFAULT_AGENCY_ID = "00000000-0000-0000-0000-000000000001";

/**
 * Repository-layer size guard (~8 KB) keeping raw provider payloads out of
 * bounded jsonb columns (`run_items.snapshot`, `run_item_steps.result`).
 */
export const BOUNDED_JSON_LIMIT_BYTES = 8 * 1024;

export function assertBoundedJson(value: unknown, column: string): string {
  const serialized = canonicalJson(value);
  if (Buffer.byteLength(serialized, "utf8") > BOUNDED_JSON_LIMIT_BYTES) {
    throw new AppError("VALIDATION_FAILED", `${column} exceeds the bounded-jsonb limit (${BOUNDED_JSON_LIMIT_BYTES} bytes); raw provider payloads must not be stored here.`, { column });
  }
  return serialized;
}

export function toJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}
