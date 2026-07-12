import parsePhoneNumberFromString from "libphonenumber-js/max";
import { getDomain } from "tldts";

import type { SourceRecord } from "../../providers/types.js";

/**
 * Deterministic normalization of source records. Phone parsing is a FORMAT
 * check only: it never implies reachability, line status, or association with
 * the intended business/person (contact-data honesty rule). Offline line-type
 * detection is deliberately not attempted (US numbers report
 * FIXED_LINE_OR_MOBILE); line_type stays unknown until a paid M5 check.
 */
export interface NormalizedPhone {
  raw: string;
  e164: string | null;
  formatValid: boolean;
}

export function normalizePhone(raw: string | undefined | null, defaultCountry: "US" = "US"): NormalizedPhone | null {
  if (!raw || raw.trim() === "") return null;
  const parsed = parsePhoneNumberFromString(raw, defaultCountry);
  if (!parsed || !parsed.isValid()) {
    return { raw, e164: null, formatValid: false };
  }
  return { raw, e164: parsed.number, formatValid: true };
}

/**
 * Registrable-domain (eTLD+1) identity key. `allowPrivateDomains` keeps
 * `acme.github.io` from collapsing into `github.io` and force-merging
 * distinct businesses.
 */
export function normalizeDomain(websiteUrl: string | undefined | null): string | null {
  if (!websiteUrl || websiteUrl.trim() === "") return null;
  const domain = getDomain(websiteUrl.trim().toLowerCase(), { allowPrivateDomains: true });
  return domain ?? null;
}

export function normalizeText(value: string | undefined | null): string | null {
  if (value === undefined || value === null) return null;
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed === "" ? null : collapsed;
}

/** Deterministic comparison key for name-similarity checks (never a merge key on its own). */
export function nameKey(value: string | undefined | null): string {
  return (value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

export interface NormalizedRecord {
  displayName: string;
  category: string | null;
  websiteUrl: string | null;
  normalizedDomain: string | null;
  addressLine: string | null;
  locality: string | null;
  region: string | null;
  country: string | null;
  phone: NormalizedPhone | null;
  rating: number | null;
  reviewCount: number | null;
}

export function normalizeSourceRecord(record: SourceRecord): NormalizedRecord {
  return {
    displayName: normalizeText(record.name) ?? record.sourceKey,
    category: normalizeText(record.category),
    websiteUrl: normalizeText(record.website),
    normalizedDomain: normalizeDomain(record.website),
    addressLine: normalizeText(record.address),
    locality: normalizeText(record.locality),
    region: normalizeText(record.region),
    country: normalizeText(record.country) ?? "US",
    phone: normalizePhone(record.phone),
    rating: record.rating ?? null,
    reviewCount: record.reviewCount ?? null,
  };
}
