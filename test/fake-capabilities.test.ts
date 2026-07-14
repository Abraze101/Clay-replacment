import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { FakeContactDiscovery } from "../src/providers/fake/contact-discovery.js";
import { FakeEmailVerification } from "../src/providers/fake/email-verification.js";
import { FakePhoneValidation } from "../src/providers/fake/phone-validation.js";

const dir = mkdtempSync(path.join(tmpdir(), "fake-cap-"));
const ledger = path.join(dir, "ledger.json");

after(() => rmSync(dir, { recursive: true, force: true }));

test("fake phone validation: deterministic signals, replay never re-charges", async () => {
  const provider = new FakePhoneValidation(ledger);

  const main = await provider.validate({
    requestKey: "pv-req-1",
    phoneE164: "+15125550101",
    signals: ["line_type", "line_status"],
  });
  assert.equal(main.formatValid, true);
  assert.equal(main.lineType?.value, "landline");
  assert.equal(main.lineStatus?.value, "active");
  assert.equal(main.identityMatch, undefined, "identity_match not requested → not returned");
  assert.equal(main.cost, 2, "one unit per requested signal");

  const replay = await provider.validate({
    requestKey: "pv-req-1",
    phoneE164: "+15125550101",
    signals: ["line_type", "line_status"],
  });
  assert.equal(replay.cost, 0, "replayed requestKey returns recorded result at zero cost");
  assert.equal(replay.lineType?.value, "landline");

  const mobile = await provider.validate({
    requestKey: "pv-req-2",
    phoneE164: "+15125550161",
    signals: ["line_type", "line_status", "identity_match"],
  });
  assert.equal(mobile.lineType?.value, "mobile");
  assert.equal(mobile.identityMatch?.value, "person_match");
  assert.equal(mobile.cost, 3);

  const inactive = await provider.validate({
    requestKey: "pv-req-3",
    phoneE164: "+15125550173",
    signals: ["line_status"],
  });
  assert.equal(inactive.lineStatus?.value, "inactive");

  const mismatch = await provider.validate({
    requestKey: "pv-req-4",
    phoneE164: "+15125550174",
    signals: ["line_status", "identity_match"],
  });
  assert.equal(mismatch.identityMatch?.value, "mismatch");

  const unparseable = await provider.validate({
    requestKey: "pv-req-5",
    phoneE164: "not-a-number",
    signals: ["line_type"],
  });
  assert.equal(unparseable.formatValid, false);
  assert.equal(unparseable.cost, 0, "invalid numbers cost nothing (costOnNoResult)");
});

test("fake email verification: status vocabulary, unknown costs 0", async () => {
  const provider = new FakeEmailVerification(ledger);

  const valid = await provider.verify({ requestKey: "ev-req-1", email: "rita@austinroofpros.com" });
  assert.equal(valid.status, "valid");
  assert.equal(valid.cost, 1);

  const replay = await provider.verify({ requestKey: "ev-req-1", email: "rita@austinroofpros.com" });
  assert.equal(replay.cost, 0);

  const invalid = await provider.verify({ requestKey: "ev-req-2", email: "bounce@nowhere.example" });
  assert.equal(invalid.status, "invalid");
  assert.equal(invalid.subStatus, "mailbox_not_found");

  const catchAll = await provider.verify({ requestKey: "ev-req-3", email: "catchall@somewhere.example" });
  assert.equal(catchAll.status, "catch_all");

  const role = await provider.verify({ requestKey: "ev-req-4", email: "info@somewhere.example" });
  assert.equal(role.status, "role_based");

  const unknown = await provider.verify({ requestKey: "ev-req-5", email: "unknown@somewhere.example" });
  assert.equal(unknown.status, "unknown");
  assert.equal(unknown.cost, 0, "vendors refund unknowns (costOnUnknown)");
});

test("fake contact discovery: sync found with per-kind cost; no_result costs 0", async () => {
  const provider = new FakeContactDiscovery(ledger);

  const found = await provider.discover({
    requestKey: "cd-req-1",
    wanted: ["work_email", "direct_phone"],
    person: { firstName: "Rita", lastName: "Vaughn" },
    company: { name: "Austin Roof Pros", domain: "austinroofpros.com" },
  });
  assert.equal(found.kind, "found");
  if (found.kind !== "found") return;
  const email = found.contacts.find((c) => c.type === "email");
  const phone = found.contacts.find((c) => c.type === "phone");
  assert.equal(email?.value, "rita@austinroofpros.com");
  assert.equal(email?.vendorStatusClaim, "likely_valid", "vendor claim is data, not our judgment");
  assert.equal(phone?.value, "(512) 555-0161");
  assert.equal(found.cost, 6, "1 for the email + 5 for the direct phone");

  const replay = await provider.discover({
    requestKey: "cd-req-1",
    wanted: ["work_email", "direct_phone"],
    person: { firstName: "Rita", lastName: "Vaughn" },
    company: { name: "Austin Roof Pros", domain: "austinroofpros.com" },
  });
  assert.equal(replay.kind, "found");
  if (replay.kind === "found") assert.equal(replay.cost, 0);

  const nothing = await provider.discover({
    requestKey: "cd-req-2",
    wanted: ["work_email"],
    person: {},
    company: { name: "Nowhere Ltd", domain: "nowhere-to-be-found.example" },
  });
  assert.equal(nothing.kind, "no_result");
  if (nothing.kind === "no_result") assert.equal(nothing.cost, 0);
});

test("fake contact discovery: async submit-then-poll lifecycle with job reconciliation", async () => {
  const provider = new FakeContactDiscovery(ledger);
  const request = {
    requestKey: "cd-async-1",
    wanted: ["work_email", "mobile_phone"] as const,
    person: { firstName: "Slow", lastName: "Owner" },
    company: { name: "Slow Discovery Services", domain: "slowdiscovery.example" },
  };

  const submitted = await provider.discover(request);
  assert.equal(submitted.kind, "pending");
  if (submitted.kind !== "pending") return;
  assert.ok(submitted.jobId);
  assert.ok(submitted.pollAfterSeconds >= 1);

  // Re-submitting the same requestKey returns the SAME job, never a second submit.
  const resubmitted = await provider.discover(request);
  assert.equal(resubmitted.kind, "pending");
  if (resubmitted.kind === "pending") assert.equal(resubmitted.jobId, submitted.jobId);

  // Submit-crash reconciliation: the job is findable by the client reference.
  const reconciled = await provider.findJobByRequestKey("cd-async-1");
  assert.equal(reconciled?.jobId, submitted.jobId);

  const firstPoll = await provider.poll(submitted.jobId, request);
  assert.equal(firstPoll.kind, "pending", "first poll is still pending");

  const secondPoll = await provider.poll(submitted.jobId, request);
  assert.equal(secondPoll.kind, "found");
  if (secondPoll.kind !== "found") return;
  assert.equal(secondPoll.cost, 6, "1 email + 5 mobile, booked once at completion");
  assert.ok(secondPoll.contacts.some((c) => c.type === "email" && c.value === "owner@slowdiscovery.example"));

  // Polling after completion returns the same result without re-charging.
  const thirdPoll = await provider.poll(submitted.jobId, request);
  assert.equal(thirdPoll.kind, "found");
  if (thirdPoll.kind === "found") assert.equal(thirdPoll.cost, 0);
});
