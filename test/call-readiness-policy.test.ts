import assert from "node:assert/strict";
import { test } from "node:test";

import {
  evaluateCallReadiness,
  selectAcceptancePhones,
  type ReadinessPhone,
} from "../src/engine/policy/call-readiness.js";
import type { PlanPolicy } from "../src/engine/workflow-schema/plan.js";

const DEFAULT_POLICY: PlanPolicy = {
  requireDirectPhone: false,
  acceptBusinessMainPhone: true,
  acceptCatchAllEmail: false,
  phoneValidationRequested: true,
  emailVerificationRequested: false,
};

const DIRECT_ONLY: PlanPolicy = { ...DEFAULT_POLICY, requireDirectPhone: true, acceptBusinessMainPhone: false };

let seq = 0;
function phone(partial: Partial<ReadinessPhone> & { e164: string }): ReadinessPhone {
  seq += 1;
  return {
    id: `cp-${String(seq).padStart(3, "0")}`,
    role: "business_main",
    formatValid: true,
    lineStatus: null,
    lineStatusCheckedAt: null,
    lineStatusProvider: null,
    identityMatch: null,
    ...partial,
  };
}

const CHECKED = { lineStatusCheckedAt: "2026-07-13T10:00:00Z", lineStatusProvider: "fake-phone-validation" };

test("readiness: format-only is NEVER ready — it stays unchecked", () => {
  const result = evaluateCallReadiness({
    phones: [phone({ e164: "+15125550101", formatValid: true })],
    suppressions: [],
    policy: DEFAULT_POLICY,
  });
  assert.equal(result.status, "unchecked");
  assert.equal(result.reason, "phone validation not performed");
});

test("readiness: validated active line is ready, with provider and date in the reason", () => {
  const result = evaluateCallReadiness({
    phones: [phone({ e164: "+15125550101", lineStatus: "active", identityMatch: "business_match", ...CHECKED })],
    suppressions: [],
    policy: DEFAULT_POLICY,
  });
  assert.equal(result.status, "ready");
  assert.equal(
    result.reason,
    "business_main +15125550101 line_status=active, identity=business_match (fake-phone-validation 2026-07-13)",
  );
});

test("readiness: requireDirectPhone makes a validated business main insufficient", () => {
  const phones = [phone({ e164: "+15125550101", lineStatus: "active", ...CHECKED })];
  assert.equal(evaluateCallReadiness({ phones, suppressions: [], policy: DEFAULT_POLICY }).status, "ready");
  const direct = evaluateCallReadiness({ phones, suppressions: [], policy: DIRECT_ONLY });
  assert.equal(direct.status, "invalid");
  assert.equal(direct.reason, "no acceptable phone on file (policy: direct/mobile only)");
});

test("readiness: checked-but-unknown line status is uncertain — unknown is never cleared", () => {
  const result = evaluateCallReadiness({
    phones: [phone({ e164: "+15125550178", lineStatus: "unknown", ...CHECKED })],
    suppressions: [],
    policy: DEFAULT_POLICY,
  });
  assert.equal(result.status, "uncertain");
  assert.match(result.reason, /checked but line status unknown/);
});

test("readiness: inactive, unreachable, format-invalid, and identity-mismatch lines are invalid", () => {
  for (const bad of [
    phone({ e164: "+15125550173", lineStatus: "inactive", ...CHECKED }),
    phone({ e164: "+15125550173", lineStatus: "unreachable", ...CHECKED }),
    phone({ e164: "+15125550173", formatValid: false }),
    phone({ e164: "+15125550174", lineStatus: "active", identityMatch: "mismatch", ...CHECKED }),
  ]) {
    const result = evaluateCallReadiness({ phones: [bad], suppressions: [], policy: DEFAULT_POLICY });
    assert.equal(result.status, "invalid", `expected invalid for ${JSON.stringify(bad)}`);
  }
});

test("readiness: a disqualified main line plus an unchecked direct stays unchecked, not invalid", () => {
  const result = evaluateCallReadiness({
    phones: [
      phone({ e164: "+15125550173", role: "business_main", lineStatus: "inactive", ...CHECKED }),
      phone({ e164: "+15125550161", role: "direct" }),
    ],
    suppressions: [],
    policy: DEFAULT_POLICY,
  });
  assert.equal(result.status, "unchecked");
});

test("readiness: no phones at all — invalid with the policy named", () => {
  const result = evaluateCallReadiness({ phones: [], suppressions: [], policy: DEFAULT_POLICY });
  assert.equal(result.status, "invalid");
  assert.equal(result.reason, "no acceptable phone on file (policy: any business line)");
});

test("readiness: toll_free and unknown roles never qualify as candidates", () => {
  const result = evaluateCallReadiness({
    phones: [
      phone({ e164: "+18005550100", role: "toll_free", lineStatus: "active", ...CHECKED }),
      phone({ e164: "+15125550199", role: "unknown", lineStatus: "active", ...CHECKED }),
    ],
    suppressions: [],
    policy: DEFAULT_POLICY,
  });
  assert.equal(result.status, "invalid");
});

test("readiness: suppression wins — lead scope, domain scope, and phone scope", () => {
  const readyPhone = phone({ e164: "+15125550101", lineStatus: "active", ...CHECKED });

  const leadScoped = evaluateCallReadiness({
    phones: [readyPhone],
    suppressions: [{ scope: "lead", normalizedValue: "11111111-1111-1111-1111-111111111111" }],
    policy: DEFAULT_POLICY,
  });
  assert.equal(leadScoped.status, "suppressed");
  assert.match(leadScoped.reason, /lead suppressed \(lead:/);

  const domainScoped = evaluateCallReadiness({
    phones: [readyPhone],
    suppressions: [{ scope: "domain", normalizedValue: "suppressed.example" }],
    policy: DEFAULT_POLICY,
  });
  assert.equal(domainScoped.status, "suppressed");

  const phoneScoped = evaluateCallReadiness({
    phones: [readyPhone],
    suppressions: [{ scope: "phone", normalizedValue: "+15125550101" }],
    policy: DEFAULT_POLICY,
  });
  assert.equal(phoneScoped.status, "suppressed");
  assert.match(phoneScoped.reason, /only callable number\(s\) suppressed: \+15125550101/);
});

test("readiness: an unsuppressed validated number outranks a suppressed one", () => {
  const result = evaluateCallReadiness({
    phones: [
      phone({ e164: "+15125550101", role: "business_main", lineStatus: "active", ...CHECKED }),
      phone({ e164: "+15125550161", role: "direct", lineStatus: "active", ...CHECKED }),
    ],
    suppressions: [{ scope: "phone", normalizedValue: "+15125550161" }],
    policy: DEFAULT_POLICY,
  });
  assert.equal(result.status, "ready");
  assert.match(result.reason, /business_main \+15125550101/);
});

test("readiness: every candidate suppressed (even unvalidated) is suppressed, not unchecked", () => {
  const result = evaluateCallReadiness({
    phones: [phone({ e164: "+15125550101" })],
    suppressions: [{ scope: "phone", normalizedValue: "+15125550101" }],
    policy: DEFAULT_POLICY,
  });
  assert.equal(result.status, "suppressed");
  assert.match(result.reason, /all acceptable numbers are suppressed/);
});

test("readiness: deterministic — identical input yields identical output", () => {
  const input = {
    phones: [
      phone({ id: "cp-fixed-1", e164: "+15125550101", lineStatus: "active" as const, ...CHECKED }),
      phone({ id: "cp-fixed-2", e164: "+15125550161", role: "direct" as const }),
    ],
    suppressions: [],
    policy: DEFAULT_POLICY,
  };
  assert.deepEqual(evaluateCallReadiness(input), evaluateCallReadiness(input));
});

test("acceptance ordering: direct > mobile > business_main, validated first within a role", () => {
  const businessValidated = phone({ e164: "+15125550101", role: "business_main", lineStatus: "active", ...CHECKED });
  const directUnchecked = phone({ e164: "+15125550161", role: "direct" });
  const mobileValidated = phone({ e164: "+15125550162", role: "mobile", lineStatus: "active", ...CHECKED });
  const ordered = selectAcceptancePhones([businessValidated, directUnchecked, mobileValidated], DEFAULT_POLICY);
  assert.deepEqual(
    ordered.map((p) => p.e164),
    ["+15125550161", "+15125550162", "+15125550101"],
    "role preference dominates validation state across roles",
  );

  const directValidated = phone({ e164: "+15125550163", role: "direct", lineStatus: "active", ...CHECKED });
  const withinRole = selectAcceptancePhones([directUnchecked, directValidated], DEFAULT_POLICY);
  assert.equal(withinRole[0]?.e164, "+15125550163", "validated-active first within the same role");
});
