import assert from "node:assert/strict";
import { test } from "node:test";

import { createApprovedRun, previewRun } from "../src/app/run-service.js";
import { executeRun } from "../src/engine/runner/runner.js";
import type { FakeEnrichProvider } from "../src/providers/fake/enrich.js";
import { listRunItems, listSteps } from "../src/storage/repositories/run-repo.js";
import { num } from "../src/storage/database-types.js";
import { createDemoWorkflow, createTestApp } from "./helpers/setup.js";

/**
 * Exactly-once across a crash between the paid provider call and the commit:
 * the step is left 'running', resume reuses the STORED attempt-scoped
 * request_key, and the provider's idempotent replay absorbs it without a
 * second charge.
 */
test("crash-resume: fault after provider call, before commit — no double spend, no attempt inflation", async () => {
  const t = await createTestApp();
  try {
    const slug = await createDemoWorkflow(t.app);
    const preview = await previewRun(t.app, slug, { profile: "full" });
    const run = await createApprovedRun(t.app, slug, preview.approval.token, { profile: "full" });

    let crashed = false;
    const crashingDeps = {
      ...t.app.runnerDeps,
      hooks: {
        beforeFinalize: (info: { stepId: string }) => {
          if (info.stepId === "owner" && !crashed) {
            crashed = true;
            throw new Error("SIMULATED_CRASH");
          }
        },
      },
    };
    await assert.rejects(() => executeRun(crashingDeps, run.id), /SIMULATED_CRASH/);
    assert.equal(crashed, true);

    // The interrupted step is left 'running' with its request key stored —
    // the durable crash marker.
    const items = await listRunItems(t.app.db.kysely, run.id);
    const firstEligible = items.find((i) => i.source_key === "fx-001");
    assert.ok(firstEligible);
    const stepsBefore = await listSteps(t.app.db.kysely, firstEligible.id);
    const ownerBefore = stepsBefore.find((s) => s.step_id === "owner");
    assert.equal(ownerBefore?.status, "running");
    assert.equal(ownerBefore?.attempts, 1);
    assert.ok(ownerBefore?.request_key.endsWith(":1"));

    const provider = t.app.providers.enrichers.get("fake-apollo") as FakeEnrichProvider;
    const chargedAtCrash = provider.stats().totalCharged;
    assert.equal(chargedAtCrash, 1, "the provider DID charge before the crash");

    // Resume with clean deps: crash replay must reuse the stored request_key.
    const resumed = await executeRun(t.app.runnerDeps, run.id);
    assert.equal(resumed.status, "waiting_review");

    const stepsAfter = await listSteps(t.app.db.kysely, firstEligible.id);
    const ownerAfter = stepsAfter.find((s) => s.step_id === "owner");
    assert.equal(ownerAfter?.status, "completed");
    assert.equal(ownerAfter?.attempts, 1, "crash replay never increments attempts");
    assert.equal(ownerAfter?.request_key, ownerBefore?.request_key, "the stored key is reused verbatim");
    assert.equal(ownerAfter?.attempt_costs.length, 1);
    assert.equal(num(ownerAfter?.cost_units ?? 0), 1, "charged exactly once");

    // Whole-run reconciliation: provider-side charges == engine cost ledger ==
    // exactly what an uninterrupted run spends (11 credits, 14 executed calls).
    const stats = provider.stats();
    assert.equal(stats.totalCharged, 11);
    assert.equal(stats.executedCalls, 14, "the replayed request was served from the provider cache, not re-executed");
    assert.equal(num(resumed.credits_used), 11);
  } finally {
    await t.teardown();
  }
});

test("crash-resume: crash during a FREE step also resumes exactly where it stopped", async () => {
  const t = await createTestApp();
  try {
    const slug = await createDemoWorkflow(t.app);
    const preview = await previewRun(t.app, slug, { profile: "quick_list" });
    const run = await createApprovedRun(t.app, slug, preview.approval.token, { profile: "quick_list" });

    let calls = 0;
    const crashingDeps = {
      ...t.app.runnerDeps,
      hooks: {
        beforeFinalize: (info: { stepId: string }) => {
          calls += 1;
          if (info.stepId === "dedupe" && calls > 3) throw new Error("SIMULATED_CRASH");
        },
      },
    };
    await assert.rejects(() => executeRun(crashingDeps, run.id), /SIMULATED_CRASH/);

    const resumed = await executeRun(t.app.runnerDeps, run.id);
    assert.equal(resumed.status, "waiting_review");
    const items = await listRunItems(t.app.db.kysely, run.id);
    assert.equal(items.length, 15, "source step never re-ran (step_progress marker)");
    // No duplicated leads from the partially-committed dedupe step.
    const leads = await t.app.db.kysely.selectFrom("leads").selectAll().execute();
    const bySourceId = new Set(leads.map((l) => l.source_provider_id));
    assert.equal(bySourceId.size, leads.length, "replayed dedupe upserted, never duplicated");
  } finally {
    await t.teardown();
  }
});
