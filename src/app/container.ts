import type { Env } from "../config/env.js";
import { parseEnv } from "../config/env.js";
import type { RunnerDeps } from "../engine/runner/runner.js";
import { InProcessRunWorker, type JobQueue } from "../jobs/run-worker.js";
import { buildFakeRegistry } from "../providers/registry.js";
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
  worker: JobQueue;
  runnerDeps: RunnerDeps;
  agencyId: string;
  actor: string;
  close(): Promise<void>;
}

export async function createContainer(
  overrides: Partial<Env> & { actor?: string } = {},
): Promise<AppContainer> {
  const env: Env = { ...parseEnv(), ...overrides };
  const db = await connectDb(env.DATABASE_URL);
  const providers = buildFakeRegistry({ enrichLedgerPath: env.FAKE_ENRICH_LEDGER_PATH });
  const actor = overrides.actor ?? "cli";
  const runnerDeps: RunnerDeps = {
    db,
    providers,
    leaseTtlSeconds: env.LEASE_TTL_SECONDS,
    maxStepAttempts: env.MAX_STEP_ATTEMPTS,
    exportDir: env.EXPORT_DIR,
    actor,
  };
  return {
    env,
    db,
    providers,
    worker: new InProcessRunWorker(runnerDeps),
    runnerDeps,
    agencyId: DEFAULT_AGENCY_ID,
    actor,
    close: () => db.close(),
  };
}

/**
 * Derive an actor-scoped view of a container (same db/providers/env). The MCP
 * server uses this after the initialize handshake to attribute reviews and
 * approvals to `mcp:<clientName>` without reconnecting the database.
 */
export function withActor(app: AppContainer, actor: string): AppContainer {
  const runnerDeps: RunnerDeps = { ...app.runnerDeps, actor };
  return { ...app, actor, runnerDeps, worker: new InProcessRunWorker(runnerDeps) };
}
