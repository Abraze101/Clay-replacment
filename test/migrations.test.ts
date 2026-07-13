import assert from "node:assert/strict";
import { test } from "node:test";

import { connectDb } from "../src/storage/db.js";
import { migrate, migrationStatus } from "../src/storage/migrate.js";
import { MIGRATIONS } from "../src/storage/migrations/index.js";
import { DEFAULT_AGENCY_ID } from "../src/storage/repositories/repo-util.js";

test("migrations: apply once, re-run is a no-op, checksums recorded", async () => {
  const db = await connectDb("pglite://memory");
  try {
    const first = await migrate(db);
    assert.deepEqual(first.applied, ["0001_init", "0002_m1", "0003_m3", "0004_m4"]);

    const second = await migrate(db);
    assert.deepEqual(second.applied, []);
    assert.deepEqual(second.alreadyApplied, ["0001_init", "0002_m1", "0003_m3", "0004_m4"]);

    const status = await migrationStatus(db);
    assert.equal(status.length, MIGRATIONS.length);
    assert.ok(status[0]?.appliedAt);
  } finally {
    await db.close();
  }
});

test("migrations: seeded default agency exists with the fixed UUID", async () => {
  const db = await connectDb("pglite://memory");
  try {
    await migrate(db);
    const agencies = await db.kysely.selectFrom("agencies").selectAll().execute();
    assert.equal(agencies.length, 1);
    assert.equal(agencies[0]?.id, DEFAULT_AGENCY_ID);
  } finally {
    await db.close();
  }
});

test("migrations: editing an applied migration is detected as a checksum mismatch", async () => {
  const db = await connectDb("pglite://memory");
  try {
    await migrate(db);
    const tampered = [{ ...MIGRATIONS[0]!, checksum: "deadbeef" }];
    await assert.rejects(
      () => migrate(db, tampered),
      (err: Error) => err.message.includes("checksum") || err.message.includes("Checksum") || /MIGRATION/.test(String((err as { code?: string }).code)),
    );
  } finally {
    await db.close();
  }
});

test("migrations: 0001 creates the 12 domain tables", async () => {
  const db = await connectDb("pglite://memory");
  try {
    await migrate(db);
    const result = await db.kysely
      .selectFrom("schema_migrations")
      .select(({ fn }) => fn.countAll().as("n"))
      .executeTakeFirst();
    assert.ok(result);
    for (const table of [
      "agencies",
      "workflows",
      "workflow_versions",
      "leads",
      "runs",
      "run_items",
      "run_item_steps",
      "lead_sources",
      "contact_points",
      "contact_point_checks",
      "generated_outputs",
      "exports",
    ]) {
      // A trivial select proves the table exists with expected shape.
      await db.rawExec(`SELECT * FROM ${table} LIMIT 0;`);
    }
  } finally {
    await db.close();
  }
});

test("migrations: 0002 adds users, approval_tokens, and created_by attribution (additive)", async () => {
  const db = await connectDb("pglite://memory");
  try {
    await migrate(db);
    await db.rawExec("SELECT id, agency_id, email, role FROM users LIMIT 0;");
    await db.rawExec(
      "SELECT id, nonce, scope_hash, enrichment_profile, paid_record_cap, expires_at, consumed_at, consumed_by_run_id FROM approval_tokens LIMIT 0;",
    );
    await db.rawExec("SELECT created_by FROM workflows LIMIT 0;");
    await db.rawExec("SELECT created_by FROM workflow_versions LIMIT 0;");
  } finally {
    await db.close();
  }
});

test("migrations: 0003 adds M3 scheduling columns and the run_source_requests ledger (additive)", async () => {
  const db = await connectDb("pglite://memory");
  try {
    await migrate(db);
    // New columns on existing tables.
    await db.rawExec("SELECT place_id, timezone FROM leads LIMIT 0;");
    await db.rawExec("SELECT snapshot_expires_at FROM lead_sources LIMIT 0;");
    await db.rawExec("SELECT resume_at FROM runs LIMIT 0;");
    await db.rawExec("SELECT next_attempt_at FROM run_item_steps LIMIT 0;");
    // New durable source-request ledger table.
    await db.rawExec(
      "SELECT id, run_id, step_id, request_index, descriptor, status, attempts, request_key, provider_request_id, cost_units, records_inserted, coverage_note, last_error FROM run_source_requests LIMIT 0;",
    );
  } finally {
    await db.close();
  }
});

test("migrations: 0004 adds M4 identity columns and identity_conflicts (additive)", async () => {
  const db = await connectDb("pglite://memory");
  try {
    await migrate(db);
    // New identity columns on leads.
    await db.rawExec(
      "SELECT apollo_person_id, apollo_organization_id, normalized_linkedin_url, verified_email FROM leads LIMIT 0;",
    );
    // New identity_conflicts table.
    await db.rawExec(
      "SELECT id, lead_id_a, lead_id_b, identifier_type, identifier_value, run_id, detected_at, status, resolved_by, resolved_at FROM identity_conflicts LIMIT 0;",
    );

    // Partial uniques enforce agency-scoped identity; two NULLs stay legal.
    const agency = "00000000-0000-0000-0000-000000000001";
    await db.rawExec(
      `INSERT INTO leads (agency_id, kind, display_name, apollo_person_id) VALUES ('${agency}', 'person', 'Person A', 'apollo-p-1');`,
    );
    await assert.rejects(
      () =>
        db.rawExec(
          `INSERT INTO leads (agency_id, kind, display_name, apollo_person_id) VALUES ('${agency}', 'person', 'Person B', 'apollo-p-1');`,
        ),
      /unique|duplicate/i,
    );
    // Org uniqueness applies to business leads only: a person lead may carry
    // the employer's org id without owning the org identity.
    await db.rawExec(
      `INSERT INTO leads (agency_id, kind, display_name, apollo_organization_id) VALUES ('${agency}', 'business', 'Org Lead', 'apollo-o-1');`,
    );
    await db.rawExec(
      `INSERT INTO leads (agency_id, kind, display_name, apollo_organization_id) VALUES ('${agency}', 'person', 'Person C', 'apollo-o-1');`,
    );

    // identity_conflicts: ordered-pair CHECK and idempotent re-raise.
    const rows = await db.kysely.selectFrom("leads").select(["id"]).orderBy("created_at").execute();
    const [a, b] = [rows[0]!.id, rows[1]!.id].sort();
    await db.rawExec(
      `INSERT INTO identity_conflicts (lead_id_a, lead_id_b, identifier_type, identifier_value) VALUES ('${a}', '${b}', 'apollo_person_id', 'apollo-p-1');`,
    );
    await db.rawExec(
      `INSERT INTO identity_conflicts (lead_id_a, lead_id_b, identifier_type, identifier_value) VALUES ('${a}', '${b}', 'apollo_person_id', 'apollo-p-1') ON CONFLICT DO NOTHING;`,
    );
    await assert.rejects(
      () =>
        db.rawExec(
          `INSERT INTO identity_conflicts (lead_id_a, lead_id_b, identifier_type, identifier_value) VALUES ('${b}', '${a}', 'apollo_person_id', 'x');`,
        ),
      /check|ordered/i,
    );
  } finally {
    await db.close();
  }
});
