import { createHash } from "node:crypto";

/**
 * Deterministic JSON serialization: object keys sorted at every depth so the
 * same logical value always yields the same string (and therefore the same
 * checksum), independent of insertion order.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(entries.map(([k, v]) => [k, sortValue(v)]));
  }
  return value;
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/** sha256 over the canonical JSON form of a value. */
export function checksumOf(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}
