import type { Env } from "../config/env.js";
import { parseEnv } from "../config/env.js";
import type { RunnerDeps } from "../engine/runner/runner.js";
import { InProcessRunWorker, type JobQueue } from "../jobs/run-worker.js";
import { PgBossRunWorker } from "../jobs/pg-boss-worker.js";
import { buildRegistry, knownProviders, type ProviderCatalogEntry } from "../providers/registry.js";
import type { ProviderRegistry } from "../providers/types.js";
import type { Db } from "../storage/db.js";
import { connectDb } from "../storage/db.js";
import { DEFAULT_AGENCY_ID } from "../storage/repositories/repo-util.js";

/**
 * The composition root shared by every interface: the CLI is a thin adapter
 * over this container, and the M1 MCP server and M2 UI reuse it unchanged.
 * No interface duplicates business logic.
 */
export interface AppContainer {
  env: Env;
  db: Db;
  providers: ProviderRegistry;
  /** Live providers the product can use, including unconfigured ones (connected:false). */
  providerCatalog: ProviderCatalogEntry[];
  worker: JobQueue;
  runnerDeps: RunnerDeps;
  agencyId: string;
  actor: string;
  close(): Promise<void>;
}

export async function createContainer(
  overrides: Partial<Env> & { actor?: string; jobDriver?: "inprocess" | "pgboss" } = {},
): Promise<AppContainer> {
  const env: Env = { ...parseEnv(), ...overrides };
  const db = await connectDb(env.DATABASE_URL);
  const providers = buildRegistry(env, {
    enrichLedgerPath: env.FAKE_ENRICH_LEDGER_PATH,
    capabilityLedgerPath: env.FAKE_CAPABILITY_LEDGER_PATH,
    db: db.kysely,
  });
  const actor = overrides.actor ?? "cli";
  const runnerDeps: RunnerDeps = {
    db,
    providers,
    leaseTtlSeconds: env.LEASE_TTL_SECONDS,
    maxStepAttempts: env.MAX_STEP_ATTEMPTS,
    exportDir: env.EXPORT_DIR,
    actor,
    generateMaxOutputTokens: env.GENERATE_MAX_OUTPUT_TOKENS,
  };
  // Driver selection: the caller's explicit choice wins (leads worker forces
  // pgboss); long-lived entries (web, mcp) pass defaultJobDriver('pgboss') so
  // delayed rate-limit resumes actually fire, still overridable via JOB_DRIVER;
  // one-shot CLI stays in-process and self-heals short pauses inline.
  const jobDriver = overrides.jobDriver ?? env.JOB_DRIVER ?? "inprocess";
  const worker: JobQueue =
    jobDriver === "pgboss"
      ? new PgBossRunWorker(runnerDeps, db)
      : new InProcessRunWorker(runnerDeps, { maxInlineWaitSeconds: env.RATE_LIMIT_INLINE_WAIT_MAX_SECONDS });
  return {
    env,
    db,
    providers,
    providerCatalog: knownProviders(env),
    worker,
    runnerDeps,
    agencyId: DEFAULT_AGENCY_ID,
    actor,
    close: async () => {
      if (worker instanceof PgBossRunWorker) await worker.stop();
      await db.close();
    },
  };
}

/**
 * Derive an actor-scoped view of a container (same db/providers/env). The MCP
 * server uses this after the initialize handshake to attribute reviews and
 * approvals to `mcp:<clientName>` without reconnecting the database.
 */
/**
 * Entry-point driver default that still honors an explicit JOB_DRIVER env
 * override (the container gives the caller's jobDriver precedence, so entries
 * must resolve the env themselves before passing their default).
 */
export function defaultJobDriver(entryDefault: "pgboss" | "inprocess"): "pgboss" | "inprocess" {
  const fromEnv = process.env["JOB_DRIVER"];
  return fromEnv === "pgboss" || fromEnv === "inprocess" ? fromEnv : entryDefault;
}

export function withActor(app: AppContainer, actor: string): AppContainer {
  const runnerDeps: RunnerDeps = { ...app.runnerDeps, actor };
  // Reuse the SAME worker instance: a second pg-boss on one pglite:// directory
  // would break the single-driver invariant, and the runner does not read
  // deps.actor (attribution happens in the app services via app.actor).
  return { ...app, actor, runnerDeps, worker: app.worker };
}
