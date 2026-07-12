import assert from "node:assert/strict";
import { test } from "node:test";

import { nameKey, normalizeDomain, normalizePhone, normalizeText } from "../src/engine/records/normalize.js";

test("normalize: valid US phone → E.164 + format_valid", () => {
  const phone = normalizePhone("(512) 555-0101");
  assert.deepEqual(phone, { raw: "(512) 555-0101", e164: "+15125550101", formatValid: true });
});

test("normalize: unparseable and vanity phones are kept but format_valid=false (never 'verified')", () => {
  assert.deepEqual(normalizePhone("call us maybe"), { raw: "call us maybe", e164: null, formatValid: false });
  assert.deepEqual(normalizePhone("512-555-BLUE"), { raw: "512-555-BLUE", e164: null, formatValid: false });
  assert.equal(normalizePhone(""), null);
  assert.equal(normalizePhone(undefined), null);
});

test("normalize: registrable-domain identity (eTLD+1), www and paths stripped", () => {
  assert.equal(normalizeDomain("https://www.austinroofpros.com"), "austinroofpros.com");
  assert.equal(normalizeDomain("https://austinroofpros.com/contact?x=1"), "austinroofpros.com");
  assert.equal(normalizeDomain("https://www.sharedplumbing.com/atx"), "sharedplumbing.com");
  assert.equal(normalizeDomain(null), null);
});

test("normalize: private-suffix domains do NOT collapse (allowPrivateDomains)", () => {
  // Without allowPrivateDomains both would become 'github.io' and force-merge
  // two distinct businesses — the exact failure mode the docs forbid.
  assert.equal(normalizeDomain("https://acme.github.io"), "acme.github.io");
  assert.equal(normalizeDomain("https://other.github.io"), "other.github.io");
});

test("normalize: text collapse and deterministic name keys", () => {
  assert.equal(normalizeText("  Austin   Roof\tPros  "), "Austin Roof Pros");
  assert.equal(normalizeText("   "), null);
  assert.equal(nameKey("Austin Roof Pros"), nameKey("  AUSTIN roof-pros "));
  assert.notEqual(nameKey("Austin Roof Pros"), nameKey("Round Rock Plumbing Group"));
});
