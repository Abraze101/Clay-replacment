import { sha256Hex } from "../../shared/checksum.js";
import { nameKey, normalizeText } from "../../engine/records/normalize.js";
import type { SerpApiLocalResult } from "./client.js";

/**
 * Stable per-listing identity. Google's `place_id` (ChIJ…) is SerpAPI's
 * recommended stable reference and the natural fit for leads.place_id; the
 * numeric CID (`data_cid`) is retained in the snapshot. When neither is
 * present, fall back to a deterministic hash of the normalized name + address.
 */
export function extractSourceKey(result: SerpApiLocalResult): string {
  if (result.place_id) return `pid:${result.place_id}`;
  if (result.data_cid) return `cid:${result.data_cid}`;
  const basis = `${nameKey(result.title)}|${normalizeText(result.address) ?? ""}`;
  return `nk:${sha256Hex(basis)}`;
}

/** The bare Google place_id for leads.place_id (null unless the key is a `pid:`). */
export function placeIdFromSourceKey(sourceKey: string): string | null {
  return sourceKey.startsWith("pid:") ? sourceKey.slice("pid:".length) : null;
}

export interface ParsedAddress {
  addressLine: string | null;
  locality: string | null;
  region: string | null;
  country: string | null;
}

const US_STATE_ZIP = /^([A-Z]{2})\s+\d{5}(?:-\d{4})?$/;

/**
 * Best-effort parse of a US Maps address string, e.g.
 * "18 W 29th St, New York, NY 10001, United States" -> { locality: "New York",
 * region: "NY", country: "United States" }. Returns nulls for fields that do
 * not confidently parse — never guesses.
 */
export function parseUsAddress(address: string | undefined): ParsedAddress {
  const line = normalizeText(address);
  if (!line) return { addressLine: null, locality: null, region: null, country: null };
  const parts = line.split(",").map((p) => p.trim()).filter((p) => p.length > 0);
  let locality: string | null = null;
  let region: string | null = null;
  let country: string | null = null;

  for (let i = 0; i < parts.length; i += 1) {
    const match = US_STATE_ZIP.exec(parts[i] ?? "");
    if (match) {
      region = match[1] ?? null;
      locality = parts[i - 1] ?? null;
      country = parts[i + 1] ?? null;
      break;
    }
  }
  return { addressLine: line, locality, region, country };
}
