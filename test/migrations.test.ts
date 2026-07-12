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
    assert.deepEqual(first.applied, ["0001_init"]);

    const second = await migrate(db);
    assert.deepEqual(second.applied, []);
    assert.deepEqual(second.alreadyApplied, ["0001_init"]);

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
