import assert from "node:assert/strict";
import { test } from "node:test";

import type { PreviewResult, StartRunResponse } from "../src/web/contracts.js";
import { createDemoWorkflow, createTestApp } from "./helpers/setup.js";
import { pollRunStatus, startTestWebServer } from "./helpers/web.js";

test("web api: the engine approval gate holds over HTTP — required, mismatch, consumed, expired", async () => {
  const t = await createTestApp();
  const web = await startTestWebServer(t);
  try {
    const slug = await createDemoWorkflow(t.app);

    // Unknown token: 409 APPROVAL_REQUIRED.
    const unknown = await web.postJson(`/api/workflows/${slug}/start`, {
      approval: "apv_never-issued",
      profile: "quick_list",
    });
    assert.equal(unknown.status, 409);
    assert.equal(unknown.body.error?.code, "APPROVAL_REQUIRED");

    // Scope change: previewed cap 5, started with cap 6 → APPROVAL_MISMATCH,
    // and the token is NOT burned — the original scope still starts.
    const preview = await web.postJson<PreviewResult>(`/api/workflows/${slug}/preview`, {
      profile: "full",
      cap: 5,
      budget: 5,
    });
    const token = preview.body.data?.approval.token;
    assert.ok(token);
    const mismatched = await web.postJson(`/api/workflows/${slug}/start`, {
      approval: token,
      profile: "full",
      cap: 6,
      budget: 5,
    });
    assert.equal(mismatched.status, 409);
    assert.equal(mismatched.body.error?.code, "APPROVAL_MISMATCH");
    const originalScope = await web.postJson<StartRunResponse>(`/api/workflows/${slug}/start`, {
      approval: token,
      profile: "full",
      cap: 5,
      budget: 5,
    });
    assert.equal(originalScope.status, 202, "a mismatch must not consume the token");

    // Replay: the token was consumed by the successful start.
    const replay = await web.postJson(`/api/workflows/${slug}/start`, {
      approval: token,
      profile: "full",
      cap: 5,
      budget: 5,
    });
    assert.equal(replay.status, 409);
    assert.equal(replay.body.error?.code, "APPROVAL_CONSUMED");

    // Expiry: backdate the token row (same pattern as approval-tokens.test.ts).
    const expiring = await web.postJson<PreviewResult>(`/api/workflows/${slug}/preview`, { profile: "quick_list" });
    const expiringToken = expiring.body.data?.approval.token;
    assert.ok(expiringToken);
    await t.app.db.kysely
      .updateTable("approval_tokens")
      .set({ expires_at: new Date(Date.now() - 60_000) })
      .where("nonce", "=", expiringToken)
      .execute();
    const expired = await web.postJson(`/api/workflows/${slug}/start`, {
      approval: expiringToken,
      profile: "quick_list",
    });
    assert.equal(expired.status, 409);
    assert.equal(expired.body.error?.code, "APPROVAL_EXPIRED");
  } finally {
    await web.close();
    await t.teardown();
  }
});

test("web api: resume with a budget change requires a fresh approval token", async () => {
  const t = await createTestApp();
  const web = await startTestWebServer(t);
  try {
    const slug = await createDemoWorkflow(t.app);
    const preview = await web.postJson<PreviewResult>(`/api/workflows/${slug}/preview`, { profile: "quick_list" });
    const started = await web.postJson<StartRunResponse>(`/api/workflows/${slug}/start`, {
      approval: preview.body.data?.approval.token,
      profile: "quick_list",
    });
    assert.equal(started.status, 202);
    const runId = started.body.data?.runId;
    assert.ok(runId);
    await pollRunStatus(web, runId, (s) => s.status === "waiting_review");

    const budgetChange = await web.postJson(`/api/runs/${runId}/resume`, { budget: 99 });
    assert.equal(budgetChange.status, 409);
    assert.equal(budgetChange.body.error?.code, "APPROVAL_REQUIRED");

    // A plain resume (no scope change) still works.
    const plain = await web.postJson<StartRunResponse>(`/api/runs/${runId}/resume`, {});
    assert.equal(plain.status, 202);
    const final = await pollRunStatus(web, runId, (s) => s.status === "completed" || s.status === "failed");
    assert.equal(final.status, "completed");
  } finally {
    await web.close();
    await t.teardown();
  }
});
