import assert from "node:assert/strict";
import { test } from "node:test";

import { evaluateTemplate, LOCAL_SERVICE_TEMPLATE, SCORE_TEMPLATES } from "../src/engine/scoring/templates.js";

test("scoring: deterministic full-match and partial-match totals", () => {
  const full = evaluateTemplate(LOCAL_SERVICE_TEMPLATE, {
    has_website: true,
    rating: 4.8,
    review_count: 120,
    phone_format_valid: true,
    locality: "Austin",
  });
  assert.equal(full.total, 90);
  assert.equal(full.results.filter((r) => r.matched).length, 5);
  assert.equal(full.templateVersion, "local-service/v1");

  const partial = evaluateTemplate(LOCAL_SERVICE_TEMPLATE, {
    has_website: false,
    rating: 4.2,
    review_count: 30,
    phone_format_valid: true,
    locality: "Dripping Springs",
  });
  // well-rated(20) + established-reviews(10) + callable(20) + locality(10)
  assert.equal(partial.total, 60);
});

test("scoring: identical context always yields the identical result (no model involvement)", () => {
  const ctx = { has_website: true, rating: 4.0, review_count: 25, phone_format_valid: false, locality: "Austin" };
  const a = evaluateTemplate(LOCAL_SERVICE_TEMPLATE, ctx);
  const b = evaluateTemplate(LOCAL_SERVICE_TEMPLATE, ctx);
  assert.deepEqual(a, b);
  assert.equal(a.total, 70);
});

test("scoring: template registry exposes local-service", () => {
  assert.ok(SCORE_TEMPLATES.has("local-service"));
  assert.equal(SCORE_TEMPLATES.get("local-service")?.rules.length, 5);
});
