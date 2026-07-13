import type { FieldContext, RuleGroup } from "../workflow-schema/rules.js";
import { evaluateRuleGroup } from "../workflow-schema/rules.js";

/**
 * Deterministic, transparent scoring templates. A template is a fixed set of
 * point rules over declared fields — the LLM is never the source of a
 * qualification decision. Per-rule results persist as the score_rationale.
 * `when` is the same all/any RuleGroup the filter step uses (ADR-004's typed
 * operator allowlist; upgraded from a bare AND list at M4 for OR-matching
 * over titles).
 */
export interface ScoreRule {
  id: string;
  points: number;
  when: RuleGroup;
}

export interface ScoreTemplate {
  name: string;
  version: string;
  rules: ScoreRule[];
}

export interface ScoreResult {
  total: number;
  results: { id: string; points: number; matched: boolean }[];
  template: string;
  templateVersion: string;
}

export const LOCAL_SERVICE_TEMPLATE: ScoreTemplate = {
  name: "local-service",
  version: "local-service/v1",
  rules: [
    { id: "has-website", points: 30, when: { all: [{ field: "has_website", op: "eq", value: true }] } },
    { id: "well-rated", points: 20, when: { all: [{ field: "rating", op: "gte", value: 4 }] } },
    { id: "established-reviews", points: 10, when: { all: [{ field: "review_count", op: "gte", value: 25 }] } },
    { id: "callable-phone-format", points: 20, when: { all: [{ field: "phone_format_valid", op: "eq", value: true }] } },
    { id: "known-locality", points: 10, when: { all: [{ field: "locality", op: "exists" }] } },
  ],
};

/**
 * Executive/professional fit (M4). Scored BEFORE the review gate — and
 * therefore before any paid enrichment — so every field must be knowable from
 * search-time data alone: title, LinkedIn presence, employer identity, and
 * location. Contact-availability fields (has_verified_email,
 * has_direct_phone) are deliberately absent; they are unknowable pre-payment
 * and scoring on them would just reward spend.
 */
export const EXECUTIVE_FIT_TEMPLATE: ScoreTemplate = {
  name: "executive-fit",
  version: "executive-fit/v1",
  rules: [
    {
      id: "decision-maker-title",
      points: 40,
      when: {
        any: [
          { field: "title", op: "contains", value: "founder" },
          { field: "title", op: "contains", value: "ceo" },
          { field: "title", op: "contains", value: "chief" },
          { field: "title", op: "contains", value: "owner" },
          { field: "title", op: "contains", value: "president" },
          { field: "title", op: "contains", value: "vp" },
          { field: "title", op: "contains", value: "head of" },
        ],
      },
    },
    { id: "has-linkedin", points: 20, when: { all: [{ field: "has_linkedin", op: "eq", value: true }] } },
    { id: "employer-domain-known", points: 20, when: { all: [{ field: "has_website", op: "eq", value: true }] } },
    { id: "employer-named", points: 10, when: { all: [{ field: "employer_name", op: "exists" }] } },
    { id: "known-locality", points: 10, when: { all: [{ field: "locality", op: "exists" }] } },
  ],
};

/**
 * Imported-list completeness/contactability (M4). Runs after optional
 * enrichment in the imported workflow, so contact fields are meaningful —
 * but has_email only says an address EXISTS, never that it was verified.
 */
export const IMPORTED_LIST_TEMPLATE: ScoreTemplate = {
  name: "imported-list",
  version: "imported-list/v1",
  rules: [
    { id: "has-domain", points: 25, when: { all: [{ field: "has_website", op: "eq", value: true }] } },
    { id: "callable-phone-format", points: 20, when: { all: [{ field: "phone_format_valid", op: "eq", value: true }] } },
    { id: "has-email", points: 20, when: { all: [{ field: "has_email", op: "eq", value: true }] } },
    { id: "has-linkedin", points: 15, when: { all: [{ field: "has_linkedin", op: "eq", value: true }] } },
    { id: "named-contact-title", points: 10, when: { all: [{ field: "title", op: "exists" }] } },
    { id: "known-locality", points: 10, when: { all: [{ field: "locality", op: "exists" }] } },
  ],
};

export const SCORE_TEMPLATES: ReadonlyMap<string, ScoreTemplate> = new Map([
  [LOCAL_SERVICE_TEMPLATE.name, LOCAL_SERVICE_TEMPLATE],
  [EXECUTIVE_FIT_TEMPLATE.name, EXECUTIVE_FIT_TEMPLATE],
  [IMPORTED_LIST_TEMPLATE.name, IMPORTED_LIST_TEMPLATE],
]);

export function evaluateTemplate(template: ScoreTemplate, ctx: FieldContext): ScoreResult {
  const results = template.rules.map((rule) => {
    const matched = evaluateRuleGroup(rule.when, ctx);
    return { id: rule.id, points: matched ? rule.points : 0, matched };
  });
  return {
    total: results.reduce((acc, r) => acc + r.points, 0),
    results,
    template: template.name,
    templateVersion: template.version,
  };
}
