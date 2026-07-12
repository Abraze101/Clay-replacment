import assert from "node:assert/strict";
import { test } from "node:test";

import { resumeRun, retryRun, reviewRun, runStatus } from "../src/app/run-service.js";
import { listRunItems, listSteps, reconcileStep } from "../src/storage/repositories/run-repo.js";
import { num } from "../src/storage/database-types.js";
import { createDemoWorkflow, createTestApp, previewAndStart } from "./helpers/setup.js";

async function ownerStepOf(t: Awaited<ReturnType<typeof createTestApp>>, runId: string, sourceKey: string) {
  const items = await listRunItems(t.app.db.kysely, runId);
  const item = items.find((i) => i.source_key === sourceKey);
  assert.ok(item, `item ${sourceKey}`);
  const steps = await listSteps(t.app.db.kysely, item.id);
  const owner = steps.find((s) => s.step_id === "owner");
  assert.ok(owner, `owner step of ${sourceKey}`);
  return { item, owner };
}

test("retries: flaky succeeds on attempt 2 with a rotated request key and an honest cost ledger", async () => {
  const t = await createTestApp();
  try {
    const slug = await createDemoWorkflow(t.app);
    const { run } = await previewAndStart(t.app, slug, { profile: "full" });

    const { owner } = await ownerStepOf(t, run.id, "fx-009");
    assert.equal(owner.status, "completed");
    assert.equal(owner.attempts, 2);
    assert.ok(owner.request_key.endsWith(":2"), "explicit requeue rotated the request key");
    assert.equal(owner.attempt_costs.length, 2);
    assert.deepEqual(
      owner.attempt_costs.map((c) => c.classification),
      ["failed_uncharged", "completed"],
    );
    assert.equal(num(owner.cost_units), 1);
  } finally {
    await t.teardown();
  }
});

test("retries: always-broken exhausts bounded attempts; the charged failure stays on the ledger; the item fails", async () => {
  const t = await createTestApp();
  try {
    const slug = await createDemoWorkflow(t.app);
    const { run } = await previewAndStart(t.app, slug, { profile: "full" });

    const { item, owner } = await ownerStepOf(t, run.id, "fx-010");
    assert.equal(owner.status, "failed");
    assert.equal(owner.attempts, 3, "MAX_STEP_ATTEMPTS bounds the in-run retries");
    assert.equal(item.status, "failed");
    assert.deepEqual(
      owner.attempt_costs.map((c) => c.classification),
      ["failed_charged", "failed_uncharged", "failed_uncharged"],
    );
    assert.equal(num(owner.cost_units), 1, "charged-but-failed spend is real spend");
  } finally {
    await t.teardown();
  }
});

test("retries: ambiguous → needs_review; retry never touches it; reconciliation resolves it", async () => {
  const t = await createTestApp();
  try {
    const slug = await createDemoWorkflow(t.app);
    const { run } = await previewAndStart(t.app, slug, { profile: "full" });
    await reviewRun(t.app, run.id, { reviewStatus: "approved", itemIds: "all" });
    await resumeRun(t.app, run.id, {});

    const before = await ownerStepOf(t, run.id, "fx-011");
    assert.equal(before.owner.status, "needs_review");
    assert.equal(before.owner.attempt_costs[0]?.classification, "ambiguous");
    assert.equal(before.owner.attempt_costs[0]?.reconciledAt, null);

    // `run retry` requeues FAILED work only; the ambiguous step must survive untouched.
    await retryRun(t.app, run.id);
    const afterRetry = await ownerStepOf(t, run.id, "fx-011");
    assert.equal(afterRetry.owner.status, "needs_review", "needs_review is never auto-retried");
    assert.equal(afterRetry.owner.attempts, 1);

    // Reconciliation: the single permitted amendment fills classification/reconciledAt.
    await reconcileStep(t.app.db.kysely, afterRetry.owner.id, {
      classification: "completed",
      then: "complete",
      result: { matched: false, reconciled: true },
    });
    const reconciled = await ownerStepOf(t, run.id, "fx-011");
    assert.equal(reconciled.owner.status, "completed");
    assert.equal(reconciled.owner.attempt_costs[0]?.classification, "completed");
    assert.ok(reconciled.owner.attempt_costs[0]?.reconciledAt);

    // A follow-up retry pass finalizes the item now that nothing is pending.
    await retryRun(t.app, run.id).catch(() => undefined);
    const status = await runStatus(t.app, run.id);
    assert.equal(status.counts.stepsNeedingReview, 0);
  } finally {
    await t.teardown();
  }
});

test("retries: reconciling a non-ambiguous step is rejected", async () => {
  const t = await createTestApp();
  try {
    const slug = await createDemoWorkflow(t.app);
    const { run } = await previewAndStart(t.app, slug, { profile: "full" });
    const { owner } = await ownerStepOf(t, run.id, "fx-001");
    await assert.rejects(
      () => reconcileStep(t.app.db.kysely, owner.id, { classification: "completed", then: "complete" }),
      /not 'needs_review'/,
    );
  } finally {
    await t.teardown();
  }
});
