import type { Condition, FieldContext } from "../workflow-schema/rules.js";
import { evaluateCondition } from "../workflow-schema/rules.js";

/**
 * Deterministic, transparent scoring templates. A template is a fixed set of
 * point rules over declared fields — the LLM is never the source of a
 * qualification decision. Per-rule results persist as the score_rationale.
 */
export interface ScoreRule {
  id: string;
  points: number;
  when: Condition[];
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
    { id: "has-website", points: 30, when: [{ field: "has_website", op: "eq", value: true }] },
    { id: "well-rated", points: 20, when: [{ field: "rating", op: "gte", value: 4 }] },
    { id: "established-reviews", points: 10, when: [{ field: "review_count", op: "gte", value: 25 }] },
    { id: "callable-phone-format", points: 20, when: [{ field: "phone_format_valid", op: "eq", value: true }] },
    { id: "known-locality", points: 10, when: [{ field: "locality", op: "exists" }] },
  ],
};

export const SCORE_TEMPLATES: ReadonlyMap<string, ScoreTemplate> = new Map([
  [LOCAL_SERVICE_TEMPLATE.name, LOCAL_SERVICE_TEMPLATE],
]);

export function evaluateTemplate(template: ScoreTemplate, ctx: FieldContext): ScoreResult {
  const results = template.rules.map((rule) => {
    const matched = rule.when.every((c) => evaluateCondition(c, ctx));
    return { id: rule.id, points: matched ? rule.points : 0, matched };
  });
  return {
    total: results.reduce((acc, r) => acc + r.points, 0),
    results,
    template: template.name,
    templateVersion: template.version,
  };
}
