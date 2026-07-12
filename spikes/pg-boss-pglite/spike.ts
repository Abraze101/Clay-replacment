/**
 * pg-boss / PGlite compatibility spike (Milestone 0 deliverable).
 *
 * pg-boss ships `fromPglite`, but that support is new — the consolidated
 * revision directive mandates this bounded spike before adoption (ADR-002 in
 * docs/decisions.md). Scope, in order:
 *
 *   1. fromPglite bootstrap: schema install + start on a FILESYSTEM PGlite.
 *   2. Filesystem persistence across stop → close → reopen.
 *   3. In-flight job recovery after a simulated crashed worker (expiration +
 *      supervise → job becomes retryable, never lost).
 *   4. Retry/backoff: bounded retries then a terminal 'failed' state.
 *   5. Duplicate-claim prevention under concurrent fetches.
 *   6. Cancellation.
 *   7. Modest concurrency: N async workers, every job completed exactly once.
 *   8. Transaction interaction: enqueue inside an application PGlite
 *      transaction via the per-call `db` override — rollback discards the job,
 *      commit keeps it.
 *
 * Run: pnpm spike:pgboss   (offline; writes only under .data/spike-*)
 * This spike is NOT part of `pnpm check`; it feeds the ADR-002 decision.
 */
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { PgBoss, fromPglite, type Db as BossDb } from "pg-boss";

const DATA_DIR = path.resolve(".data", `spike-pg-boss-${process.pid}`);
const QUEUE = "spike-queue";

interface ScenarioResult {
  name: string;
  pass: boolean;
  note: string;
}

const results: ScenarioResult[] = [];

function record(name: string, pass: boolean, note: string): void {
  results.push({ name, pass, note });
  process.stdout.write(`${pass ? "PASS" : "FAIL"}  ${name} — ${note}\n`);
}

async function openBoss(pglite: PGlite): Promise<PgBoss> {
  const boss = new PgBoss({
    db: fromPglite(pglite),
    supervise: false, // the spike drives maintenance explicitly
    schedule: false,
  });
  boss.on("error", () => undefined);
  await boss.start();
  return boss;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  rmSync(DATA_DIR, { recursive: true, force: true });
  mkdirSync(DATA_DIR, { recursive: true });
  const dbPath = path.join(DATA_DIR, "queue-db");

  // 1. Bootstrap on filesystem PGlite ---------------------------------------
  let pglite = new PGlite(dbPath);
  await pglite.waitReady;
  let boss = await openBoss(pglite);
  const installed = await boss.isInstalled();
  const version = await boss.schemaVersion();
  await boss.createQueue(QUEUE);
  record("1 fromPglite bootstrap", installed && version !== null, `schema installed, version ${version}`);

  // 2. Persistence across stop → close → reopen ------------------------------
  const persistedId = await boss.send(QUEUE, { marker: "persist-me" });
  await boss.stop({ graceful: false });
  await pglite.close();
  pglite = new PGlite(dbPath);
  await pglite.waitReady;
  boss = await openBoss(pglite);
  const persisted = persistedId ? await boss.getJobById(QUEUE, persistedId) : null;
  record(
    "2 filesystem persistence + restart",
    persisted?.state === "created" && (persisted.data as { marker?: string }).marker === "persist-me",
    `job ${persistedId ?? "?"} state after reopen: ${persisted?.state ?? "missing"}`,
  );
  // Drain scenario 2's job so later fetches see only their own scenario's work.
  if (persistedId) {
    const drained = await boss.fetch(QUEUE);
    for (const j of drained) await boss.complete(QUEUE, j.id);
  }

  // 3. In-flight recovery after a "crashed" worker ---------------------------
  const recoveryId = await boss.send(QUEUE, { marker: "recover-me" }, { expireInSeconds: 1, retryLimit: 1, retryDelay: 0 });
  const fetchedForCrash = await boss.fetch(QUEUE);
  const crashed = fetchedForCrash.some((j) => j.id === recoveryId);
  // Simulate the crash: stop without completing, close, reopen.
  await boss.stop({ graceful: false });
  await pglite.close();
  pglite = new PGlite(dbPath);
  await pglite.waitReady;
  boss = await openBoss(pglite);
  await sleep(1_200); // let the active job pass its expiration
  await boss.supervise(QUEUE); // maintenance requeues expired work
  const afterCrash = recoveryId ? await boss.getJobById(QUEUE, recoveryId) : null;
  const refetched = await boss.fetch(QUEUE);
  const recovered = refetched.some((j) => j.id === recoveryId);
  record(
    "3 crashed-worker recovery",
    crashed && recovered,
    `fetched pre-crash: ${crashed}; state after supervise: ${afterCrash?.state ?? "?"}; refetched: ${recovered}`,
  );
  if (recoveryId) await boss.complete(QUEUE, recoveryId);

  // 4. Retry then terminal failed --------------------------------------------
  const retryId = await boss.send(QUEUE, { marker: "retry-me" }, { retryLimit: 2, retryDelay: 0 });
  let attempts = 0;
  for (; attempts < 5; attempts += 1) {
    await boss.supervise(QUEUE);
    const jobs = await boss.fetch(QUEUE);
    const mine = jobs.find((j) => j.id === retryId);
    if (!mine) {
      if ((await boss.getJobById(QUEUE, retryId as string))?.state === "failed") break;
      await sleep(150);
      continue;
    }
    await boss.fail(QUEUE, mine.id, { reason: `attempt ${attempts + 1}` });
  }
  const retryFinal = await boss.getJobById(QUEUE, retryId as string);
  record(
    "4 retry/backoff to terminal failed",
    retryFinal?.state === "failed" && retryFinal.retryCount === 2,
    `state ${retryFinal?.state ?? "?"}, retryCount ${retryFinal?.retryCount ?? "?"} (limit 2)`,
  );

  // 5. Duplicate-claim prevention --------------------------------------------
  const dupIds = new Set<string>();
  for (let i = 0; i < 10; i += 1) {
    const id = await boss.send(QUEUE, { n: i });
    if (id) dupIds.add(id);
  }
  const [batchA, batchB] = await Promise.all([
    boss.fetch(QUEUE, { batchSize: 10 }),
    boss.fetch(QUEUE, { batchSize: 10 }),
  ]);
  const overlap = batchA.filter((a) => batchB.some((b) => b.id === a.id));
  record(
    "5 duplicate-claim prevention",
    overlap.length === 0 && batchA.length + batchB.length === 10,
    `concurrent fetches claimed ${batchA.length}+${batchB.length} jobs, overlap ${overlap.length}`,
  );
  for (const j of [...batchA, ...batchB]) await boss.complete(QUEUE, j.id);

  // 6. Cancellation -----------------------------------------------------------
  const cancelId = await boss.send(QUEUE, { marker: "cancel-me" });
  await boss.cancel(QUEUE, cancelId as string);
  const cancelled = await boss.getJobById(QUEUE, cancelId as string);
  const postCancelFetch = await boss.fetch(QUEUE, { batchSize: 5 });
  record(
    "6 cancellation",
    cancelled?.state === "cancelled" && !postCancelFetch.some((j) => j.id === cancelId),
    `state ${cancelled?.state ?? "?"}, fetchable ${postCancelFetch.some((j) => j.id === cancelId)}`,
  );

  // 7. Modest concurrency: 20 jobs, 4 workers, exactly-once ------------------
  const total = 20;
  for (let i = 0; i < total; i += 1) await boss.send(QUEUE, { n: i });
  const seen = new Map<string, number>();
  async function worker(): Promise<void> {
    for (;;) {
      const jobs = await boss.fetch(QUEUE);
      if (jobs.length === 0) return;
      for (const job of jobs) {
        seen.set(job.id, (seen.get(job.id) ?? 0) + 1);
        await boss.complete(QUEUE, job.id);
      }
    }
  }
  await Promise.all([worker(), worker(), worker(), worker()]);
  const doubleClaims = [...seen.values()].filter((n) => n > 1).length;
  record(
    "7 modest concurrency exactly-once",
    seen.size === total && doubleClaims === 0,
    `${seen.size}/${total} jobs completed, ${doubleClaims} double-claims`,
  );

  // 8. Enqueue inside an application transaction ------------------------------
  function txDb(tx: { query: <T>(q: string, params?: unknown[]) => Promise<{ rows: T[] }> }): BossDb {
    return { executeSql: async (text, values) => await tx.query(text, values) };
  }
  let rolledBackId: string | null = null;
  await pglite
    .transaction(async (tx) => {
      rolledBackId = await boss.send(QUEUE, { marker: "rollback-me" }, { db: txDb(tx) });
      await tx.rollback();
    })
    .catch(() => undefined);
  const afterRollback = rolledBackId ? await boss.getJobById(QUEUE, rolledBackId) : null;

  let committedId: string | null = null;
  await pglite.transaction(async (tx) => {
    committedId = await boss.send(QUEUE, { marker: "commit-me" }, { db: txDb(tx) });
  });
  const afterCommit = committedId ? await boss.getJobById(QUEUE, committedId) : null;
  record(
    "8 transaction interaction (per-call db override)",
    afterRollback === null && afterCommit?.state === "created",
    `rolled-back job visible: ${afterRollback !== null}; committed job state: ${afterCommit?.state ?? "missing"}`,
  );
  if (committedId) await boss.complete(QUEUE, committedId);

  await boss.stop({ graceful: false });
  await pglite.close();
  rmSync(DATA_DIR, { recursive: true, force: true });

  const failed = results.filter((r) => !r.pass);
  process.stdout.write(`\npg-boss@12 on PGlite: ${results.length - failed.length}/${results.length} scenarios passed.\n`);
  process.stdout.write("Record the outcome in docs/decisions.md ADR-002 (pending → accepted/rejected).\n");
  if (failed.length > 0) process.exitCode = 1;
}

main().catch((err: unknown) => {
  console.error("Spike crashed:", err);
  process.exitCode = 1;
});
