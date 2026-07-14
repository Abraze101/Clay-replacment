import assert from "node:assert/strict";
import { test } from "node:test";

import { previewRun, resumeRun, startRun } from "../src/app/run-service.js";
import { createRun } from "../src/storage/repositories/run-repo.js";
import type { ApprovalEntry, JsonObject } from "../src/storage/database-types.js";
import { num } from "../src/storage/database-types.js";
import { createDemoWorkflow, createTestApp, previewAndStart } from "./helpers/setup.js";

test("approval tokens: preview issues a single-use token; start consumes it and fills the approval entry", async () => {
  const t = await createTestApp();
  try {
    const slug = await createDemoWorkflow(t.app);
    const preview = await previewRun(t.app, slug, { profile: "full" });
    assert.match(preview.approval.token, /^apv_/);

    const issued = await t.app.db.kysely
      .selectFrom("approval_tokens")
      .selectAll()
      .where("nonce", "=", preview.approval.token)
      .executeTakeFirstOrThrow();
    assert.equal(issued.scope_hash, preview.plan.planHash, "token binds the plan hash");
    assert.equal(issued.enrichment_profile, "full");
    assert.equal(issued.paid_record_cap, preview.plan.paidRecordCap);
    assert.equal(num(issued.credit_limit), preview.plan.creditLimit);
    assert.equal(issued.consumed_at, null);

    const run = await startRun(t.app, slug, preview.approval.token, { profile: "full" });
    const entry = run.approvals[0];
    assert.ok(entry, "approval entry persisted on the run");
    assert.equal(entry.id, issued.id, "approvals[] entry references the token row");
    assert.ok(entry.expiresAt, "expiresAt filled (M1)");
    assert.ok(entry.consumedAt, "consumedAt filled (M1)");

    const consumed = await t.app.db.kysely
      .selectFrom("approval_tokens")
      .selectAll()
      .where("id", "=", issued.id)
      .executeTakeFirstOrThrow();
    assert.ok(consumed.consumed_at, "token row marked consumed");
    assert.equal(consumed.consumed_by_run_id, run.id, "consumption linked to the run");
  } finally {
    await t.teardown();
  }
});

test("approval tokens: unknown → APPROVAL_REQUIRED, reuse → APPROVAL_CONSUMED, expired → APPROVAL_EXPIRED", async () => {
  const t = await createTestApp();
  try {
    const slug = await createDemoWorkflow(t.app);

    await assert.rejects(
      () => startRun(t.app, slug, "apv_never-issued", { profile: "quick_list" }),
      (err: { code?: string }) => err.code === "APPROVAL_REQUIRED",
    );

    const { preview } = await previewAndStart(t.app, slug, { profile: "quick_list" });
    await assert.rejects(
      () => startRun(t.app, slug, preview.approval.token, { profile: "quick_list" }),
      (err: { code?: string }) => err.code === "APPROVAL_CONSUMED",
    );

    const expiring = await previewRun(t.app, slug, { profile: "quick_list" });
    await t.app.db.kysely
      .updateTable("approval_tokens")
      .set({ expires_at: new Date(Date.now() - 60_000) })
      .where("nonce", "=", expiring.approval.token)
      .execute();
    await assert.rejects(
      () => startRun(t.app, slug, expiring.approval.token, { profile: "quick_list" }),
      (err: { code?: string }) => err.code === "APPROVAL_EXPIRED",
    );
  } finally {
    await t.teardown();
  }
});

test("approval tokens: a scope mismatch does NOT burn the token — it still starts its own scope", async () => {
  const t = await createTestApp();
  try {
    const slug = await createDemoWorkflow(t.app);
    const quick = await previewRun(t.app, slug, { profile: "quick_list" });

    await assert.rejects(
      () => startRun(t.app, slug, quick.approval.token, { profile: "call_ready" }),
      (err: { code?: string }) => err.code === "APPROVAL_MISMATCH",
    );

    // The mismatch attempt must not consume the token.
    const run = await startRun(t.app, slug, quick.approval.token, { profile: "quick_list" });
    assert.equal(run.enrichment_profile, "quick_list");
  } finally {
    await t.teardown();
  }
});

test("approval tokens: raising budget on resume requires and consumes a fresh token", async () => {
  const t = await createTestApp();
  try {
    const slug = await createDemoWorkflow(t.app);
    const { run } = await previewAndStart(t.app, slug, { profile: "full", budget: 3 });
    assert.equal(run.status, "paused");

    await assert.rejects(
      () => resumeRun(t.app, run.id, { budget: 40 }),
      (err: { code?: string }) => err.code === "APPROVAL_REQUIRED",
    );

    const reapproval = await previewRun(t.app, slug, { profile: "full", budget: 40 });
    const resumed = await resumeRun(t.app, run.id, { budget: 40, approval: reapproval.approval.token });
    assert.equal(resumed.status, "waiting_review");
    assert.equal(resumed.approvals.length, 2, "approval history is append-only");
    assert.ok(resumed.approvals[1]?.id, "the resume approval references its token row");

    const tokenRow = await t.app.db.kysely
      .selectFrom("approval_tokens")
      .selectAll()
      .where("nonce", "=", reapproval.approval.token)
      .executeTakeFirstOrThrow();
    assert.equal(tokenRow.consumed_by_run_id, run.id);
  } finally {
    await t.teardown();
  }
});

test("approval tokens: an M0-style run (approval entry without a token id) still verifies at claim time", async () => {
  const t = await createTestApp();
  try {
    const slug = await createDemoWorkflow(t.app);
    const preview = await previewRun(t.app, slug, { profile: "quick_list" });

    // Simulate a pre-0002 run: approval entry with id/expiresAt/consumedAt null.
    const approval: ApprovalEntry = {
      id: null,
      planHash: preview.plan.planHash,
      profile: preview.plan.profile,
      overrides: preview.plan.overrides,
      paidRecordCap: preview.plan.paidRecordCap,
      creditLimit: preview.plan.creditLimit,
      estimatedPaidActions: preview.plan.estimatedPaidActions,
      approvedAt: new Date().toISOString(),
      source: "cli",
      expiresAt: null,
      consumedAt: null,
    };
    const run = await createRun(t.app.db.kysely, {
      agencyId: t.app.agencyId,
      workflowVersionId: preview.workflowVersionId,
      inputs: preview.plan.inputs,
      profile: preview.plan.profile,
      overrides: preview.plan.overrides,
      resolvedPlan: preview.plan as unknown as JsonObject,
      planHash: preview.plan.planHash,
      paidRecordCap: preview.plan.paidRecordCap,
      creditLimit: preview.plan.creditLimit,
      approval,
    });

    const finished = await t.app.worker.runToBoundary(run.id);
    assert.ok(
      finished.status === "waiting_review" || finished.status === "completed",
      `legacy approval entries execute unchanged (got ${finished.status})`,
    );
  } finally {
    await t.teardown();
  }
});
