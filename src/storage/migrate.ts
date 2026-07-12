import { AppError } from "../shared/errors.js";
import { iso } from "../shared/clock.js";
import type { Db } from "./db.js";
import type { Migration } from "./migrations/index.js";
import { MIGRATIONS } from "./migrations/index.js";

const LEDGER_DDL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  id         text PRIMARY KEY,
  checksum   text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);
`;

export interface MigrationStatus {
  id: string;
  checksum: string;
  appliedAt: string | null;
}

export interface MigrateResult {
  applied: string[];
  alreadyApplied: string[];
}

/**
 * Apply pending migrations in order. Each migration runs atomically
 * (BEGIN/COMMIT around DDL + ledger insert); an already-applied migration is
 * verified against its stored checksum and re-application is a no-op.
 */
export async function migrate(db: Db, migrations: readonly Migration[] = MIGRATIONS): Promise<MigrateResult> {
  await db.rawExec(LEDGER_DDL);
  const appliedRows = await db.kysely.selectFrom("schema_migrations").selectAll().execute();
  const appliedById = new Map(appliedRows.map((r) => [r.id, r]));

  const result: MigrateResult = { applied: [], alreadyApplied: [] };
  for (const migration of migrations) {
    const existing = appliedById.get(migration.id);
    if (existing) {
      if (existing.checksum !== migration.checksum) {
        throw new AppError(
          "MIGRATION_CHECKSUM_MISMATCH",
          `Migration ${migration.id} was applied with checksum ${existing.checksum} but the embedded SQL now hashes to ${migration.checksum}. Applied migrations must never be edited.`,
          { migrationId: migration.id },
        );
      }
      result.alreadyApplied.push(migration.id);
      continue;
    }

    // id/checksum are engine-generated (safe literals: [0-9a-z_] and hex).
    const record = `INSERT INTO schema_migrations (id, checksum) VALUES ('${migration.id}', '${migration.checksum}');`;
    try {
      await db.rawExec(`BEGIN;\n${migration.sql}\n${record}\nCOMMIT;`);
    } catch (err) {
      await db.rawExec("ROLLBACK;").catch(() => undefined);
      throw err;
    }
    result.applied.push(migration.id);
  }
  return result;
}

/** Migration status for `leads db status`: registry order with applied timestamps. */
export async function migrationStatus(
  db: Db,
  migrations: readonly Migration[] = MIGRATIONS,
): Promise<MigrationStatus[]> {
  await db.rawExec(LEDGER_DDL);
  const appliedRows = await db.kysely.selectFrom("schema_migrations").selectAll().execute();
  const appliedById = new Map(appliedRows.map((r) => [r.id, r]));
  return migrations.map((m) => ({
    id: m.id,
    checksum: m.checksum,
    appliedAt: iso(appliedById.get(m.id)?.applied_at ?? null),
  }));
}
