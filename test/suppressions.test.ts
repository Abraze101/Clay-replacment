import assert from "node:assert/strict";
import { test } from "node:test";

import { connectDb } from "../src/storage/db.js";
import { migrate } from "../src/storage/migrate.js";
import {
  addSuppression,
  findActiveSuppressions,
  listSuppressions,
  releaseSuppression,
} from "../src/storage/repositories/suppression-repo.js";
import { DEFAULT_AGENCY_ID } from "../src/storage/repositories/repo-util.js";

test("suppressions: add is idempotent while active; release is an update; re-suppress creates a new row", async () => {
  const db = await connectDb("pglite://memory");
  try {
    await migrate(db);
    const first = await addSuppression(db.kysely, {
      agencyId: DEFAULT_AGENCY_ID,
      scope: "phone",
      normalizedValue: "+15125550101",
      reason: "asked to never be called",
      requestedBy: "operator",
    });
    const again = await addSuppression(db.kysely, {
      agencyId: DEFAULT_AGENCY_ID,
      scope: "phone",
      normalizedValue: "+15125550101",
      reason: "duplicate request",
      requestedBy: "operator",
    });
    assert.equal(again.id, first.id, "re-suppressing an active value returns the existing row");
    assert.equal(again.reason, "asked to never be called", "existing row is not overwritten");

    const released = await releaseSuppression(db.kysely, {
      id: first.id,
      agencyId: DEFAULT_AGENCY_ID,
      releasedBy: "operator",
    });
    assert.equal(released, true);
    const releasedTwice = await releaseSuppression(db.kysely, {
      id: first.id,
      agencyId: DEFAULT_AGENCY_ID,
      releasedBy: "operator",
    });
    assert.equal(releasedTwice, false, "already-released rows are not re-released");

    const fresh = await addSuppression(db.kysely, {
      agencyId: DEFAULT_AGENCY_ID,
      scope: "phone",
      normalizedValue: "+15125550101",
      reason: "suppressed again",
      requestedBy: "operator",
    });
    assert.notEqual(fresh.id, first.id, "re-suppress after release is a NEW row (history preserved)");

    const all = await listSuppressions(db.kysely, DEFAULT_AGENCY_ID, { includeReleased: true });
    assert.equal(all.length, 2);
    const active = await listSuppressions(db.kysely, DEFAULT_AGENCY_ID);
    assert.equal(active.length, 1);
    assert.equal(active[0]?.reason, "suppressed again");
  } finally {
    await db.close();
  }
});

test("suppressions: findActiveSuppressions matches per scope and ignores released rows", async () => {
  const db = await connectDb("pglite://memory");
  try {
    await migrate(db);
    const phone = await addSuppression(db.kysely, {
      agencyId: DEFAULT_AGENCY_ID,
      scope: "phone",
      normalizedValue: "+15125550102",
      reason: "dnc",
      requestedBy: "op",
    });
    await addSuppression(db.kysely, {
      agencyId: DEFAULT_AGENCY_ID,
      scope: "email",
      normalizedValue: "owner@suppressed.example",
      reason: "dnc",
      requestedBy: "op",
    });
    await addSuppression(db.kysely, {
      agencyId: DEFAULT_AGENCY_ID,
      scope: "domain",
      normalizedValue: "suppressed.example",
      reason: "client asked",
      requestedBy: "op",
    });
    const leadId = "11111111-1111-1111-1111-111111111111";
    await addSuppression(db.kysely, {
      agencyId: DEFAULT_AGENCY_ID,
      scope: "lead",
      normalizedValue: leadId,
      reason: "dnc",
      requestedBy: "op",
    });

    const none = await findActiveSuppressions(db.kysely, DEFAULT_AGENCY_ID, {});
    assert.deepEqual(none, [], "no criteria means no matches (never a full-table scan result)");

    const matches = await findActiveSuppressions(db.kysely, DEFAULT_AGENCY_ID, {
      phones: ["+15125550102", "+15125559999"],
      emails: ["other@ok.example"],
      domains: ["suppressed.example"],
      leadIds: [leadId],
    });
    const byScope = new Map(matches.map((m) => [m.scope, m.normalized_value]));
    assert.equal(byScope.get("phone"), "+15125550102");
    assert.equal(byScope.get("domain"), "suppressed.example");
    assert.equal(byScope.get("lead"), leadId);
    assert.equal(byScope.has("email"), false, "email value was not in criteria list");

    // A phone value must not match in the email scope (scope/value pairs are grouped).
    const crossScope = await findActiveSuppressions(db.kysely, DEFAULT_AGENCY_ID, {
      emails: ["+15125550102"],
    });
    assert.deepEqual(crossScope, []);

    await releaseSuppression(db.kysely, { id: phone.id, agencyId: DEFAULT_AGENCY_ID, releasedBy: "op" });
    const afterRelease = await findActiveSuppressions(db.kysely, DEFAULT_AGENCY_ID, {
      phones: ["+15125550102"],
    });
    assert.deepEqual(afterRelease, [], "released suppressions never match");
  } finally {
    await db.close();
  }
});
