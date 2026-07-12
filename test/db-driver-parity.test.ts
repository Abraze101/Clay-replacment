import assert from "node:assert/strict";
import { test } from "node:test";

import { connectDb } from "../src/storage/db.js";
import { migrate } from "../src/storage/migrate.js";
import { toJson } from "../src/storage/repositories/repo-util.js";

/**
 * Driver parity: the same DDL and basic roundtrips must behave identically on
 * embedded PGlite and real Postgres. The pg path is exercised only when
 * TEST_PG_URL is provided (no Docker requirement in default CI).
 */
async function roundtrip(databaseUrl: string): Promise<void> {
  const db = await connectDb(databaseUrl);
  try {
    await migrate(db);
    const workflow = await db.kysely
      .insertInto("workflows")
      .values({
        agency_id: "00000000-0000-0000-0000-000000000001",
        slug: `parity-${Date.now()}`,
        name: "Parity",
        description: null,
        draft_definition: toJson({ a: [1, 2, 3] }),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    // jsonb roundtrip: written as string, read back as object (never a Postgres array literal).
    assert.deepEqual(workflow.draft_definition, { a: [1, 2, 3] });
    // uuid default + timestamptz default present
    assert.match(workflow.id, /^[0-9a-f-]{36}$/);
    assert.ok(workflow.created_at);
  } finally {
    await db.close();
  }
}

test("db parity: PGlite roundtrip", async () => {
  await roundtrip("pglite://memory");
});

test("db parity: Postgres roundtrip (gated on TEST_PG_URL)", { skip: !process.env.TEST_PG_URL }, async () => {
  await roundtrip(process.env.TEST_PG_URL as string);
});
