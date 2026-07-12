import assert from "node:assert/strict";
import { test } from "node:test";

import {
  appendContactPointCheck,
  insertContactPoint,
  insertLead,
  listContactPointChecks,
  listContactPoints,
} from "../src/storage/repositories/lead-repo.js";
import { createTestApp } from "./helpers/setup.js";

test("contact points: one provider's result never overwrites another's — same value, two providers, two rows", async () => {
  const t = await createTestApp();
  const kysely = t.app.db.kysely;
  try {
    const lead = await insertLead(kysely, {
      agencyId: t.app.agencyId,
      kind: "business",
      displayName: "Austin Roof Pros",
      sourceProvider: "fake-places",
      sourceProviderId: "cp-test-1",
    });

    const fromPlaces = await insertContactPoint(kysely, {
      leadId: lead.id,
      type: "phone",
      role: "business_main",
      rawValue: "(512) 555-0101",
      normalizedValue: "+15125550101",
      sourceProvider: "fake-places",
      formatValid: true,
      formatCheckedAt: new Date(),
    });
    const fromImport = await insertContactPoint(kysely, {
      leadId: lead.id,
      type: "phone",
      role: "business_main",
      rawValue: "512-555-0101",
      normalizedValue: "+15125550101",
      sourceProvider: "csv-import",
      formatValid: true,
      formatCheckedAt: new Date(),
    });
    assert.notEqual(fromPlaces.id, fromImport.id, "distinct providers hold distinct rows for the same value");

    // Replaying the SAME provider+value upserts to the existing row.
    const replay = await insertContactPoint(kysely, {
      leadId: lead.id,
      type: "phone",
      role: "business_main",
      rawValue: "(512) 555-0101",
      normalizedValue: "+15125550101",
      sourceProvider: "fake-places",
      formatValid: true,
      formatCheckedAt: new Date(),
    });
    assert.equal(replay.id, fromPlaces.id);
    assert.equal((await listContactPoints(kysely, lead.id)).length, 2);
  } finally {
    await t.teardown();
  }
});

test("contact points: validation history is append-only; earlier checks never mutate", async () => {
  const t = await createTestApp();
  const kysely = t.app.db.kysely;
  try {
    const lead = await insertLead(kysely, {
      agencyId: t.app.agencyId,
      kind: "business",
      displayName: "History Test Biz",
      sourceProvider: "fake-places",
      sourceProviderId: "cp-test-2",
    });
    const cp = await insertContactPoint(kysely, {
      leadId: lead.id,
      type: "phone",
      role: "business_main",
      rawValue: "(512) 555-0199",
      normalizedValue: "+15125550199",
      sourceProvider: "fake-places",
      formatValid: true,
      formatCheckedAt: new Date("2026-07-01T00:00:00Z"),
    });
    await appendContactPointCheck(kysely, {
      contactPointId: cp.id,
      method: "format",
      provider: "engine",
      result: "valid",
      checkedAt: new Date("2026-07-01T00:00:00Z"),
    });
    await appendContactPointCheck(kysely, {
      contactPointId: cp.id,
      method: "format",
      provider: "engine",
      result: "valid",
      checkedAt: new Date("2026-07-11T00:00:00Z"),
    });
    const checks = await listContactPointChecks(kysely, cp.id);
    assert.equal(checks.length, 2, "checks append; they are never replaced");
    // Latest-first ordering by checked_at: the July 11 check leads.
    assert.ok(new Date(checks[0]!.checked_at).toISOString().startsWith("2026-07-11"));
    assert.ok(new Date(checks[1]!.checked_at).toISOString().startsWith("2026-07-01"));
  } finally {
    await t.teardown();
  }
});

test("contact points: schema-level honesty constraints hold (email status pairing, e164 shape, signal/type scoping)", async () => {
  const t = await createTestApp();
  const kysely = t.app.db.kysely;
  try {
    const lead = await insertLead(kysely, {
      agencyId: t.app.agencyId,
      kind: "business",
      displayName: "Constraint Test Biz",
      sourceProvider: "fake-places",
      sourceProviderId: "cp-test-3",
    });
    const email = await insertContactPoint(kysely, {
      leadId: lead.id,
      type: "email",
      role: "work",
      rawValue: "Owner@Example.com",
      normalizedValue: "owner@example.com",
      sourceProvider: "fake-apollo",
    });
    assert.equal(email.email_status, "not_checked", "discovery is never verification");
    assert.equal(email.email_status_checked_at, null);

    // Claiming 'valid' WITHOUT a checked_at violates the paired CHECK.
    await assert.rejects(
      () => kysely.updateTable("contact_points").set({ email_status: "valid" }).where("id", "=", email.id).execute(),
    );

    // A phone row cannot carry email signals (type-scoped CHECK).
    await assert.rejects(() =>
      kysely
        .insertInto("contact_points")
        .values({
          lead_id: lead.id,
          type: "phone",
          role: "business_main",
          raw_value: "x",
          normalized_value: null,
          source_provider: "t",
          source_metadata: "{}",
          email_status: "valid",
          email_status_checked_at: new Date(),
          email_status_provider: "t",
        })
        .execute(),
    );

    // normalized phone values must be E.164 (CHECK-enforced).
    await assert.rejects(() =>
      kysely
        .insertInto("contact_points")
        .values({
          lead_id: lead.id,
          type: "phone",
          role: "business_main",
          raw_value: "5551234",
          normalized_value: "5551234",
          source_provider: "t",
          source_metadata: "{}",
        })
        .execute(),
    );
  } finally {
    await t.teardown();
  }
});
