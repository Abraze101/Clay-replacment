import assert from "node:assert/strict";
import { test } from "node:test";

import { previewRun, resumeRun, runStatus } from "../src/app/run-service.js";
import { sumStepCosts } from "../src/storage/repositories/run-repo.js";
import { num } from "../src/storage/database-types.js";
import { createDemoWorkflow, createTestApp, previewAndStart } from "./helpers/setup.js";

test("credit gate: the run pauses BEFORE the over-budget paid item and keeps partial results", async () => {
  const t = await createTestApp();
  try {
    const slug = await createDemoWorkflow(t.app);
    const { preview, run } = await previewAndStart(t.app, slug, { profile: "full", budget: 3 });
    assert.ok(preview.plan.warnings.some((w) => w.includes("below the estimated cost")));

    assert.equal(run.status, "paused");
    assert.equal(run.pause_reason, "credit_cap_reached");
    assert.equal(num(run.credits_used), 3, "spend stopped exactly at the budget");

    const status = await runStatus(t.app, run.id);
    assert.equal(status.creditsUsed, 3);
    // Partial results kept: the first three eligible items are enriched.
    const steps = await t.app.db.kysely
      .selectFrom("run_item_steps")
      .selectAll()
      .where("step_id", "=", "owner")
      .where("status", "=", "completed")
      .execute();
    assert.equal(steps.length, 3);

    // Reconcilable invariant: runs.credits_used === SUM(run_item_steps.cost_units).
    assert.equal(await sumStepCosts(t.app.db.kysely, run.id), 3);
  } finally {
    await t.teardown();
  }
});

test("credit gate: resuming without more budget re-pauses; a raised budget requires a FRESH approval", async () => {
  const t = await createTestApp();
  try {
    const slug = await createDemoWorkflow(t.app);
    const { run } = await previewAndStart(t.app, slug, { profile: "full", budget: 3 });
    assert.equal(run.status, "paused");

    // Same budget → immediately pauses again at the cap.
    const stillPaused = await resumeRun(t.app, run.id, {});
    assert.equal(stillPaused.status, "paused");

    // Raising the budget without approval is rejected.
    await assert.rejects(
      () => resumeRun(t.app, run.id, { budget: 20 }),
      (err: { code?: string }) => err.code === "APPROVAL_MISMATCH",
    );
    // A wrong hash is rejected too.
    await assert.rejects(
      () => resumeRun(t.app, run.id, { budget: 20, approval: "not-the-hash" }),
      (err: { code?: string }) => err.code === "APPROVAL_MISMATCH",
    );

    // Preview the new scope, approve its hash, resume: run completes its work.
    const reapproval = await previewRun(t.app, slug, { profile: "full", budget: 20 });
    const resumed = await resumeRun(t.app, run.id, { budget: 20, approval: reapproval.plan.planHash });
    assert.equal(resumed.status, "waiting_review");
    assert.equal(num(resumed.credits_used), 11, "continued from item 4 without re-spending items 1-3");
    assert.equal(await sumStepCosts(t.app.db.kysely, run.id), 11);

    // The approval history is append-only: both approvals persisted.
    assert.equal(resumed.approvals.length, 2);
    assert.equal(resumed.approvals[1]?.creditLimit, 20);
  } finally {
    await t.teardown();
  }
});
