import type { CapabilityOverrides } from "../engine/workflow-schema/overrides.js";
import type { Profile } from "../engine/workflow-schema/steps.js";

/**
 * Deterministic rule-based interpreter for the guided request: plain English
 * in, suggested editable fields out. No model provider is involved (the M5
 * embedded assistant will augment this behind the same interface), nothing is
 * executed, and every suggestion only pre-fills the same editable form whose
 * values are re-validated by workflowInputsSchema/overridesSchema at preview.
 */

export type Confidence = "high" | "medium" | "low";

export interface FieldSuggestion<T> {
  value: T;
  confidence: Confidence;
  /** The text span the rule matched, so the UI can show why it suggested this. */
  evidence: string;
}

export interface InterpretedRequest {
  suggestions: {
    businessType?: FieldSuggestion<string>;
    locations?: FieldSuggestion<string[]>;
    limit?: FieldSuggestion<number>;
    enrichmentProfile?: FieldSuggestion<Profile>;
    overrides?: FieldSuggestion<CapabilityOverrides>;
  };
  /** Clauses no rule understood; shown as "we didn't understand" for manual entry. */
  unmatched: string[];
  /** Clamping, M5-only capability notices, and unsupported-criteria notices. */
  notes: string[];
}

const MAX_LIMIT = 500;
const MAX_LOCATIONS = 20;

/** Anchors that name a business kind and stay part of the businessType (singularized). */
const CATEGORY_ANCHORS: Record<string, string> = {
  contractors: "contractor",
  contractor: "contractor",
  agencies: "agency",
  agency: "agency",
  practices: "practice",
  practice: "practice",
  clinics: "clinic",
  clinic: "clinic",
  gyms: "gym",
  gym: "gym",
  restaurants: "restaurant",
  restaurant: "restaurant",
  salons: "salon",
  salon: "salon",
  studios: "studio",
  studio: "studio",
  shops: "shop",
  shop: "shop",
  stores: "store",
  store: "store",
  dealerships: "dealership",
  dealership: "dealership",
  providers: "provider",
  provider: "provider",
  services: "service",
  service: "service",
};

/** Anchors that only mark "these are the prospects" and are dropped from the value. */
const GENERIC_ANCHORS = new Set([
  "companies",
  "company",
  "businesses",
  "business",
  "firms",
  "firm",
  "leads",
  "lead",
  "prospects",
  "prospect",
  "brands",
  "organizations",
]);

/** Words stripped from the front of a captured category phrase. */
const CATEGORY_STOPWORDS = new Set([
  "find",
  "get",
  "list",
  "build",
  "source",
  "target",
  "prioritize",
  "me",
  "us",
  "a",
  "an",
  "the",
  "of",
  "for",
  "best",
  "top",
  "all",
  "some",
  "new",
  "good",
  "quick",
  "local",
  "small",
  "independent",
  "potential",
  "and",
]);

/** No-anchor fallback: bare trade words mapped to a businessType value. */
const CATEGORY_LEXICON: Record<string, string> = {
  roofers: "roofing",
  roofer: "roofing",
  roofing: "roofing",
  plumbers: "plumbing",
  plumber: "plumbing",
  plumbing: "plumbing",
  hvac: "HVAC",
  electricians: "electrical",
  electrician: "electrical",
  landscapers: "landscaping",
  landscaping: "landscaping",
  dentists: "dental",
  dentist: "dental",
  dental: "dental",
  chiropractors: "chiropractic",
  chiropractor: "chiropractic",
};

const QUANTITY_NOUNS = new Set([
  ...GENERIC_ANCHORS,
  ...Object.keys(CATEGORY_ANCHORS),
  ...Object.keys(CATEGORY_LEXICON),
  "records",
  "results",
  "contacts",
  "places",
  "people",
]);

const LOCATION_PREPOSITIONS = /\b(?:in|around|near|across|throughout)\s+/g;
const STATE_CODE = /^[A-Z]{2}$/;

interface ClauseResult {
  consumed: boolean;
  forceUnmatched: boolean;
}

export function interpretRequest(text: string): InterpretedRequest {
  const suggestions: InterpretedRequest["suggestions"] = {};
  const notes: string[] = [];
  const unmatched: string[] = [];
  const overrides: CapabilityOverrides = {};
  const overrideEvidence: string[] = [];

  const clauses = text
    .split(/[.;\n]+/)
    .map((c) => c.trim())
    .filter((c) => c.length > 0);

  for (const clause of clauses) {
    const result: ClauseResult = { consumed: false, forceUnmatched: false };

    const locations = matchLocations(clause);
    if (locations && !suggestions.locations) {
      let values = locations.values;
      if (values.length > MAX_LOCATIONS) {
        notes.push(`Found ${values.length} locations; a workflow accepts at most ${MAX_LOCATIONS}, keeping the first ${MAX_LOCATIONS}.`);
        values = values.slice(0, MAX_LOCATIONS);
      }
      suggestions.locations = { value: values, confidence: "high", evidence: locations.evidence };
      result.consumed = true;
    }

    const limit = matchLimit(clause, locations?.evidence ?? "");
    if (limit && !suggestions.limit) {
      let value = limit.value;
      if (value > MAX_LIMIT) {
        notes.push(`Requested ${limit.value} leads; a single run sources at most ${MAX_LIMIT}, so the limit was set to ${MAX_LIMIT}.`);
        value = MAX_LIMIT;
      }
      if (value >= 1) {
        suggestions.limit = { value, confidence: limit.confidence, evidence: limit.evidence };
        result.consumed = true;
      }
    }

    const category = matchBusinessType(clause);
    if (category) {
      if (!suggestions.businessType) suggestions.businessType = category;
      result.consumed = true;
    }

    const profile = matchProfile(clause);
    if (profile) {
      if (!suggestions.enrichmentProfile) suggestions.enrichmentProfile = profile;
      result.consumed = true;
    }

    if (matchOverrides(clause, overrides, overrideEvidence)) result.consumed = true;

    if (matchFilterCriteria(clause, notes)) result.consumed = true;

    if (matchUnsupportedCriteria(clause, notes)) result.forceUnmatched = true;

    if (!result.consumed || result.forceUnmatched) unmatched.push(clause);
  }

  if (Object.keys(overrides).length > 0) {
    suggestions.overrides = { value: overrides, confidence: "medium", evidence: overrideEvidence.join("; ") };
  }

  return { suggestions, unmatched, notes };
}

function matchLimit(
  clause: string,
  locationEvidence: string,
): { value: number; confidence: Confidence; evidence: string } | undefined {
  const re = /(?:^|[^\w,])(\d{1,3}(?:,\d{3})+|\d+)(?=\W|$)/g;
  for (const match of clause.matchAll(re)) {
    const raw = match[1];
    if (!raw) continue;
    const before = clause.slice(0, match.index + match[0].indexOf(raw)).trimEnd();
    // A number inside a detected location span, right after a location
    // preposition, or after a state code (ZIP) is not a quantity.
    if (locationEvidence.includes(raw)) continue;
    if (/\b(?:in|around|near|across|throughout|at)$/i.test(before)) continue;
    if (/[A-Z]{2}$/.test(before)) continue;
    const value = Number(raw.replaceAll(",", ""));
    if (!Number.isInteger(value) || value <= 0) continue;
    const after = clause.slice(match.index + match[0].length);
    const nextWords = after.trim().split(/\s+/).slice(0, 3);
    const nearNoun = nextWords.some((w) => QUANTITY_NOUNS.has(w.toLowerCase().replace(/[^\w]/g, "")));
    return { value, confidence: nearNoun ? "high" : "medium", evidence: raw };
  }
  return undefined;
}

function matchLocations(clause: string): { values: string[]; evidence: string } | undefined {
  const values: string[] = [];
  const evidenceParts: string[] = [];
  for (const match of clause.matchAll(LOCATION_PREPOSITIONS)) {
    const rest = clause.slice(match.index + match[0].length);
    // Capture a run of Capitalized words / state codes / commas / "and".
    const run = /^(?:(?:[A-Z][\w.'&-]*|and|,)(?:\s+|(?=,)|$)|,\s*)+/.exec(rest);
    if (!run) continue;
    const span = run[0].replace(/(?:\s*,\s*|\s+and\s*|\s+)$/i, "").trim();
    if (span.length === 0 || span.toLowerCase() === "and") continue;
    evidenceParts.push(`${match[0]}${span}`.trim());
    for (const part of span.split(/\s+and\s+/)) {
      const segments = part
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0 && s.toLowerCase() !== "and");
      for (const segment of segments) {
        if (STATE_CODE.test(segment) && values.length > 0) {
          values[values.length - 1] = `${values[values.length - 1]}, ${segment}`;
        } else {
          values.push(segment);
        }
      }
    }
  }
  if (values.length === 0) return undefined;
  return { values: [...new Set(values)], evidence: evidenceParts.join("; ") };
}

function matchBusinessType(clause: string): FieldSuggestion<string> | undefined {
  const anchorAlternation = [...Object.keys(CATEGORY_ANCHORS), ...GENERIC_ANCHORS].join("|");
  const re = new RegExp(`((?:[\\w&'-]+\\s+){0,3})(${anchorAlternation})(?=\\W|$)`, "gi");
  for (const match of clause.matchAll(re)) {
    const anchor = (match[2] ?? "").toLowerCase();
    const qualifiers = (match[1] ?? "")
      .trim()
      .split(/\s+/)
      .filter((w) => w.length > 0);
    while (qualifiers.length > 0) {
      const head = (qualifiers[0] ?? "").toLowerCase();
      if (CATEGORY_STOPWORDS.has(head) || /^\d[\d,]*$/.test(head)) qualifiers.shift();
      else break;
    }
    const kept = CATEGORY_ANCHORS[anchor];
    if (qualifiers.length === 0 && kept === undefined) continue; // bare "companies" names nothing
    const value = [...qualifiers, ...(kept !== undefined ? [kept] : [])].join(" ").trim();
    if (value.length === 0) continue;
    return { value, confidence: "high", evidence: match[0].trim() };
  }
  for (const [keyword, value] of Object.entries(CATEGORY_LEXICON)) {
    const re2 = new RegExp(`\\b${keyword}\\b`, "i");
    const m = re2.exec(clause);
    if (m) return { value, confidence: "medium", evidence: m[0] };
  }
  return undefined;
}

function matchProfile(clause: string): FieldSuggestion<Profile> | undefined {
  const quick = /\b(?:quick list|just (?:a )?list|names and websites|simple list)\b/i.exec(clause);
  if (quick) return { value: "quick_list", confidence: "high", evidence: quick[0] };
  const call = /\b(?:call[- ]?ready|cold[- ]?call(?:ing|s|ers)?|callers?|dial(?:ing|ers)?)\b/i.exec(clause);
  if (call) return { value: "call_ready", confidence: "high", evidence: call[0] };
  const direct = /\b(?:direct|mobile|cell)[- ](?:dial|numbers?|phones?)\b/i.exec(clause);
  if (direct) return { value: "call_ready", confidence: "medium", evidence: direct[0] };
  const full = /\b(?:full(?:y)? enrich(?:ed|ment)?|deep(?:ly)? research(?:ed)?|personali[sz]ed?|personali[sz]ation|outreach|scored|scoring)\b/i.exec(clause);
  if (full) return { value: "full", confidence: "medium", evidence: full[0] };
  return undefined;
}

function matchOverrides(clause: string, overrides: CapabilityOverrides, evidence: string[]): boolean {
  let matched = false;
  const apply = (re: RegExp, set: (o: CapabilityOverrides) => void): void => {
    const m = re.exec(clause);
    if (m) {
      set(overrides);
      evidence.push(m[0]);
      matched = true;
    }
  };
  apply(/\b(?:owners?|decision[- ]?makers?|founders?)\b/i, (o) => (o.findOwner = true));
  apply(/\b(?:verified|valid(?:ated)?)[- ](?:work )?emails?\b/i, (o) => {
    o.findEmail = true;
    o.validateEmail = true;
  });
  if (overrides.findEmail === undefined) apply(/\b(?:work )?emails?\b/i, (o) => (o.findEmail = true));
  apply(/\b(?:direct|mobile|cell)[- ](?:dial|numbers?|phones?)\b/i, (o) => (o.requireDirectPhone = true));
  apply(/\b(?:business )?main (?:line|number)s? (?:is|are) (?:fine|ok(?:ay)?)\b/i, (o) => (o.acceptBusinessMainPhone = true));
  apply(/\b(?:no|skip|without) personali[sz]ation\b/i, (o) => (o.skipPersonalization = true));
  return matched;
}

/** Website/phone availability requests map to the workflow's existing filter step. */
function matchFilterCriteria(clause: string, notes: string[]): boolean {
  const m = /\b(?:working websites?|has (?:a )?website|(?:public|with) phone numbers?)\b/i.exec(clause);
  if (!m) return false;
  const note = "Website and public-phone requirements map to the workflow's filter step (working website / valid phone format).";
  if (!notes.includes(note)) notes.push(note);
  return true;
}

/** Criteria the engine cannot source on yet; surfaced honestly instead of silently dropped. */
function matchUnsupportedCriteria(clause: string, notes: string[]): boolean {
  const m = /\b(?:company size|employees?|headcount|revenue|titles?|seniority|funding|ad spend|advertising|capable of spending)\b/i.exec(clause);
  if (!m) return false;
  const note =
    "Criteria like company size, revenue, titles, or ad-spend capability aren't sourcing filters yet; deterministic scoring ranks sourced leads instead (deeper qualification arrives in later milestones).";
  if (!notes.includes(note)) notes.push(note);
  return true;
}
