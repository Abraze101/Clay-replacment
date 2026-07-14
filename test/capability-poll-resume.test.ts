import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";

import { autoResumeRun } from "../src/app/run-service.js";
import { createWorkflowFromDefinition } from "../src/app/workflow-service.js";
import { num } from "../src/storage/database-types.js";
import { getRun, listRunItems, listSteps } from "../src/storage/repositories/run-repo.js";
import { listContactPoints } from "../src/storage/repositories/lead-repo.js";
import { createTestApp, previewAndStart } from "./helpers/setup.js";

/** Imported row whose domain contains 'slow' → the fake vendor goes async: pending → pending → found. */
const SLOW_ROW = {
  name: "Slow Discovery Services",
  website: "https://slowdiscovery.example",
  locality: "Austin",
  region: "TX",
  country: "US",
};

const DEFINITION = {
  id: "cap-poll-test",
  version: 1,
  name: "Async submit-then-poll test",
  inputs: { limit: 1, enrichmentProfile: "call_ready" },
  steps: [
    { id: "import", type: "source", provider: "imported-list" },
    { id: "normalize", type: "normalize" },
    { id: "dedupe", type: "dedupe" },
    { id: "find-phones", type: "enrich", capability: "phone_discovery", profiles: ["call_ready", "full"] },
  ],
};

test("submit-then-poll: pending defers the step, pauses awaiting_provider, auto-resume polls to completion, cost booked once", async () => {
  const t = await createTestApp();
  try {
    const created = await createWorkflowFromDefinition(t.app, DEFINITION);
    const { run } = await previewAndStart(t.app, created.slug, {
      profile: "call_ready",
      overrides: { requireDirectPhone: true },
      inputs: { importRows: [SLOW_ROW] },
    });

    // Submit accepted → the run parks awaiting the vendor, with resume_at set.
    assert.equal(run.status, "paused");
    assert.equal(run.pause_reason, "awaiting_provider");
    assert.ok(run.resume_at, "resume_at carries the earliest poll due time");

    const items = await listRunItems(t.app.db.kysely, run.id);
    const stepsAfterSubmit = await listSteps(t.app.db.kysely, items[0]!.id);
    const discovery = stepsAfterSubmit.find((s) => s.step_id === "find-phones");
    assert.equal(discovery?.status, "pending", "deferred, not failed");
    assert.equal(discovery?.attempts, 0, "a pending poll never consumes a bounded-retry attempt");
    const jobState = (discovery?.result as { capabilityJob?: { jobId: string; requestKey: string } }).capabilityJob;
    assert.ok(jobState?.jobId, "the vendor job id is persisted for crash-safe re-polling");
    assert.equal(num(discovery?.cost_units ?? 0), 0, "nothing booked at submit");

    // First auto-resume: poll #1 is still pending → defers and pauses again.
    await sleep(1100);
    const afterFirstPoll = await autoResumeRun(t.app, run.id);
    assert.equal(afterFirstPoll.status, "paused");
    assert.equal(afterFirstPoll.pause_reason, "awaiting_provider");

    // Second auto-resume: poll #2 delivers → contacts written, cost booked once.
    await sleep(1100);
    const done = await autoResumeRun(t.app, run.id);
    assert.equal(done.status, "completed");

    const finalItems = await listRunItems(t.app.db.kysely, run.id);
    assert.equal(finalItems[0]?.status, "completed");
    assert.equal(finalItems[0]?.call_readiness_status, "unchecked", "no validation step ran — never 'ready' from discovery alone");
    const finalSteps = await listSteps(t.app.db.kysely, finalItems[0].id);
    const finalDiscovery = finalSteps.find((s) => s.step_id === "find-phones");
    assert.equal(finalDiscovery?.status, "completed");
    assert.equal(num(finalDiscovery?.cost_units ?? 0), 5, "phone enrichment charged exactly once, at delivery");

    assert.ok(finalItems[0]?.lead_id);
    const contactPoints = await listContactPoints(t.app.db.kysely, finalItems[0].lead_id);
    const phones = contactPoints.filter((cp) => cp.type === "phone" && cp.source_provider === "fake-contact-discovery");
    assert.ok(phones.length >= 1, "discovered phones persisted after the final poll");

    const finalRun = await getRun(t.app.db.kysely, run.id);
    assert.equal(num(finalRun.credits_used), 5);
  } finally {
    await t.teardown();
  }
});
