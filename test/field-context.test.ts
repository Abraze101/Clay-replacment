import assert from "node:assert/strict";
import { test } from "node:test";

import type { ItemSnapshot, NormalizedFields } from "../src/engine/runner/executors.js";
import { buildFieldContext } from "../src/engine/runner/executors.js";

function normalized(overrides: Partial<NormalizedFields> = {}): NormalizedFields {
  return {
    kind: "business",
    displayName: "Acme Health",
    firstName: null,
    lastName: null,
    title: null,
    contactName: null,
    category: null,
    websiteUrl: null,
    normalizedDomain: null,
    addressLine: null,
    locality: null,
    region: null,
    country: "US",
    phoneRaw: null,
    phoneE164: null,
    phoneFormatValid: null,
    email: null,
    normalizedLinkedinUrl: null,
    apolloPersonId: null,
    employerName: null,
    employerWebsiteUrl: null,
    employerDomain: null,
    apolloOrganizationId: null,
    rating: null,
    reviewCount: null,
    ...overrides,
  };
}

function snapshot(enrichment?: ItemSnapshot["enrichment"]): ItemSnapshot {
  return {
    source: { sourceKey: "k", name: "Acme Health" },
    ...(enrichment ? { enrichment } : {}),
  };
}

test("field context: person fields are null/false before enrichment", () => {
  const ctx = buildFieldContext(snapshot(), normalized());
  assert.equal(ctx.title, null);
  assert.equal(ctx.has_email, false);
  assert.equal(ctx.has_verified_email, false);
  assert.equal(ctx.has_linkedin, false);
  assert.equal(ctx.has_direct_phone, false);
});

test("field context: enriched values win over source values", () => {
  const ctx = buildFieldContext(
    snapshot({
      personName: "Jane Smith",
      title: "Chief Executive Officer",
      directPhoneE164: "+15125550142",
      workEmail: "jane@acmehealth.example",
      providerRequestId: "req-1",
      linkedinUrl: "linkedin.com/in/janesmith",
    }),
    normalized({ title: "Owner (per import)", email: null, normalizedLinkedinUrl: null }),
  );
  assert.equal(ctx.title, "Chief Executive Officer");
  assert.equal(ctx.has_email, true);
  assert.equal(ctx.has_linkedin, true);
  assert.equal(ctx.has_direct_phone, true);
});

test("field context: a merely-found email NEVER sets has_verified_email", () => {
  const ctx = buildFieldContext(
    snapshot({
      personName: "Jane Smith",
      title: "CEO",
      directPhoneE164: null,
      workEmail: "jane@acmehealth.example",
      providerRequestId: "req-1",
    }),
    normalized({ email: "imported@acmehealth.example" }),
  );
  assert.equal(ctx.has_email, true);
  assert.equal(ctx.has_verified_email, false, "verified_email has no M4 writer; presence is not verification");
});

test("field context: a person's website signal is the employer's domain, not their own", () => {
  const person = normalized({
    kind: "person",
    websiteUrl: null,
    normalizedDomain: null,
    employerDomain: "acmehealth.example",
    employerName: "Acme Health",
  });
  const ctx = buildFieldContext(snapshot(), person);
  assert.equal(ctx.has_website, true);
  assert.equal(ctx.employer_name, "Acme Health");

  const noEmployer = buildFieldContext(snapshot(), normalized({ kind: "person" }));
  assert.equal(noEmployer.has_website, false);
});
