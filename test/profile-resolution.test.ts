import assert from "node:assert/strict";
import { test } from "node:test";

import { previewRun } from "../src/app/run-service.js";
import { createDemoWorkflow, createTestApp } from "./helpers/setup.js";

function willRunIds(plan: { steps: { id: string; willRun: boolean }[] }): string[] {
  return plan.steps.filter((s) => s.willRun).map((s) => s.id);
}

test("profiles: quick_list enables no paid steps — cap 0, zero cost rows, still exports", async () => {
  const t = await createTestApp();
  try {
    const slug = await createDemoWorkflow(t.app);
    const { plan } = await previewRun(t.app, slug, { profile: "quick_list" });
    assert.deepEqual(willRunIds(plan), ["discover", "normalize", "dedupe", "screen", "review", "export"]);
    assert.equal(plan.paidRecordCap, 0);
    assert.equal(plan.estimatedCost, 0);
    assert.equal(plan.creditLimit, 0);
    assert.deepEqual(plan.estimatedPaidActions, []);
    const excluded = plan.steps.filter((s) => !s.willRun);
    assert.ok(excluded.every((s) => s.excludedBy === "profile"));
  } finally {
    await t.teardown();
  }
});

test("profiles: call_ready adds research + enrichment + phone validation, but not scoring/generation", async () => {
  const t = await createTestApp();
  try {
    const slug = await createDemoWorkflow(t.app);
    const { plan } = await previewRun(t.app, slug, { profile: "call_ready" });
    assert.deepEqual(willRunIds(plan), [
      "discover",
      "normalize",
      "dedupe",
      "screen",
      "website",
      "owner",
      "validate-phones",
      "review",
      "export",
    ]);
    assert.equal(plan.paidRecordCap, 15);
    // owner 1/record + phone validation 2/record (line_type + line_status).
    assert.equal(plan.estimatedCost, 45);
  } finally {
    await t.teardown();
  }
});

test("profiles: full runs everything; presets compile into visible typed steps", async () => {
  const t = await createTestApp();
  try {
    const slug = await createDemoWorkflow(t.app);
    const { plan } = await previewRun(t.app, slug, { profile: "full" });
    assert.equal(willRunIds(plan).length, 12);
    assert.deepEqual(plan.estimatedPaidActions, [
      { stepId: "owner", provider: "fake-apollo", count: 15, costPerRecord: 1 },
      { stepId: "validate-phones", provider: "fake-phone-validation", count: 15, costPerRecord: 2 },
      { stepId: "verify-email", provider: "fake-email-verification", count: 15, costPerRecord: 1 },
    ]);
  } finally {
    await t.teardown();
  }
});

test("overrides: skipPersonalization and findOwner=false disable their steps and change the plan", async () => {
  const t = await createTestApp();
  try {
    const slug = await createDemoWorkflow(t.app);
    const noCopy = await previewRun(t.app, slug, { profile: "full", overrides: { skipPersonalization: true } });
    const generate = noCopy.plan.steps.find((s) => s.id === "opener");
    assert.equal(generate?.willRun, false);
    assert.equal(generate?.excludedBy, "override");

    const noOwner = await previewRun(t.app, slug, { profile: "full", overrides: { findOwner: false } });
    const enrich = noOwner.plan.steps.find((s) => s.id === "owner");
    assert.equal(enrich?.willRun, false);
    // Owner discovery off; the M5 contact-validation steps stay paid.
    assert.equal(noOwner.plan.paidRecordCap, 15);
    assert.equal(noOwner.plan.estimatedCost, 45);
  } finally {
    await t.teardown();
  }
});

test("overrides: a capability override with no matching step warns and is hashed — never a silent no-op", async () => {
  const t = await createTestApp();
  try {
    const slug = await createDemoWorkflow(t.app);
    const base = await previewRun(t.app, slug, { profile: "full" });
    // The demo workflow has no email_discovery capability step, so the
    // override changes nothing — the plan says so out loud.
    const withOverride = await previewRun(t.app, slug, { profile: "full", overrides: { findEmail: true } });
    assert.ok(withOverride.plan.warnings.some((w) => w.includes("has no email_discovery step")));
    assert.notEqual(withOverride.plan.planHash, base.plan.planHash, "overrides are bound into the plan hash");
  } finally {
    await t.teardown();
  }
});

test("overrides: unknown keys are rejected (typed, not free-form)", async () => {
  const t = await createTestApp();
  try {
    const slug = await createDemoWorkflow(t.app);
    await assert.rejects(
      () => previewRun(t.app, slug, { overrides: { enableScraping: true } }),
      /Overrides are invalid/,
    );
  } finally {
    await t.teardown();
  }
});
