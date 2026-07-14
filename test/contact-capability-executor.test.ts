import assert from "node:assert/strict";
import { test } from "node:test";

import { createWorkflowFromDefinition } from "../src/app/workflow-service.js";
import { num } from "../src/storage/database-types.js";
import { getRun, listRunItems, listSteps } from "../src/storage/repositories/run-repo.js";
import { listContactPointChecks, listContactPoints } from "../src/storage/repositories/lead-repo.js";
import { createTestApp, previewAndStart } from "./helpers/setup.js";

/** source → normalize → dedupe → phone discovery → phone validation (no gate/export → runs to completion). */
function callReadyWorkflow(limit: number): Record<string, unknown> {
  return {
    id: "cap-exec-test",
    version: 1,
    name: "Capability executor test",
    inputs: { businessType: "roofing contractor", locations: ["Austin, TX"], limit, enrichmentProfile: "call_ready" },
    steps: [
      { id: "discover", type: "source", provider: "fake-places" },
      { id: "normalize", type: "normalize" },
      { id: "dedupe", type: "dedupe" },
      { id: "find-phones", type: "enrich", capability: "phone_discovery", profiles: ["call_ready", "full"] },
      { id: "validate-phones", type: "enrich", capability: "phone_validation", profiles: ["call_ready", "full"] },
    ],
  };
}

test("capability executor: default policy — an acceptable business main STOPS paid discovery; validation targets it", async () => {
  const t = await createTestApp();
  try {
    const created = await createWorkflowFromDefinition(t.app, callReadyWorkflow(3));
    const { run } = await previewAndStart(t.app, created.slug, { profile: "call_ready" });
    assert.equal(run.status, "completed");

    const items = await listRunItems(t.app.db.kysely, run.id);
    for (const item of items) {
      // Waterfall stop: the source main line satisfies the default acceptance
      // rule, so the paid discovery step skips free BEFORE booking a cap slot.
      const steps = await listSteps(t.app.db.kysely, item.id);
      const discovery = steps.find((s) => s.step_id === "find-phones");
      assert.equal(discovery?.status, "skipped");
      assert.equal(discovery?.skip_reason, "already_satisfied");
      // Validation checked the business main: landline/active → ready.
      assert.equal(item.call_readiness_status, "ready", item.call_readiness_reason ?? "");
      assert.match(item.call_readiness_reason ?? "", /business_main .* line_status=active/);
    }

    // Credits: zero discovery, 2 per validated main line.
    const finalRun = await getRun(t.app.db.kysely, run.id);
    assert.equal(num(finalRun.credits_used), 6);
  } finally {
    await t.teardown();
  }
});

test("capability executor: requireDirectPhone — discovery finds directs, validation writes per-signal columns and checks", async () => {
  const t = await createTestApp();
  try {
    // Explicit signals config: all three paid packages, incl. identity_match.
    const definition = callReadyWorkflow(3);
    const steps = definition["steps"] as Record<string, unknown>[];
    steps[4] = { ...steps[4], signals: ["line_type", "line_status", "identity_match"] };
    const created = await createWorkflowFromDefinition(t.app, definition);
    const { run } = await previewAndStart(t.app, created.slug, {
      profile: "call_ready",
      overrides: { requireDirectPhone: true },
    });
    assert.equal(run.status, "completed");

    const items = await listRunItems(t.app.db.kysely, run.id);
    assert.equal(items.length, 3);

    // fx-001: discovery found the owner's direct number; validation set
    // per-signal columns with provider + checked_at pairs.
    const first = items.find((i) => i.position === 1);
    assert.ok(first?.lead_id);
    assert.equal(first.call_readiness_status, "ready", first.call_readiness_reason ?? "");
    const contactPoints = await listContactPoints(t.app.db.kysely, first.lead_id);
    const direct = contactPoints.find((cp) => cp.role === "direct");
    const businessMain = contactPoints.find((cp) => cp.role === "business_main");
    assert.ok(businessMain, "source business_main is preserved");
    assert.ok(direct, "discovery added a direct number");
    assert.equal(direct.normalized_value, "+15125550161");
    assert.equal(direct.source_provider, "fake-contact-discovery");
    assert.equal(direct.line_type, "mobile");
    assert.equal(direct.line_status, "active");
    assert.equal(direct.identity_match, "person_match");
    assert.equal(direct.line_status_provider, "fake-phone-validation");
    assert.ok(direct.line_status_checked_at, "paired checked_at is set");
    assert.equal(businessMain.line_status, null, "the unvalidated business main keeps NULL signals");

    // Append-only history: engine format check + one row per validated
    // signal, cost booked exactly once regardless of signal count.
    const checks = await listContactPointChecks(t.app.db.kysely, direct.id);
    const methods = checks.map((c) => c.method).sort();
    assert.deepEqual(methods, ["format", "identity_match", "line_status", "line_type"]);
    const paidChecks = checks.filter((c) => num(c.cost_units) > 0);
    assert.equal(paidChecks.length, 1, "validation cost booked once, not per signal");
    assert.equal(num(paidChecks[0]!.cost_units), 3);
    assert.ok(checks.every((c) => c.run_item_step_id !== null));

    // fx-002 has no domain: discovery no_result (free), no direct/mobile on
    // file → honestly INVALID under the direct-only policy, never 'ready'.
    const second = items.find((i) => i.position === 2);
    assert.equal(second?.call_readiness_status, "invalid");
    assert.match(second?.call_readiness_reason ?? "", /policy: direct\/mobile only/);
    const secondSteps = await listSteps(t.app.db.kysely, second.id);
    const secondDiscovery = secondSteps.find((s) => s.step_id === "find-phones");
    assert.equal(secondDiscovery?.status, "completed");
    assert.equal(num(secondDiscovery?.cost_units ?? 0), 0, "no_result costs nothing");

    // Credits: discovery 5 (fx-001) + 0 (fx-002) + 5 (fx-003) = 10;
    // validation 3 (fx-001) + 0 (fx-002 no target) + 3 (fx-003) = 6.
    const finalRun = await getRun(t.app.db.kysely, run.id);
    assert.equal(num(finalRun.credits_used), 16);
  } finally {
    await t.teardown();
  }
});

test("capability executor: a rerun over the same leads repeats no paid checks — already-satisfied skips consume no cap", async () => {
  const t = await createTestApp();
  try {
    const created = await createWorkflowFromDefinition(t.app, callReadyWorkflow(3));
    const overrides = { requireDirectPhone: true };
    const first = await previewAndStart(t.app, created.slug, { profile: "call_ready", overrides });
    assert.equal(first.run.status, "completed");
    assert.equal(num((await getRun(t.app.db.kysely, first.run.id)).credits_used), 14);

    const second = await previewAndStart(t.app, created.slug, { profile: "call_ready", overrides });
    assert.equal(second.run.status, "completed");
    const rerun = await getRun(t.app.db.kysely, second.run.id);
    assert.equal(num(rerun.credits_used), 0, "duplicate results never trigger repeated paid checks");

    const items = await listRunItems(t.app.db.kysely, second.run.id);
    for (const item of items) {
      assert.equal(item.dedupe_status, "matched");
      const steps = await listSteps(t.app.db.kysely, item.id);
      const validate = steps.find((s) => s.step_id === "validate-phones");
      if (item.position === 2) {
        // Still nothing to validate; readiness recomputed to invalid again.
        assert.equal(item.call_readiness_status, "invalid");
      } else {
        // Fresh signals from run 1: both steps skip as satisfied, and the
        // skip path still recomputes readiness from stored signals.
        const discovery = steps.find((s) => s.step_id === "find-phones");
        assert.equal(discovery?.status, "skipped");
        assert.equal(discovery?.skip_reason, "already_satisfied");
        assert.equal(validate?.status, "skipped");
        assert.equal(validate?.skip_reason, "already_satisfied");
        assert.equal(item.call_readiness_status, "ready");
      }
    }
  } finally {
    await t.teardown();
  }
});

test("capability executor: an ambiguous submit books provisional cost and parks in needs_review — never auto-retried", async () => {
  const t = await createTestApp();
  try {
    const definition = {
      id: "cap-ambiguous-test",
      version: 1,
      name: "Ambiguous discovery test",
      inputs: { limit: 1, enrichmentProfile: "call_ready" },
      steps: [
        { id: "import", type: "source", provider: "imported-list" },
        { id: "normalize", type: "normalize" },
        { id: "dedupe", type: "dedupe" },
        { id: "find-phones", type: "enrich", capability: "phone_discovery", profiles: ["call_ready", "full"] },
      ],
    };
    const created = await createWorkflowFromDefinition(t.app, definition);
    const inputs = {
      importRows: [{ name: "Ambiguous Corp", website: "https://ambiguous-corp.example", locality: "Austin", region: "TX", country: "US" }],
    };
    const { run } = await previewAndStart(t.app, created.slug, { profile: "call_ready", inputs });
    // The run completes its sweep; the item stays in_progress pending reconciliation.
    assert.equal(run.status, "completed");

    const items = await listRunItems(t.app.db.kysely, run.id);
    const steps = await listSteps(t.app.db.kysely, items[0]!.id);
    const discovery = steps.find((s) => s.step_id === "find-phones");
    assert.equal(discovery?.status, "needs_review");
    assert.equal(num(discovery?.cost_units ?? 0), 5, "worst-case phone cost booked provisionally");
    assert.equal(items[0]?.status, "in_progress", "item awaits reconciliation, never silently completed");
    assert.equal(discovery?.attempts, 1, "ambiguous outcomes are never auto-retried");
  } finally {
    await t.teardown();
  }
});
