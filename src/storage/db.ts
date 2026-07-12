import { PGlite } from "@electric-sql/pglite";
import { Kysely, PGliteDialect, PostgresDialect } from "kysely";
import pg from "pg";

import type { Database } from "./database-types.js";

export type DbKind = "pglite" | "pg";

/**
 * The storage handle shared by repositories, the migration runner, and tests.
 * Kysely provides typed queries over either driver; `rawExec` runs
 * multi-statement SQL (migrations) directly on the underlying driver.
 */
export interface Db {
  readonly kind: DbKind;
  readonly kysely: Kysely<Database>;
  rawExec(sql: string): Promise<void>;
  close(): Promise<void>;
}

/**
 * Connect from a DATABASE_URL.
 * - `pglite://memory` → in-memory PGlite (tests)
 * - `pglite://<path>` → embedded PGlite persisted at <path>
 * - `postgresql://...` → node-postgres Pool
 */
export async function connectDb(databaseUrl: string): Promise<Db> {
  if (databaseUrl.startsWith("pglite://")) {
    const target = databaseUrl.slice("pglite://".length);
    const pglite = target === "memory" || target === "" ? new PGlite() : new PGlite(target);
    await pglite.waitReady;
    const kysely = new Kysely<Database>({ dialect: new PGliteDialect({ pglite }) });
    return {
      kind: "pglite",
      kysely,
      rawExec: async (sql) => {
        await pglite.exec(sql);
      },
      close: async () => {
        await kysely.destroy();
        if (!pglite.closed) await pglite.close();
      },
    };
  }

  if (databaseUrl.startsWith("postgresql://") || databaseUrl.startsWith("postgres://")) {
    const pool = new pg.Pool({ connectionString: databaseUrl });
    const kysely = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
    return {
      kind: "pg",
      kysely,
      rawExec: async (sql) => {
        // Simple-protocol multi-statement query; Postgres wraps it in an
        // implicit transaction unless the SQL manages its own.
        await pool.query(sql);
      },
      close: async () => {
        await kysely.destroy();
      },
    };
  }

  throw new Error(`Unsupported DATABASE_URL scheme: ${databaseUrl}`);
}
