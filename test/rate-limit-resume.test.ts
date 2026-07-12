import assert from "node:assert/strict";
import { test } from "node:test";

import type { AppContainer } from "../src/app/container.js";
import { autoResumeRun } from "../src/app/run-service.js";
import { createWorkflowFromDefinition } from "../src/app/workflow-service.js";
import { RateLimitError } from "../src/shared/errors.js";
import { num } from "../src/storage/database-types.js";
import type { ResearchOutcome, ResearchProvider } from "../src/providers/types.js";
import { createTestApp, previewAndStart } from "./helpers/setup.js";

/**
 * A research provider that raises a 429 on its first call, then succeeds. The
 * research step is the cleanest item-step injection point for a provider rate
 * limit; the durable source-step path is exercised separately at M3 step 4.
 */
class RateLimitOnceResearch implements ResearchProvider {
  readonly name = "fake-website";
  calls = 0;
  constructor(private readonly retryAfterSeconds: number) {}
  research(): Promise<ResearchOutcome> {
    this.calls += 1;
    if (this.calls === 1) return Promise.reject(new RateLimitError("research 429", this.retryAfterSeconds));
    return Promise.resolve({ kind: "ok", summary: "ok", facts: {}, providerRequestId: `stub-${this.calls}` });
  }
}

/** Minimal quick_list workflow whose only item step is research (no paid steps). */
async function createRateLimitWorkflow(app: AppContainer): Promise<string> {
  const created = await createWorkflowFromDefinition(app, {
    id: "rate-limit-demo",
    version: 1,
    name: "Rate limit demo",
    inputs: { businessType: "roofing contractor", locations: ["Austin, TX"], limit: 5, enrichmentProfile: "quick_list" },
    steps: [
      { id: "discover", type: "source", provider: "fake-places" },
      { id: "normalize", type: "normalize" },
      { id: "dedupe", type: "dedupe" },
      { id: "website", type: "research", provider: "fake-website" },
      { id: "review", type: "review_gate" },
      { id: "export", type: "export", format: "csv" },
    ],
  });
  return created.slug;
}

test("item-step 429 pauses the run rate_limited, schedules resume_at, defers the step, books no cost", async () => {
  const t = await createTestApp();
  try {
    const stub = new RateLimitOnceResearch(60);
    t.app.providers.researchers.set("fake-website", stub);
    const slug = await createRateLimitWorkflow(t.app);

    const { run } = await previewAndStart(t.app, slug);

    assert.equal(run.status, "paused");
    assert.equal(run.pause_reason, "rate_limited");
    assert.ok(run.resume_at, "resume_at is set");
    const delta = new Date(run.resume_at).getTime() - Date.now();
    assert.ok(delta > 30_000 && delta <= 61_000, `resume_at ~60s ahead, got ${delta}ms`);
    // A 429 is never charged.
    assert.equal(num(run.credits_used), 0);

    // Exactly the first item's research step is deferred: pending, attempts 0, next_attempt_at set.
    const websiteSteps = await t.app.db.kysely
      .selectFrom("run_item_steps")
      .selectAll()
      .where("step_id", "=", "website")
      .execute();
    assert.equal(websiteSteps.length, 1, "only the first item reached research before the pause");
    const deferred = websiteSteps[0];
    assert.equal(deferred?.status, "pending");
    assert.equal(deferred?.attempts, 0, "the 429 attempt was not counted");
    assert.ok(deferred?.next_attempt_at, "next_attempt_at recorded on the step");
    assert.equal(stub.calls, 1);
  } finally {
    await t.teardown();
  }
});

test("autoResumeRun resumes a due rate-limit pause with no token and clears resume_at", async () => {
  const t = await createTestApp();
  try {
    const stub = new RateLimitOnceResearch(1);
    t.app.providers.researchers.set("fake-website", stub);
    const slug = await createRateLimitWorkflow(t.app);

    const { run } = await previewAndStart(t.app, slug);
    assert.equal(run.status, "paused");

    // Simulate the scheduler firing on time: backdate resume_at so it is due.
    await t.app.db.kysely
      .updateTable("runs")
      .set({ resume_at: new Date(Date.now() - 1000) })
      .where("id", "=", run.id)
      .execute();

    const resumed = await autoResumeRun(t.app, run.id);
    // Research succeeds on retry; the run advances to its review gate.
    assert.equal(resumed.status, "waiting_review");
    assert.equal(resumed.pause_reason, null);
    assert.equal(resumed.resume_at, null, "resume_at cleared on resume");
    assert.ok(stub.calls >= 2, "the provider was retried");
  } finally {
    await t.teardown();
  }
});

test("autoResumeRun refuses a not-yet-due, credit-cap, or operator pause", async () => {
  const t = await createTestApp();
  try {
    const stub = new RateLimitOnceResearch(3600);
    t.app.providers.researchers.set("fake-website", stub);
    const slug = await createRateLimitWorkflow(t.app);

    const { run } = await previewAndStart(t.app, slug);
    assert.equal(run.status, "paused");

    // resume_at is ~1h out → not due → left paused, provider not re-invoked.
    const notDue = await autoResumeRun(t.app, run.id);
    assert.equal(notDue.status, "paused");
    assert.equal(stub.calls, 1);

    // A credit-cap pause is never auto-resumed, even if resume_at is null.
    await t.app.db.kysely
      .updateTable("runs")
      .set({ pause_reason: "credit_cap_reached", resume_at: null })
      .where("id", "=", run.id)
      .execute();
    const capPause = await autoResumeRun(t.app, run.id);
    assert.equal(capPause.status, "paused");
    assert.equal(capPause.pause_reason, "credit_cap_reached");

    // Neither is an operator pause.
    await t.app.db.kysely
      .updateTable("runs")
      .set({ pause_reason: "operator" })
      .where("id", "=", run.id)
      .execute();
    const opPause = await autoResumeRun(t.app, run.id);
    assert.equal(opPause.status, "paused");
    assert.equal(stub.calls, 1);
  } finally {
    await t.teardown();
  }
});
