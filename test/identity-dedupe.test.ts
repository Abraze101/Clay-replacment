import assert from "node:assert/strict";
import { test } from "node:test";

import { resolveIdentity } from "../src/engine/dedupe/identity.js";
import { insertLead } from "../src/storage/repositories/lead-repo.js";
import { createTestApp } from "./helpers/setup.js";

test("identity: source-provider identity is the hard match; weak identifiers resolve in code", async () => {
  const t = await createTestApp();
  const kysely = t.app.db.kysely;
  try {
    const lead = await insertLead(kysely, {
      agencyId: t.app.agencyId,
      kind: "business",
      displayName: "Austin Roof Pros",
      normalizedDomain: "austinroofpros.com",
      normalizedPhone: "+15125550101",
      locality: "Austin",
      sourceProvider: "fake-places",
      sourceProviderId: "fx-001",
    });

    // 1. Same provider record → matched via source identity.
    assert.deepEqual(
      await resolveIdentity(kysely, {
        agencyId: t.app.agencyId,
        kind: "business",
        sourceProvider: "fake-places",
        sourceProviderId: "fx-001",
        displayName: "Totally Different Name",
        normalizedDomain: null,
        normalizedPhone: null,
        locality: null,
      }),
      { kind: "matched", leadId: lead.id, via: "source_identity" },
    );

    // 2. Same domain + same normalized name → matched.
    assert.deepEqual(
      await resolveIdentity(kysely, {
        agencyId: t.app.agencyId,
        kind: "business",
        sourceProvider: "fake-places",
        sourceProviderId: "fx-999",
        displayName: "  AUSTIN Roof Pros ",
        normalizedDomain: "austinroofpros.com",
        normalizedPhone: null,
        locality: "Austin",
      }),
      { kind: "matched", leadId: lead.id, via: "domain" },
    );

    // 3. Same domain + DIFFERENT name → conflict (multi-location sites share domains).
    const domainConflict = await resolveIdentity(kysely, {
      agencyId: t.app.agencyId,
      kind: "business",
      sourceProvider: "fake-places",
      sourceProviderId: "fx-998",
      displayName: "Round Rock Plumbing Group",
      normalizedDomain: "austinroofpros.com",
      normalizedPhone: null,
      locality: "Round Rock",
    });
    assert.equal(domainConflict.kind, "conflict");
    assert.equal((domainConflict as { identifier: string }).identifier, "normalized_domain");

    // 4. Same phone + locality + different name → conflict (shared line), never merged.
    const phoneConflict = await resolveIdentity(kysely, {
      agencyId: t.app.agencyId,
      kind: "business",
      sourceProvider: "fake-places",
      sourceProviderId: "fx-997",
      displayName: "Lakeside Fitness Studio",
      normalizedDomain: null,
      normalizedPhone: "+15125550101",
      locality: "Austin",
    });
    assert.equal(phoneConflict.kind, "conflict");
    assert.equal((phoneConflict as { identifier: string }).identifier, "normalized_phone_locality");

    // 5. Nothing matches → new. Name similarity ALONE never merges.
    const sameNameOnly = await resolveIdentity(kysely, {
      agencyId: t.app.agencyId,
      kind: "business",
      sourceProvider: "fake-places",
      sourceProviderId: "fx-996",
      displayName: "Austin Roof Pros",
      normalizedDomain: "adifferentroofer.com",
      normalizedPhone: "+15125559999",
      locality: "Dallas",
    });
    assert.deepEqual(sameNameOnly, { kind: "new" });

    // The conflicts above changed nothing: still exactly one lead row.
    const leads = await kysely.selectFrom("leads").selectAll().execute();
    assert.equal(leads.length, 1, "conflicts are flagged, never merged");
  } finally {
    await t.teardown();
  }
});
