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

/** Lowercased email identity key. Format sanity only — NEVER a deliverability claim. */
export function normalizeEmail(value: string | undefined | null): string | null {
  const text = normalizeText(value);
  if (!text) return null;
  const lower = text.toLowerCase();
  // Minimal structural check; real validation is a paid M5 deliverability check.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(lower)) return null;
  return lower;
}

/**
 * Canonical LinkedIn person-profile key: 'linkedin.com/in/<slug>'. Accepts
 * scheme-less input and country subdomains (uk.linkedin.com); rejects
 * non-LinkedIn hosts and non-/in/ paths (company pages are not person
 * identity). GUARDRAIL: the URL must come from an approved source — an Apollo
 * response or an import — never from scraping or automated LinkedIn browsing.
 */
export function normalizeLinkedinUrl(raw: string | undefined | null): string | null {
  const text = normalizeText(raw);
  if (!text) return null;
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (host !== "linkedin.com" && !host.endsWith(".linkedin.com")) return null;
  const match = /^\/in\/([^/]+)\/?$/.exec(url.pathname);
  const slug = match?.[1]?.toLowerCase();
  if (!slug) return null;
  return `linkedin.com/in/${slug}`;
}

/** Deterministic comparison key for name-similarity checks (never a merge key on its own). */
export function nameKey(value: string | undefined | null): string {
  return (value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

export interface NormalizedRecord {
  kind: "business" | "person";
  displayName: string;
  firstName: string | null;
  lastName: string | null;
  title: string | null;
  contactName: string | null;
  category: string | null;
  websiteUrl: string | null;
  normalizedDomain: string | null;
  addressLine: string | null;
  locality: string | null;
  region: string | null;
  country: string | null;
  phone: NormalizedPhone | null;
  email: string | null;
  normalizedLinkedinUrl: string | null;
  apolloPersonId: string | null;
  employerName: string | null;
  employerWebsiteUrl: string | null;
  employerDomain: string | null;
  apolloOrganizationId: string | null;
  rating: number | null;
  reviewCount: number | null;
}

export function normalizeSourceRecord(record: SourceRecord): NormalizedRecord {
  const kind = record.kind ?? "business";
  const person = record.person;
  const employer = person?.employer;
  return {
    kind,
    displayName: normalizeText(record.name) ?? record.sourceKey,
    firstName: normalizeText(person?.firstName),
    lastName: normalizeText(person?.lastName),
    title: normalizeText(record.title),
    contactName: normalizeText(record.contactName),
    category: normalizeText(record.category),
    // A person lead never carries the employer's website as its own domain —
    // the weak-domain dedupe would flag every colleague as a conflict. The
    // employer's identity lives on the employer business lead.
    websiteUrl: kind === "person" ? null : normalizeText(record.website),
    normalizedDomain: kind === "person" ? null : normalizeDomain(record.website),
    addressLine: normalizeText(record.address),
    locality: normalizeText(record.locality),
    region: normalizeText(record.region),
    country: normalizeText(record.country) ?? "US",
    phone: normalizePhone(record.phone),
    email: normalizeEmail(record.email),
    normalizedLinkedinUrl: normalizeLinkedinUrl(record.linkedinUrl),
    apolloPersonId: normalizeText(person?.apolloPersonId),
    employerName: normalizeText(employer?.name),
    employerWebsiteUrl: normalizeText(employer?.websiteUrl),
    employerDomain: normalizeDomain(employer?.domain ?? employer?.websiteUrl),
    apolloOrganizationId: normalizeText(employer?.apolloOrganizationId),
    rating: record.rating ?? null,
    reviewCount: record.reviewCount ?? null,
  };
}
