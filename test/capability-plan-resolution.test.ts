import assert from "node:assert/strict";
import { test } from "node:test";

import { createWorkflowFromDefinition } from "../src/app/workflow-service.js";
import { previewRun } from "../src/app/run-service.js";
import { parseWorkflowDefinition } from "../src/engine/workflow-schema/workflow.js";
import { createTestApp } from "./helpers/setup.js";

/** A call-ready-shaped workflow with all four visible capability steps. */
function capabilityDefinition(): Record<string, unknown> {
  return {
    id: "cap-plan-test",
    version: 1,
    name: "Capability plan resolution test",
    inputs: {
      businessType: "roofing contractor",
      locations: ["Austin, TX"],
      limit: 20,
      enrichmentProfile: "call_ready",
    },
    steps: [
      { id: "discover", type: "source", provider: "fake-places" },
      { id: "normalize", type: "normalize" },
      { id: "dedupe", type: "dedupe" },
      { id: "find-phones", type: "enrich", capability: "phone_discovery", profiles: ["call_ready", "full"] },
      { id: "validate-phones", type: "enrich", capability: "phone_validation", profiles: ["call_ready", "full"] },
      { id: "find-email", type: "enrich", capability: "email_discovery", profiles: ["full"] },
      { id: "verify-email", type: "enrich", capability: "email_verification", profiles: ["full"] },
      { id: "review", type: "review_gate" },
      { id: "export", type: "export", format: "csv" },
    ],
  };
}

function stepById(plan: { steps: { id: string }[] }, id: string) {
  return (plan.steps as { id: string; willRun: boolean; excludedBy?: string; includedBy?: string; provider?: string; costPerRecord: number; capability?: string }[]).find(
    (s) => s.id === id,
  );
}

test("capability plan: preset matrix — quick_list none, call_ready phones, full everything", async () => {
  const t = await createTestApp();
  try {
    const created = await createWorkflowFromDefinition(t.app, capabilityDefinition());

    const quick = await previewRun(t.app, created.slug, { profile: "quick_list" });
    for (const id of ["find-phones", "validate-phones", "find-email", "verify-email"]) {
      assert.equal(stepById(quick.plan, id)?.willRun, false, `${id} excluded under quick_list`);
      assert.equal(stepById(quick.plan, id)?.excludedBy, "profile");
    }
    assert.equal(quick.plan.paidRecordCap, 0);
    assert.equal(quick.plan.estimatedCost, 0);

    const callReady = await previewRun(t.app, created.slug, { profile: "call_ready" });
    assert.equal(stepById(callReady.plan, "find-phones")?.willRun, true);
    assert.equal(stepById(callReady.plan, "validate-phones")?.willRun, true);
    assert.equal(stepById(callReady.plan, "find-email")?.willRun, false);
    assert.equal(stepById(callReady.plan, "verify-email")?.willRun, false);
    // Capability steps price from the registry: discovery = phone once (5),
    // validation = line_type + line_status (1 + 1). Cap = limit (20).
    assert.equal(stepById(callReady.plan, "find-phones")?.costPerRecord, 5);
    assert.equal(stepById(callReady.plan, "validate-phones")?.costPerRecord, 2);
    assert.equal(stepById(callReady.plan, "find-phones")?.provider, "fake-contact-discovery");
    assert.equal(callReady.plan.paidRecordCap, 20);
    assert.equal(callReady.plan.estimatedCost, 20 * 5 + 20 * 2);
    assert.equal(callReady.plan.policy.phoneValidationRequested, true);
    assert.equal(callReady.plan.policy.emailVerificationRequested, false);

    const full = await previewRun(t.app, created.slug, { profile: "full" });
    for (const id of ["find-phones", "validate-phones", "find-email", "verify-email"]) {
      assert.equal(stepById(full.plan, id)?.willRun, true, `${id} runs under full`);
    }
    assert.equal(full.plan.estimatedCost, 20 * 5 + 20 * 2 + 20 * 1 + 20 * 1);
  } finally {
    await t.teardown();
  }
});

test("capability plan: overrides force-include and exclude their steps; every flip changes the hash", async () => {
  const t = await createTestApp();
  try {
    const created = await createWorkflowFromDefinition(t.app, capabilityDefinition());
    const base = await previewRun(t.app, created.slug, { profile: "call_ready" });

    // findEmail:true force-includes the profile-excluded email discovery step.
    const withEmail = await previewRun(t.app, created.slug, { profile: "call_ready", overrides: { findEmail: true } });
    const findEmail = stepById(withEmail.plan, "find-email");
    assert.equal(findEmail?.willRun, true);
    assert.equal(findEmail?.includedBy, "override");
    assert.equal(stepById(withEmail.plan, "verify-email")?.willRun, false, "validateEmail stays off independently");
    assert.equal(withEmail.plan.estimatedCost, base.plan.estimatedCost + 20 * 1);

    // validatePhones:false excludes a profile-enabled step.
    const noValidate = await previewRun(t.app, created.slug, {
      profile: "call_ready",
      overrides: { validatePhones: false },
    });
    const validate = stepById(noValidate.plan, "validate-phones");
    assert.equal(validate?.willRun, false);
    assert.equal(validate?.excludedBy, "override");
    assert.equal(noValidate.plan.policy.phoneValidationRequested, false);

    // Every override flip yields a distinct approval scope.
    const hashes = new Set([base.plan.planHash, withEmail.plan.planHash, noValidate.plan.planHash]);
    assert.equal(hashes.size, 3);

    // No "arrives at Milestone 5" placeholders anywhere.
    for (const plan of [base.plan, withEmail.plan, noValidate.plan]) {
      assert.ok(!plan.warnings.some((w) => w.includes("Milestone 5")));
    }
  } finally {
    await t.teardown();
  }
});

test("capability plan: quick_list ignores force-includes with a warning — the free path stays free", async () => {
  const t = await createTestApp();
  try {
    const created = await createWorkflowFromDefinition(t.app, capabilityDefinition());
    const plan = (
      await previewRun(t.app, created.slug, { profile: "quick_list", overrides: { findPhones: true } })
    ).plan;
    assert.equal(stepById(plan, "find-phones")?.willRun, false);
    assert.ok(plan.warnings.some((w) => w.includes("quick_list enables no paid contact steps")));
    assert.equal(plan.estimatedCost, 0);
  } finally {
    await t.teardown();
  }
});

test("capability plan: policy derives from overrides; requireDirectPhone wins over acceptBusinessMainPhone", async () => {
  const t = await createTestApp();
  try {
    const created = await createWorkflowFromDefinition(t.app, capabilityDefinition());

    const defaults = (await previewRun(t.app, created.slug, { profile: "call_ready" })).plan.policy;
    assert.deepEqual(defaults, {
      requireDirectPhone: false,
      acceptBusinessMainPhone: true,
      acceptCatchAllEmail: false,
      phoneValidationRequested: true,
      emailVerificationRequested: false,
    });

    const direct = await previewRun(t.app, created.slug, {
      profile: "call_ready",
      overrides: { requireDirectPhone: true, acceptBusinessMainPhone: true },
    });
    assert.equal(direct.plan.policy.requireDirectPhone, true);
    assert.equal(direct.plan.policy.acceptBusinessMainPhone, false, "direct requirement forces business-main off");
    assert.ok(direct.plan.warnings.some((w) => w.includes("requireDirectPhone conflicts")));
  } finally {
    await t.teardown();
  }
});

/** Validation issues are structured details on the AppError, not prose in the message. */
function validationIssues(raw: unknown): string {
  try {
    parseWorkflowDefinition(raw);
    return "";
  } catch (err) {
    const details = (err as { details?: { issues?: { message: string }[] } }).details;
    return (details?.issues ?? []).map((i) => i.message).join("; ");
  }
}

test("capability schema: structural rules — provider-or-capability, signals placement, ordering, duplicates", () => {
  const base = capabilityDefinition();
  const steps = base["steps"] as Record<string, unknown>[];

  // enrich without provider AND without capability
  const noNothing = structuredClone(base);
  (noNothing["steps"] as Record<string, unknown>[])[3] = { id: "find-phones", type: "enrich", profiles: ["call_ready", "full"] };
  assert.match(validationIssues(noNothing), /provider, a capability, or both/);

  // signals on a non-validation capability step
  const badSignals = structuredClone(base);
  ((badSignals["steps"] as Record<string, unknown>[])[3] as Record<string, unknown>)["signals"] = ["line_status"];
  assert.match(validationIssues(badSignals), /signals apply only/);

  // duplicate capability
  const dupe = structuredClone(base);
  (dupe["steps"] as Record<string, unknown>[]).splice(4, 0, {
    id: "validate-again",
    type: "enrich",
    capability: "phone_validation",
    profiles: ["call_ready", "full"],
  });
  assert.match(validationIssues(dupe), /duplicate capability/);

  // validation before its discovery
  const misordered = structuredClone(base);
  const list = misordered["steps"] as Record<string, unknown>[];
  const [findPhones] = list.splice(3, 1);
  list.splice(4, 0, findPhones!);
  assert.match(validationIssues(misordered), /must precede/);

  assert.equal(steps.length, 9, "the base definition itself stays valid");
  parseWorkflowDefinition(base);
});
