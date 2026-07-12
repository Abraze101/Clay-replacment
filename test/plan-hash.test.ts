import assert from "node:assert/strict";
import { test } from "node:test";

import { previewRun, startRun } from "../src/app/run-service.js";
import { validateWorkflow } from "../src/app/workflow-service.js";
import { createDemoWorkflow, createTestApp, demoDefinition } from "./helpers/setup.js";

test("plan hash: every approval-scoped dimension changes the hash", async () => {
  const t = await createTestApp();
  try {
    const slug = await createDemoWorkflow(t.app);
    const base = (await previewRun(t.app, slug, { profile: "full" })).plan.planHash;

    const variants = await Promise.all([
      previewRun(t.app, slug, { profile: "call_ready" }),
      previewRun(t.app, slug, { profile: "full", cap: 5 }),
      previewRun(t.app, slug, { profile: "full", budget: 3 }),
      previewRun(t.app, slug, { profile: "full", overrides: { skipPersonalization: true } }),
      previewRun(t.app, slug, { profile: "full", inputs: { limit: 10 } }),
    ]);
    const hashes = [base, ...variants.map((v) => v.plan.planHash)];
    assert.equal(new Set(hashes).size, hashes.length, "profile, cap, budget, overrides, and inputs all bind the hash");

    // The same request yields the same hash (deterministic approval value).
    const again = (await previewRun(t.app, slug, { profile: "full" })).plan.planHash;
    assert.equal(again, base);
  } finally {
    await t.teardown();
  }
});

test("plan hash: a stale approval is rejected after the workflow version changes", async () => {
  const t = await createTestApp();
  try {
    const slug = await createDemoWorkflow(t.app);
    const staleHash = (await previewRun(t.app, slug, { profile: "quick_list" })).plan.planHash;

    const changed = demoDefinition();
    (changed as { name: string }).name = "Changed after preview";
    await validateWorkflow(t.app, slug, changed);

    await assert.rejects(
      () => startRun(t.app, slug, staleHash, { profile: "quick_list" }),
      (err: { code?: string }) => err.code === "APPROVAL_MISMATCH",
    );
  } finally {
    await t.teardown();
  }
});

test("plan hash: a wrong or absent hash never starts a run (engine-level approval, not harness courtesy)", async () => {
  const t = await createTestApp();
  try {
    const slug = await createDemoWorkflow(t.app);
    await assert.rejects(
      () => startRun(t.app, slug, "0000not-a-hash", { profile: "quick_list" }),
      (err: { code?: string }) => err.code === "APPROVAL_MISMATCH",
    );
    const runs = await t.app.db.kysely.selectFrom("runs").selectAll().execute();
    assert.equal(runs.length, 0, "no run row is created on a rejected approval");
  } finally {
    await t.teardown();
  }
});

test("plan hash: quick_list approval cannot start a call_ready run (profile bound into the scope)", async () => {
  const t = await createTestApp();
  try {
    const slug = await createDemoWorkflow(t.app);
    const quickHash = (await previewRun(t.app, slug, { profile: "quick_list" })).plan.planHash;
    await assert.rejects(
      () => startRun(t.app, slug, quickHash, { profile: "call_ready" }),
      (err: { code?: string }) => err.code === "APPROVAL_MISMATCH",
    );
  } finally {
    await t.teardown();
  }
});
