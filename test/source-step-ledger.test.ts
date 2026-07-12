import assert from "node:assert/strict";
import { test } from "node:test";

import type { AppContainer } from "../src/app/container.js";
import { autoResumeRun, createApprovedRun, previewRun, runStatus } from "../src/app/run-service.js";
import { createWorkflowFromDefinition } from "../src/app/workflow-service.js";
import { executeRun } from "../src/engine/runner/runner.js";
import { num } from "../src/storage/database-types.js";
import { sumRunCosts } from "../src/storage/repositories/run-repo.js";
import { listSourceRequests } from "../src/storage/repositories/source-request-repo.js";
import { createTestApp, previewAndStart } from "./helpers/setup.js";
import { ScriptedPagedSource, type ScriptedSourceOptions } from "./helpers/scripted-source.js";

/** Register a scripted paged paid source as "local-business" and build a quick-list workflow over it. */
async function setup(app: AppContainer, locations: string[], sourceOpts: ScriptedSourceOptions = {}) {
  const source = new ScriptedPagedSource({ name: "local-business", creditsPerRequest: 5, ...sourceOpts });
  app.providers.sources.set("local-business", source);
  const created = await createWorkflowFromDefinition(app, {
    id: "lb-quicklist",
    version: 1,
    name: "Local business quick list",
    inputs: { businessType: "roofing contractor", locations, limit: 50, enrichmentProfile: "quick_list" },
    steps: [
      { id: "discover", type: "source", provider: "local-business" },
      { id: "normalize", type: "normalize" },
      { id: "dedupe", type: "dedupe" },
      { id: "review", type: "review_gate" },
      { id: "export", type: "export", format: "csv" },
    ],
  });
  return { source, slug: created.slug };
}

test("paid source: all requests succeed — items inserted, cost booked, credits invariant holds", async () => {
  const t = await createTestApp();
  try {
    const { slug } = await setup(t.app, ["Austin, TX", "Dallas, TX", "Houston, TX"]);
    const { run } = await previewAndStart(t.app, slug);

    assert.equal(run.status, "waiting_review");
    // 3 requests * 2 records each.
    const items = await t.app.db.kysely.selectFrom("run_items").selectAll().where("run_id", "=", run.id).execute();
    assert.equal(items.length, 6);
    // 3 requests * 5 credits.
    assert.equal(num(run.credits_used), 15);
    assert.equal(num(run.credits_used), await sumRunCosts(t.app.db.kysely, run.id), "credits invariant spans the source ledger");

    const status = await runStatus(t.app, run.id);
    assert.equal(status.sourceCoverage.length, 3);
    assert.ok(status.sourceCoverage.every((c) => c.status === "completed" && c.recordsInserted === 2));
  } finally {
    await t.teardown();
  }
});

test("paid source: a 429 pauses rate_limited with resume_at, books no cost for that request, then auto-resumes", async () => {
  const t = await createTestApp();
  try {
    // Request index 1 raises a 429 on its first call.
    const { source, slug } = await setup(t.app, ["Austin, TX", "Dallas, TX"], {
      script: { 1: [{ kind: "rate_limit", retryAfter: 60 }] },
    });
    const { run } = await previewAndStart(t.app, slug);

    assert.equal(run.status, "paused");
    assert.equal(run.pause_reason, "rate_limited");
    assert.ok(run.resume_at);
    // Only request 0 was charged.
    assert.equal(num(run.credits_used), 5);

    const requests = await listSourceRequests(t.app.db.kysely, run.id);
    const deferred = requests.find((r) => r.request_index === 1);
    assert.equal(deferred?.status, "pending", "the rate-limited request is returned to pending");
    assert.equal(deferred?.attempts, 0, "a 429 is not a spent attempt");
    assert.equal(num(deferred?.cost_units ?? 0), 0);

    // Make it due and auto-resume; the provider succeeds on its second call.
    await t.app.db.kysely
      .updateTable("runs")
      .set({ resume_at: new Date(Date.now() - 1000) })
      .where("id", "=", run.id)
      .execute();
    const resumed = await autoResumeRun(t.app, run.id);
    assert.equal(resumed.status, "waiting_review");
    assert.equal(num(resumed.credits_used), 10, "both requests charged exactly once");
    assert.equal(num(resumed.credits_used), await sumRunCosts(t.app.db.kysely, run.id));
    assert.ok(source.executedKeys.length >= 3);
  } finally {
    await t.teardown();
  }
});

test("paid source: a budget below the search total pauses at the credit cap with partial results", async () => {
  const t = await createTestApp();
  try {
    const { slug } = await setup(t.app, ["Austin, TX", "Dallas, TX"]);
    // 2 requests * 5 = 10 needed; budget only covers 1.
    const { run } = await previewAndStart(t.app, slug, { budget: 5 });

    assert.equal(run.status, "paused");
    assert.equal(run.pause_reason, "credit_cap_reached");
    assert.equal(num(run.credits_used), 5);
    const items = await t.app.db.kysely.selectFrom("run_items").selectAll().where("run_id", "=", run.id).execute();
    assert.equal(items.length, 2, "only the first request's records were inserted");
  } finally {
    await t.teardown();
  }
});

test("paid source: an unconfirmable outcome books provisional cost, parks needs_review, and the run continues", async () => {
  const t = await createTestApp();
  try {
    const { slug } = await setup(t.app, ["Austin, TX", "Dallas, TX"], {
      script: { 0: [{ kind: "ambiguous", cost: 5 }] },
    });
    const { run } = await previewAndStart(t.app, slug);

    // Request 0 ambiguous (booked, needs_review); request 1 succeeds; step completes.
    assert.equal(run.status, "waiting_review");
    assert.equal(num(run.credits_used), 10, "ambiguous provisional cost + the successful request");
    assert.equal(num(run.credits_used), await sumRunCosts(t.app.db.kysely, run.id));
    const requests = await listSourceRequests(t.app.db.kysely, run.id);
    assert.equal(requests.find((r) => r.request_index === 0)?.status, "needs_review");
    assert.equal(requests.find((r) => r.request_index === 1)?.status, "completed");
  } finally {
    await t.teardown();
  }
});

test("paid source: a run failed by all-source-failure is recoverable via run retry", async () => {
  const t = await createTestApp();
  try {
    // The single request fails all 3 bounded attempts (uncharged), failing the run.
    const { source, slug } = await setup(t.app, ["Austin, TX"], {
      script: { 0: [{ kind: "retryable" }, { kind: "retryable" }, { kind: "retryable" }] },
    });
    const { run } = await previewAndStart(t.app, slug);
    assert.equal(run.status, "failed");
    assert.equal(num(run.credits_used), 0, "failed uncharged attempts book nothing");

    // Retry requeues the failed source request; the 4th provider call succeeds.
    const { retryRun } = await import("../src/app/run-service.js");
    const retried = await retryRun(t.app, run.id);
    assert.equal(retried.status, "waiting_review");
    assert.equal(num(retried.credits_used), 5, "the successful retry is charged exactly once");
    assert.equal(source.attempts.get(0), 4);
    const items = await t.app.db.kysely.selectFrom("run_items").selectAll().where("run_id", "=", run.id).execute();
    assert.equal(items.length, 2);
  } finally {
    await t.teardown();
  }
});

test("paid source: retrying a completed run with one failed search re-runs ONLY that search", async () => {
  const t = await createTestApp();
  try {
    // Request 0 succeeds; request 1 exhausts its attempts (uncharged failures).
    const { source, slug } = await setup(t.app, ["Austin, TX", "Dallas, TX"], {
      script: { 1: [{ kind: "retryable" }, { kind: "retryable" }, { kind: "retryable" }] },
    });
    const { run } = await previewAndStart(t.app, slug);
    assert.equal(run.status, "waiting_review", "partial source failure still reaches the gate");
    assert.equal(num(run.credits_used), 5);

    // Finish the run, then retry the failed search.
    const { retryRun, reviewRun, resumeRun } = await import("../src/app/run-service.js");
    await reviewRun(t.app, run.id, { reviewStatus: "approved", itemIds: "all" });
    const done = await resumeRun(t.app, run.id, {});
    assert.equal(done.status, "completed");

    const retried = await retryRun(t.app, run.id);
    assert.equal(source.attempts.get(0), 1, "the completed search was never re-executed");
    assert.equal(source.attempts.get(1), 4, "the failed search was retried");
    assert.equal(num(retried.credits_used), 10, "each search charged exactly once overall");
    assert.equal(num(retried.credits_used), await sumRunCosts(t.app.db.kysely, run.id));
    const items = await t.app.db.kysely.selectFrom("run_items").selectAll().where("run_id", "=", run.id).execute();
    assert.equal(items.length, 4, "the recovered search's records were inserted");
  } finally {
    await t.teardown();
  }
});

test("paid source: a crash between a completed request and the next never re-executes or re-charges completed requests", async () => {
  const t = await createTestApp();
  try {
    const { source, slug } = await setup(t.app, ["Austin, TX", "Dallas, TX", "Houston, TX"]);
    const preview = await previewRun(t.app, slug, {});
    const run = await createApprovedRun(t.app, slug, preview.approval.token, {});

    // Crash after request index 1's search returns, before its commit.
    let crashed = false;
    const crashingDeps = {
      ...t.app.runnerDeps,
      hooks: {
        beforeFinalize: (info: { sourceKey: string }) => {
          if (info.sourceKey === "src:1" && !crashed) {
            crashed = true;
            throw new Error("SIMULATED_CRASH");
          }
        },
      },
    };
    await assert.rejects(() => executeRun(crashingDeps, run.id), /SIMULATED_CRASH/);
    assert.equal(crashed, true);
    assert.equal(source.attempts.get(0), 1, "request 0 completed before the crash");

    // Resume with clean deps.
    const resumed = await executeRun(t.app.runnerDeps, run.id);
    assert.equal(resumed.status, "waiting_review");
    assert.equal(source.attempts.get(0), 1, "the completed request was NOT re-executed on resume");
    assert.equal(num(resumed.credits_used), 15, "each of the 3 requests charged exactly once");
    assert.equal(num(resumed.credits_used), await sumRunCosts(t.app.db.kysely, run.id));
    const items = await t.app.db.kysely.selectFrom("run_items").selectAll().where("run_id", "=", run.id).execute();
    assert.equal(items.length, 6);
  } finally {
    await t.teardown();
  }
});
