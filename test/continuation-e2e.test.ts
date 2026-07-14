import assert from "node:assert/strict";
import { test } from "node:test";

import { previewRun, resumeRun, reviewRun, startRun } from "../src/app/run-service.js";
import { loadTemplateDefinition } from "../src/app/template-service.js";
import { createWorkflowFromDefinition } from "../src/app/workflow-service.js";
import { num } from "../src/storage/database-types.js";
import { getRun, listRunItems, listSteps } from "../src/storage/repositories/run-repo.js";
import { listSourceRequestsForStep } from "../src/storage/repositories/source-request-repo.js";
import { createTestApp, previewAndStart } from "./helpers/setup.js";

/** Quick-list-shaped run A: source + normalize + dedupe only (completes without a gate). */
const QUICK_DEFINITION = {
  id: "continuation-quick-a",
  version: 1,
  name: "Continuation source run",
  inputs: { businessType: "roofing contractor", locations: ["Austin, TX"], limit: 4, enrichmentProfile: "quick_list" },
  steps: [
    { id: "discover", type: "source", provider: "fake-places" },
    { id: "normalize", type: "normalize" },
    { id: "dedupe", type: "dedupe" },
  ],
};

test("continuation e2e: quick list → approve subset → call-ready continuation with zero source cost and approved rows only", async () => {
  const t = await createTestApp();
  try {
    // ── Run A: free quick list of 4 businesses.
    const quick = await createWorkflowFromDefinition(t.app, QUICK_DEFINITION);
    const a = await previewAndStart(t.app, quick.slug, { profile: "quick_list" });
    assert.equal(a.run.status, "completed");
    assert.equal(num((await getRun(t.app.db.kysely, a.run.id)).credits_used), 0);
    const aItems = await listRunItems(t.app.db.kysely, a.run.id);
    assert.equal(aItems.length, 4);

    // Approve rows 1–3; row 4 stays unreviewed and must NOT continue.
    const approvedIds = aItems.filter((i) => i.position <= 3).map((i) => i.id);
    await reviewRun(t.app, a.run.id, { reviewStatus: "approved", itemIds: approvedIds });

    // ── Continuation workflow from the built-in template.
    const template = await loadTemplateDefinition("call-ready-continuation");
    const cont = await createWorkflowFromDefinition(t.app, template);

    const options = {
      profile: "call_ready" as const,
      overrides: { requireDirectPhone: true },
      inputs: { continueFromRunId: a.run.id },
    };
    const preview = await previewRun(t.app, cont.slug, options);
    assert.ok(
      preview.plan.warnings.some((w) => w.includes("3 approved row(s)") && w.includes("0 credits")),
      preview.plan.warnings.join("\n"),
    );
    assert.equal(preview.plan.inputs.continuationLeadIds?.length, 3, "approved lead ids bound into the plan");
    assert.equal(preview.plan.sourceLimit, 3, "limit clamps to the selection");
    const sourcePlan = preview.plan.steps.find((s) => s.type === "source");
    assert.equal(sourcePlan?.paid, false, "the continuation source is free");

    // ── A review flip between preview and start invalidates the approval.
    await reviewRun(t.app, a.run.id, { reviewStatus: "rejected", itemIds: [approvedIds[2]!] });
    await assert.rejects(
      () => startRun(t.app, cont.slug, preview.approval.token, options),
      (err: { code?: string }) => err.code === "APPROVAL_MISMATCH" || err.code === "APPROVAL_REQUIRED",
      "a changed selection must not start under the old approval",
    );

    // ── Fresh preview over the new selection (2 rows) → start.
    const preview2 = await previewRun(t.app, cont.slug, options);
    assert.equal(preview2.plan.inputs.continuationLeadIds?.length, 2);
    const b = await startRun(t.app, cont.slug, preview2.approval.token, options);

    // Run B waits at its review gate with all capability work done.
    assert.equal(b.status, "waiting_review");
    const bItems = await listRunItems(t.app.db.kysely, b.id);
    assert.equal(bItems.length, 2, "approved rows only — the unreviewed and rejected rows did not continue");
    for (const item of bItems) {
      assert.equal(item.dedupe_status, "matched", "continuation re-attaches existing leads, never duplicates");
    }

    // Zero source spend, source executed as one free DB read.
    const sourceRows = await listSourceRequestsForStep(t.app.db.kysely, b.id, "continue");
    assert.equal(sourceRows.length, 1);
    assert.equal(num(sourceRows[0]!.cost_units), 0);
    assert.match(sourceRows[0]!.coverage_note ?? "", /Continuation of run/);

    // Paid work only on the approved rows: fx-001 discovery 5 + validation 2;
    // fx-002 (no domain) discovery 0 + no target 0.
    const bRun = await getRun(t.app.db.kysely, b.id);
    assert.equal(num(bRun.credits_used), 7);
    const first = bItems.find((i) => i.position === 1);
    const second = bItems.find((i) => i.position === 2);
    assert.equal(first?.call_readiness_status, "ready");
    assert.equal(second?.call_readiness_status, "invalid", "no direct/mobile found → honestly invalid, kept as a lead");

    // ── Approve + resume → export completes the run.
    await reviewRun(t.app, b.id, { reviewStatus: "approved", itemIds: "all" });
    const bDone = await resumeRun(t.app, b.id, {});
    assert.equal(bDone.status, "completed");

    // ── Run C: continuing run B repeats NO paid checks (fresh signals skip).
    await reviewRun(t.app, b.id, { reviewStatus: "approved", itemIds: "all" });
    const optionsC = { ...options, inputs: { continueFromRunId: b.id } };
    const previewC = await previewRun(t.app, cont.slug, optionsC);
    const c = await startRun(t.app, cont.slug, previewC.approval.token, optionsC);
    assert.equal(c.status, "waiting_review");
    const cRun = await getRun(t.app.db.kysely, c.id);
    assert.equal(num(cRun.credits_used), 0, "a second continuation re-pays nothing");
    const cItems = await listRunItems(t.app.db.kysely, c.id);
    const cFirst = cItems.find((i) => i.position === 1);
    const cSteps = await listSteps(t.app.db.kysely, cFirst!.id);
    for (const stepId of ["find-phones", "validate-phones"]) {
      assert.equal(cSteps.find((s) => s.step_id === stepId)?.skip_reason, "already_satisfied");
    }
  } finally {
    await t.teardown();
  }
});

test("continuation: a run with no approved rows refuses to preview", async () => {
  const t = await createTestApp();
  try {
    const quick = await createWorkflowFromDefinition(t.app, { ...QUICK_DEFINITION, id: "continuation-empty-a" });
    const a = await previewAndStart(t.app, quick.slug, { profile: "quick_list" });
    const template = await loadTemplateDefinition("call-ready-continuation");
    const cont = await createWorkflowFromDefinition(t.app, template);
    await assert.rejects(
      () => previewRun(t.app, cont.slug, { profile: "call_ready", inputs: { continueFromRunId: a.run.id } }),
      /no approved, completed leads/,
    );
  } finally {
    await t.teardown();
  }
});
