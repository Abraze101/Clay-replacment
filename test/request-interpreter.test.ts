import assert from "node:assert/strict";
import { test } from "node:test";

import { interpretRequest } from "../src/app/request-interpreter.js";

const DALLAS =
  "Find 500 roofing companies around Dallas with working websites and public phone numbers. " +
  "Prioritize companies that appear capable of spending on advertising.";

test("interpreter: the ui-scope Dallas example produces editable fields plus an honest unmatched clause", () => {
  const result = interpretRequest(DALLAS);
  assert.equal(result.suggestions.businessType?.value, "roofing");
  assert.equal(result.suggestions.limit?.value, 500);
  assert.deepEqual(result.suggestions.locations?.value, ["Dallas"]);
  // The qualification clause is not a sourcing filter: unmatched + a specific note.
  assert.equal(result.unmatched.length, 1);
  assert.match(result.unmatched[0] ?? "", /spending on advertising/);
  assert.ok(result.notes.some((n) => /scoring/i.test(n)));
  // The website/phone requirement maps to the filter step and says so.
  assert.ok(result.notes.some((n) => /filter step/i.test(n)));
});

test("interpreter: quantities clamp to the schema maximum with a note", () => {
  const result = interpretRequest("Give me 1,000 plumbers in Austin");
  assert.equal(result.suggestions.limit?.value, 500);
  assert.ok(result.notes.some((n) => /at most 500/.test(n)));
  assert.equal(result.suggestions.businessType?.value, "plumbing");
});

test("interpreter: multi-location phrases split and keep state codes attached", () => {
  const result = interpretRequest("Find 50 gyms in Austin and Dallas, TX");
  assert.deepEqual(result.suggestions.locations?.value, ["Austin", "Dallas, TX"]);
  assert.equal(result.suggestions.limit?.value, 50);
  assert.equal(result.suggestions.businessType?.value, "gym");
});

test("interpreter: numbers inside location context are not stolen as the limit", () => {
  const result = interpretRequest("quick list of gyms in Miami, FL 33101");
  assert.equal(result.suggestions.limit, undefined);
  assert.deepEqual(result.suggestions.locations?.value, ["Miami, FL"]);
  assert.equal(result.suggestions.enrichmentProfile?.value, "quick_list");
});

test("interpreter: calling keywords suggest call_ready; owner/phone hints become live overrides", () => {
  const result = interpretRequest("Build a cold-calling list of HVAC contractors near Phoenix, AZ; find the owner and mobile numbers");
  assert.equal(result.suggestions.enrichmentProfile?.value, "call_ready");
  assert.equal(result.suggestions.businessType?.value, "HVAC contractor");
  assert.equal(result.suggestions.overrides?.value.findOwner, true);
  assert.equal(result.suggestions.overrides?.value.requireDirectPhone, true);
  // Since M5 the overrides gate real capability steps — no placeholder notes.
  assert.ok(!result.notes.some((n) => n.includes("Milestone 5")));
});

test("interpreter: verified-email wording sets find AND validate email", () => {
  const result = interpretRequest("Find 20 dental practices in Tulsa with verified emails");
  assert.equal(result.suggestions.overrides?.value.findEmail, true);
  assert.equal(result.suggestions.overrides?.value.validateEmail, true);
  assert.equal(result.suggestions.businessType?.value, "dental practice");
});

test("interpreter: text it cannot parse lands in unmatched with no suggestions", () => {
  const result = interpretRequest("asdf qwerty zxcv");
  assert.deepEqual(result.suggestions, {});
  assert.deepEqual(result.unmatched, ["asdf qwerty zxcv"]);
  assert.deepEqual(result.notes, []);
});

test("interpreter: deterministic — the same input always yields the same output", () => {
  assert.deepEqual(interpretRequest(DALLAS), interpretRequest(DALLAS));
});
