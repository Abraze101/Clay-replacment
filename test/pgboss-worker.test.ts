import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";

import type { AppContainer } from "../src/app/container.js";
import { createContainer } from "../src/app/container.js";
import { previewAndStart } from "./helpers/setup.js";
import { previewRun, runStatus, startRun } from "../src/app/run-service.js";
import { createWorkflowFromDefinition } from "../src/app/workflow-service.js";
import { migrate } from "../src/storage/migrate.js";
import { ScriptedPagedSource, type ScriptedSourceOptions } from "./helpers/scripted-source.js";

async function createLbWorkflow(app: AppContainer, locations: string[]): Promise<string> {
  const created = await createWorkflowFromDefinition(app, {
    id: "lb-quicklist",
    version: 1,
    name: "LB quick list",
    inputs: { businessType: "roofing contractor", locations, limit: 50, enrichmentProfile: "quick_list" },
    steps: [
      { id: "discover", type: "source", provider: "local-business" },
      { id: "normalize", type: "normalize" },
      { id: "dedupe", type: "dedupe" },
      { id: "review", type: "review_gate" },
      { id: "export", type: "export", format: "csv" },
    ],
  });
  return created.slug;
}

async function waitForStatus(app: AppContainer, runId: string, want: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = (await runStatus(app, runId)).status;
    if (status === want || Date.now() > deadline) return status;
    await sleep(150);
  }
}

async function pgbossApp(tempDir: string, driver: "pgboss" | "inprocess", sourceOpts: ScriptedSourceOptions) {
  const app = await createContainer({
    DATABASE_URL: `pglite://${path.join(tempDir, "db")}`,
    EXPORT_DIR: path.join(tempDir, "exports"),
    FAKE_ENRICH_LEDGER_PATH: path.join(tempDir, "ledger.json"),
    LEASE_TTL_SECONDS: 20,
    RATE_LIMIT_INLINE_WAIT_MAX_SECONDS: 0,
    jobDriver: driver,
  });
  await migrate(app.db);
  app.providers.sources.set("local-business", new ScriptedPagedSource({ name: "local-business", creditsPerRequest: 5, ...sourceOpts }));
  return app;
}

test("pgboss worker: enqueue drives a run to its boundary", async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "pgboss-1-"));
  const app = await pgbossApp(tempDir, "pgboss", {});
  try {
    const slug = await createLbWorkflow(app, ["Austin, TX", "Dallas, TX"]);
    const { run } = await previewAndStart(app, slug);
    assert.equal(run.status, "waiting_review");
    const items = await app.db.kysely.selectFrom("run_items").selectAll().where("run_id", "=", run.id).execute();
    assert.equal(items.length, 4);
  } finally {
    await app.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("pgboss worker: a rate-limit pause reschedules and auto-resumes via the delayed job", async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "pgboss-2-"));
  const app = await pgbossApp(tempDir, "pgboss", { script: { 1: [{ kind: "rate_limit", retryAfter: 2 }] } });
  try {
    const slug = await createLbWorkflow(app, ["Austin, TX", "Dallas, TX"]);
    const { run } = await previewAndStart(app, slug);
    assert.equal(run.status, "paused");
    assert.equal(run.pause_reason, "rate_limited");

    // The startAfter=resume_at (~2s) delayed job fires and auto-resumes the run.
    const finalStatus = await waitForStatus(app, run.id, "waiting_review", 25_000);
    assert.equal(finalStatus, "waiting_review");
  } finally {
    await app.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("pgboss worker: the startup sweep resumes a due rate-limit pause left by another driver", async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "pgboss-3-"));
  // 1. An in-process run pauses on a (long) rate limit — no pg-boss job is scheduled.
  const first = await pgbossApp(tempDir, "inprocess", { script: { 1: [{ kind: "rate_limit", retryAfter: 3600 }] } });
  let runId: string;
  try {
    const slug = await createLbWorkflow(first, ["Austin, TX", "Dallas, TX"]);
    const preview = await previewRun(first, slug, {});
    const run = await startRun(first, slug, preview.approval.token, {});
    assert.equal(run.status, "paused");
    assert.equal(run.pause_reason, "rate_limited");
    runId = run.id;
    // Make the pause due.
    await first.db.kysely.updateTable("runs").set({ resume_at: new Date(Date.now() - 1000) }).where("id", "=", run.id).execute();
  } finally {
    await first.close();
  }

  // 2. A fresh pg-boss worker opens the same durable DB; its startup sweep enqueues
  //    the due pause. A clean (non-429) source lets the resumed request succeed.
  const second = await pgbossApp(tempDir, "pgboss", {});
  try {
    // start() runs the sweep; kick it explicitly by touching the worker.
    await second.worker.runToBoundary(runId); // no-op enqueue also starts the worker + sweep
    const finalStatus = await waitForStatus(second, runId, "waiting_review", 25_000);
    assert.equal(finalStatus, "waiting_review");
  } finally {
    await second.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});
