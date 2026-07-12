import { sha256Hex } from "../../shared/checksum.js";
import { MIGRATION_0001_INIT } from "./0001-init.js";
import { MIGRATION_0002_M1 } from "./0002-m1.js";
import { MIGRATION_0003_M3 } from "./0003-m3.js";

export interface Migration {
  id: string;
  sql: string;
  checksum: string;
}

function define(id: string, sql: string): Migration {
  return { id, sql, checksum: sha256Hex(sql) };
}

/**
 * Ordered migration registry. Later milestones append here (0002 M1, 0003 M3,
 * 0004 M4, 0005 M5, 0006 M6 per docs/proposals/database-schema.md); applied
 * migrations are never edited — the runner verifies stored checksums.
 */
export const MIGRATIONS: readonly Migration[] = [
  define("0001_init", MIGRATION_0001_INIT),
  define("0002_m1", MIGRATION_0002_M1),
  define("0003_m3", MIGRATION_0003_M3),
];
