import assert from "node:assert/strict";
import { test } from "node:test";

import { createWorkflowFromDefinition } from "../src/app/workflow-service.js";
import { getLead, listContactPoints } from "../src/storage/repositories/lead-repo.js";
import { listRunItems } from "../src/storage/repositories/run-repo.js";
import { createTestApp, previewAndStart } from "./helpers/setup.js";

const DEFINITION = {
  id: "verified-email-test",
  version: 1,
  name: "Verified email writer test",
  inputs: { limit: 10, enrichmentProfile: "call_ready" },
  steps: [
    { id: "import", type: "source", provider: "imported-list" },
    { id: "normalize", type: "normalize" },
    { id: "dedupe", type: "dedupe" },
    { id: "verify-email", type: "enrich", capability: "email_verification", profiles: ["call_ready", "full"] },
  ],
};

test("verified_email: ONLY a 'valid' deliverability result writes it; catch_all/unknown/role never do; conflicts flag", async () => {
  const t = await createTestApp();
  try {
    const created = await createWorkflowFromDefinition(t.app, DEFINITION);
    const inputs = {
      importRows: [
        { name: "Valid Co", website: "https://valid-co.example", email: "owner@valid-co.example" },
        { name: "Catchall Co", website: "https://catchall-co.example", email: "catchall@catchall-co.example" },
        { name: "Unknown Co", website: "https://unknown-co.example", email: "unknown@unknown-co.example" },
        { name: "Role Co", website: "https://role-co.example", email: "info@role-co.example" },
      ],
    };
    const { run } = await previewAndStart(t.app, created.slug, { profile: "call_ready", inputs });
    assert.equal(run.status, "completed");

    const items = await listRunItems(t.app.db.kysely, run.id);
    const byName = new Map<string, string>();
    for (const item of items) {
      const name = (item.snapshot as { source?: { name?: string } }).source?.name ?? "";
      if (item.lead_id) byName.set(name, item.lead_id);
    }

    // 'valid' → verified_email set on the lead AND the contact point upgraded.
    const validLead = await getLead(t.app.db.kysely, byName.get("Valid Co")!);
    assert.equal(validLead?.verified_email, "owner@valid-co.example");
    const validCp = (await listContactPoints(t.app.db.kysely, validLead.id)).find((cp) => cp.type === "email");
    assert.equal(validCp?.email_status, "valid");
    assert.equal(validCp?.email_status_provider, "fake-email-verification");

    // catch_all / unknown / role_based: status recorded, verified_email NEVER set.
    for (const [name, expected] of [
      ["Catchall Co", "catch_all"],
      ["Unknown Co", "unknown"],
      ["Role Co", "role_based"],
    ] as const) {
      const lead = await getLead(t.app.db.kysely, byName.get(name)!);
      assert.equal(lead?.verified_email, null, `${name}: a '${expected}' result never sets verified_email`);
      const cp = (await listContactPoints(t.app.db.kysely, lead.id)).find((c) => c.type === "email");
      assert.equal(cp?.email_status, expected);
      assert.ok(cp?.email_status_checked_at, "the check is honestly timestamped");
    }
  } finally {
    await t.teardown();
  }
});

test("verified_email: a second lead verifying the same address flags an identity conflict and stays NULL", async () => {
  const t = await createTestApp();
  try {
    const created = await createWorkflowFromDefinition(t.app, DEFINITION);
    const first = await previewAndStart(t.app, created.slug, {
      profile: "call_ready",
      inputs: { importRows: [{ name: "Original Holder", website: "https://valid-co.example", email: "owner@valid-co.example" }] },
    });
    assert.equal(first.run.status, "completed");

    // A DIFFERENT lead (different domain → no dedupe match) with the same email.
    const second = await previewAndStart(t.app, created.slug, {
      profile: "call_ready",
      inputs: { importRows: [{ name: "Copycat LLC", website: "https://copycat.example", email: "owner@valid-co.example" }] },
    });
    assert.equal(second.run.status, "completed");

    const secondItems = await listRunItems(t.app.db.kysely, second.run.id);
    const copycatLeadId = secondItems[0]?.lead_id;
    assert.ok(copycatLeadId);
    const copycat = await getLead(t.app.db.kysely, copycatLeadId);
    assert.equal(copycat?.verified_email, null, "the holder keeps the identity; no automatic merge");

    const conflicts = await t.app.db.kysely
      .selectFrom("identity_conflicts")
      .selectAll()
      .where("identifier_type", "=", "verified_email")
      .execute();
    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0]?.identifier_value, "owner@valid-co.example");
    assert.equal(conflicts[0]?.status, "open");
  } finally {
    await t.teardown();
  }
});
