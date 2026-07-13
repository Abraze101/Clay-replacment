import assert from "node:assert/strict";
import { test } from "node:test";

import {
  evaluateTemplate,
  EXECUTIVE_FIT_TEMPLATE,
  IMPORTED_LIST_TEMPLATE,
  LOCAL_SERVICE_TEMPLATE,
  SCORE_TEMPLATES,
} from "../src/engine/scoring/templates.js";

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

test("scoring: template registry exposes local-service, executive-fit, and imported-list", () => {
  assert.ok(SCORE_TEMPLATES.has("local-service"));
  assert.equal(SCORE_TEMPLATES.get("local-service")?.rules.length, 5);
  assert.ok(SCORE_TEMPLATES.has("executive-fit"));
  assert.ok(SCORE_TEMPLATES.has("imported-list"));
});

test("scoring: executive-fit matches decision-maker titles through the any-group and needs no contact data", () => {
  const ceo = evaluateTemplate(EXECUTIVE_FIT_TEMPLATE, {
    title: "Co-Founder & CEO",
    has_linkedin: true,
    has_website: true,
    employer_name: "Acme Health",
    locality: "Austin",
  });
  assert.equal(ceo.total, 100);

  const vp = evaluateTemplate(EXECUTIVE_FIT_TEMPLATE, {
    title: "VP of Operations",
    has_linkedin: false,
    has_website: true,
    employer_name: "Acme Health",
    locality: null,
  });
  // decision-maker-title(40) + employer-domain-known(20) + employer-named(10)
  assert.equal(vp.total, 70);

  const analyst = evaluateTemplate(EXECUTIVE_FIT_TEMPLATE, {
    title: "Data Analyst",
    has_linkedin: true,
    has_website: false,
    employer_name: null,
    locality: "Austin",
  });
  // has-linkedin(20) + known-locality(10): the any-group title rule missed.
  assert.equal(analyst.total, 30);

  // Contact-availability fields must be irrelevant pre-payment: adding them
  // changes nothing because the template never references them.
  const withContacts = evaluateTemplate(EXECUTIVE_FIT_TEMPLATE, {
    title: "Data Analyst",
    has_linkedin: true,
    has_website: false,
    employer_name: null,
    locality: "Austin",
    has_verified_email: true,
    has_direct_phone: true,
  });
  assert.equal(withContacts.total, 30);
});

test("scoring: imported-list scores completeness; an existing email is presence, never verification", () => {
  const complete = evaluateTemplate(IMPORTED_LIST_TEMPLATE, {
    has_website: true,
    phone_format_valid: true,
    has_email: true,
    has_linkedin: true,
    title: "Owner",
    locality: "Dallas",
  });
  assert.equal(complete.total, 100);

  const bare = evaluateTemplate(IMPORTED_LIST_TEMPLATE, {
    has_website: true,
    phone_format_valid: null,
    has_email: false,
    has_linkedin: false,
    title: null,
    locality: null,
  });
  assert.equal(bare.total, 25);
});
