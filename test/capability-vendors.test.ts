import assert from "node:assert/strict";
import { test } from "node:test";

import { BetterContactDiscovery } from "../src/providers/bettercontact/contact-discovery.js";
import { FullEnrichDiscovery } from "../src/providers/fullenrich/contact-discovery.js";
import { LeadMagicDiscovery } from "../src/providers/leadmagic/contact-discovery.js";
import { MillionVerifierEmailVerification } from "../src/providers/millionverifier/email-verification.js";
import { TwilioPhoneValidation } from "../src/providers/twilio/phone-validation.js";
import { ZeroBounceEmailVerification } from "../src/providers/zerobounce/email-verification.js";
import type { ContactDiscoveryRequest } from "../src/providers/capabilities.js";
import { AmbiguousOutcomeError, AppError, RateLimitError, RetryableProviderError } from "../src/shared/errors.js";

const SECRET = "vendor-secret-key-abc123";
const NO_LIMIT = { maxRequestsPerMinute: 60000 };

type StubResponse = { status: number; body: unknown; headers?: Record<string, string> } | "timeout" | "network";

function fetchStub(responses: StubResponse[]): { impl: typeof fetch; calls: { url: string; body: string }[] } {
  const calls: { url: string; body: string }[] = [];
  let index = 0;
  const impl = ((url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const urlText = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
    calls.push({ url: urlText, body: typeof init?.body === "string" ? init.body : "" });
    const next = responses[Math.min(index, responses.length - 1)]!;
    index += 1;
    if (next === "timeout") {
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    }
    if (next === "network") throw new Error("ECONNRESET");
    return Promise.resolve(
      new Response(typeof next.body === "string" ? next.body : JSON.stringify(next.body), {
        status: next.status,
        headers: next.headers,
      }),
    );
  }) as typeof fetch;
  return { impl, calls };
}

function discoveryRequest(): ContactDiscoveryRequest {
  return {
    requestKey: "cd-vendor-1",
    wanted: ["work_email", "mobile_phone"],
    person: { firstName: "Rita", lastName: "Vaughn", linkedinUrl: "linkedin.com/in/rita-example" },
    company: { name: "Austin Roof Pros", domain: "austinroofpros.com" },
  };
}

function assertNoSecret(err: unknown): void {
  const appErr = err as { message?: string; details?: unknown };
  assert.ok(!JSON.stringify({ m: appErr.message, d: appErr.details }).includes(SECRET), "API key never appears in errors");
}

// ── Twilio Lookup ───────────────────────────────────────────────────────────

function twilio(responses: StubResponse[]): TwilioPhoneValidation {
  return new TwilioPhoneValidation({
    accountSid: "AC-test",
    authToken: SECRET,
    fetchImpl: fetchStub(responses).impl,
    ...NO_LIMIT,
  });
}

test("twilio: per-signal mapping into the closed vocabulary; cost per requested package", async () => {
  const provider = twilio([
    {
      status: 200,
      body: {
        valid: true,
        phone_number: "+15125550161",
        line_type_intelligence: { type: "mobile" },
        line_status: { status: "active" },
        caller_name: { caller_name: "AUSTIN ROOF PROS LLC", caller_type: "BUSINESS" },
      },
    },
  ]);
  const result = await provider.validate({
    requestKey: "pv-1",
    phoneE164: "+15125550161",
    signals: ["line_type", "line_status", "identity_match"],
    identityHint: { kind: "business", name: "Austin Roof Pros" },
  });
  assert.equal(result.formatValid, true);
  assert.equal(result.lineType?.value, "mobile");
  assert.equal(result.lineStatus?.value, "active");
  assert.equal(result.identityMatch?.value, "business_match", "CNAM name similarity maps to business_match");
  assert.equal(result.cost, 4, "1 + 1 + 2 per requested package");
});

test("twilio: voip mapping, package-level errors → unknown, CNAM mismatch, invalid number is free", async () => {
  const voip = await twilio([
    {
      status: 200,
      body: {
        valid: true,
        line_type_intelligence: { type: "nonFixedVoip" },
        line_status: { status: null, error_code: 60600 },
        caller_name: { caller_name: "TOTALLY DIFFERENT DINER" },
      },
    },
  ]).validate({
    requestKey: "pv-2",
    phoneE164: "+15125550171",
    signals: ["line_type", "line_status", "identity_match"],
    identityHint: { kind: "business", name: "Austin Roof Pros" },
  });
  assert.equal(voip.lineType?.value, "voip");
  assert.equal(voip.lineStatus?.value, "unknown", "a package error is an honest unknown, never a guess");
  assert.equal(voip.identityMatch?.value, "mismatch");

  const invalid = await twilio([{ status: 200, body: { valid: false, validation_errors: ["TOO_SHORT"] } }]).validate({
    requestKey: "pv-3",
    phoneE164: "+1512555",
    signals: ["line_type"],
  });
  assert.equal(invalid.formatValid, false);
  assert.equal(invalid.cost, 0, "invalid numbers are free (costOnNoResult)");

  const notFound = await twilio([{ status: 404, body: { code: 20404 } }]).validate({
    requestKey: "pv-4",
    phoneE164: "+10000000000",
    signals: ["line_type"],
  });
  assert.equal(notFound.formatValid, false);
});

test("twilio: taxonomy — 429 rate-limits, 401 operator error, 5xx retryable, timeout/malformed ambiguous", async () => {
  await assert.rejects(
    () => twilio([{ status: 429, body: "{}", headers: { "retry-after": "9" } }]).validate({ requestKey: "k", phoneE164: "+15125550101", signals: ["line_type"] }),
    (err: unknown) => err instanceof RateLimitError && err.retryAfterSeconds === 9,
  );
  await assert.rejects(
    () => twilio([{ status: 401, body: "{}" }]).validate({ requestKey: "k", phoneE164: "+15125550101", signals: ["line_type"] }),
    (err: unknown) => {
      assert.ok(err instanceof AppError && err.code === "PROVIDER_ERROR" && !(err instanceof RetryableProviderError));
      assertNoSecret(err);
      return true;
    },
  );
  await assert.rejects(
    () => twilio([{ status: 503, body: "{}" }]).validate({ requestKey: "k", phoneE164: "+15125550101", signals: ["line_type"] }),
    (err: unknown) => err instanceof RetryableProviderError && err.details["charged"] === false,
  );
  await assert.rejects(
    () => twilio(["timeout"]).validate({ requestKey: "k", phoneE164: "+15125550101", signals: ["line_type", "line_status"] }),
    (err: unknown) => err instanceof AmbiguousOutcomeError && err.possibleCost === 2,
  );
  await assert.rejects(
    () => twilio([{ status: 200, body: "not json" }]).validate({ requestKey: "k", phoneE164: "+15125550101", signals: ["line_type"] }),
    (err: unknown) => err instanceof AmbiguousOutcomeError,
  );
});

// ── ZeroBounce ──────────────────────────────────────────────────────────────

function zerobounce(responses: StubResponse[]): ZeroBounceEmailVerification {
  return new ZeroBounceEmailVerification({ apiKey: SECRET, fetchImpl: fetchStub(responses).impl, ...NO_LIMIT });
}

test("zerobounce: status vocabulary mapping; unknown refunds; in-body errors are operator-facing", async () => {
  const cases: [unknown, string, number][] = [
    [{ status: "valid" }, "valid", 1],
    [{ status: "invalid", sub_status: "mailbox_not_found" }, "invalid", 1],
    [{ status: "catch-all" }, "catch_all", 1],
    [{ status: "unknown", sub_status: "timeout" }, "unknown", 0],
    [{ status: "do_not_mail", sub_status: "role_based" }, "role_based", 1],
    [{ status: "spamtrap" }, "invalid", 1],
  ];
  for (const [body, expected, cost] of cases) {
    const result = await zerobounce([{ status: 200, body }]).verify({ requestKey: "ev", email: "owner@example.com" });
    assert.equal(result.status, expected);
    assert.equal(result.cost, cost, `${expected} costs ${cost}`);
  }

  await assert.rejects(
    () => zerobounce([{ status: 200, body: { error: "Invalid API key or your account ran out of credits" } }]).verify({ requestKey: "ev", email: "owner@example.com" }),
    (err: unknown) => {
      assert.ok(err instanceof AppError && err.code === "PROVIDER_ERROR");
      assertNoSecret(err);
      return true;
    },
  );
  await assert.rejects(
    () => zerobounce(["timeout"]).verify({ requestKey: "ev", email: "owner@example.com" }),
    (err: unknown) => err instanceof AmbiguousOutcomeError && err.possibleCost === 1,
  );
});

// ── MillionVerifier ─────────────────────────────────────────────────────────

function millionverifier(responses: StubResponse[]): MillionVerifierEmailVerification {
  return new MillionVerifierEmailVerification({ apiKey: SECRET, fetchImpl: fetchStub(responses).impl, ...NO_LIMIT });
}

test("millionverifier: result mapping incl. role and disposable; unknown refunds; vendor timeout param sent", async () => {
  const stub = fetchStub([{ status: 200, body: { result: "ok", role: false } }]);
  const provider = new MillionVerifierEmailVerification({ apiKey: SECRET, fetchImpl: stub.impl, vendorTimeoutSeconds: 20, ...NO_LIMIT });
  const ok = await provider.verify({ requestKey: "mv", email: "owner@example.com" });
  assert.equal(ok.status, "valid");
  assert.match(stub.calls[0]!.url, /timeout=20/, "the vendor-side timeout keeps slow SMTP checks definitive");

  const cases: [unknown, string, number][] = [
    [{ result: "ok", role: true }, "role_based", 1],
    [{ result: "catch_all" }, "catch_all", 1],
    [{ result: "invalid", subresult: "mailbox_not_found" }, "invalid", 1],
    [{ result: "unknown" }, "unknown", 0],
    [{ result: "disposable" }, "invalid", 1],
  ];
  for (const [body, expected, cost] of cases) {
    const result = await millionverifier([{ status: 200, body }]).verify({ requestKey: "mv", email: "owner@example.com" });
    assert.equal(result.status, expected);
    assert.equal(result.cost, cost);
  }

  await assert.rejects(
    () => millionverifier([{ status: 200, body: { error: "api key not found" } }]).verify({ requestKey: "mv", email: "x@y.z" }),
    (err: unknown) => err instanceof AppError && err.code === "PROVIDER_ERROR",
  );
});

// ── BetterContact ───────────────────────────────────────────────────────────

function bettercontact(responses: StubResponse[]): BetterContactDiscovery {
  return new BetterContactDiscovery({ apiKey: SECRET, fetchImpl: fetchStub(responses).impl, ...NO_LIMIT });
}

test("bettercontact: submit-then-poll lifecycle — pending, terminated-found with vendor claim as data", async () => {
  const provider = bettercontact([
    { status: 200, body: { success: true, id: "bc-job-1" } },
    { status: 200, body: { id: "bc-job-1", status: "in progress" } },
    {
      status: 200,
      body: {
        id: "bc-job-1",
        status: "terminated",
        credits_consumed: 11,
        data: [
          {
            enriched: true,
            contact_email_address: "rita@austinroofpros.com",
            contact_email_address_status: "deliverable",
            contact_phone_number: "+15125550161",
          },
        ],
      },
    },
  ]);
  const submitted = await provider.discover(discoveryRequest());
  assert.equal(submitted.kind, "pending");
  if (submitted.kind !== "pending") return;
  assert.equal(submitted.jobId, "bc-job-1");

  const pending = await provider.poll("bc-job-1", discoveryRequest());
  assert.equal(pending.kind, "pending");

  const done = await provider.poll("bc-job-1", discoveryRequest());
  assert.equal(done.kind, "found");
  if (done.kind !== "found") return;
  assert.equal(done.cost, 11, "credits_consumed from the vendor wins over the computed estimate");
  const email = done.contacts.find((c) => c.type === "email");
  assert.equal(email?.vendorStatusClaim, "deliverable", "vendor claims stay data, never our judgment");
});

test("bettercontact: submit timeout is ambiguous (job may charge); poll failures are always retryable; poll 404 is ambiguous", async () => {
  await assert.rejects(
    () => bettercontact(["timeout"]).discover(discoveryRequest()),
    (err: unknown) => err instanceof AmbiguousOutcomeError && err.possibleCost === 11,
  );
  await assert.rejects(
    () => bettercontact(["timeout"]).poll("bc-job-2", discoveryRequest()),
    (err: unknown) => err instanceof RetryableProviderError,
  );
  await assert.rejects(
    () => bettercontact([{ status: 503, body: "{}" }]).poll("bc-job-2", discoveryRequest()),
    (err: unknown) => err instanceof RetryableProviderError,
  );
  await assert.rejects(
    () => bettercontact([{ status: 404, body: "{}" }]).poll("bc-job-2", discoveryRequest()),
    (err: unknown) => err instanceof AmbiguousOutcomeError,
  );
});

// ── FullEnrich ──────────────────────────────────────────────────────────────

function fullenrich(responses: StubResponse[]): FullEnrichDiscovery {
  return new FullEnrichDiscovery({ apiKey: SECRET, fetchImpl: fetchStub(responses).impl, ...NO_LIMIT });
}

test("fullenrich: bulk submit-then-poll; finished results map emails and typed phones", async () => {
  const provider = fullenrich([
    { status: 200, body: { enrichment_id: "fe-1" } },
    { status: 200, body: { status: "IN_PROGRESS" } },
    {
      status: 200,
      body: {
        status: "FINISHED",
        datas: [
          {
            contact: {
              emails: [{ email: "rita@austinroofpros.com", status: "valid" }],
              phones: [{ number: "+15125550161", type: "mobile" }],
            },
          },
        ],
      },
    },
  ]);
  const submitted = await provider.discover(discoveryRequest());
  assert.equal(submitted.kind, "pending");
  if (submitted.kind !== "pending") return;
  const pending = await provider.poll(submitted.jobId, discoveryRequest());
  assert.equal(pending.kind, "pending");
  const done = await provider.poll(submitted.jobId, discoveryRequest());
  assert.equal(done.kind, "found");
  if (done.kind !== "found") return;
  assert.equal(done.contacts.find((c) => c.type === "phone")?.role, "mobile");
  assert.equal(done.cost, 11, "email once + phone once");

  await assert.rejects(
    () => fullenrich([{ status: 402, body: "{}" }]).discover(discoveryRequest()),
    (err: unknown) => err instanceof AppError && err.code === "PROVIDER_ERROR" && !(err instanceof RetryableProviderError),
  );
});

// ── LeadMagic ───────────────────────────────────────────────────────────────

function leadmagic(responses: StubResponse[]): LeadMagicDiscovery {
  return new LeadMagicDiscovery({ apiKey: SECRET, fetchImpl: fetchStub(responses).impl, ...NO_LIMIT });
}

test("leadmagic: sync fan-out per wanted kind; found charges per kind; clean not-found is free", async () => {
  const found = await leadmagic([
    { status: 200, body: { email: "rita@austinroofpros.com", status: "valid", credits_consumed: 1 } },
    { status: 200, body: { mobile_number: "+15125550161", credits_consumed: 5 } },
  ]).discover(discoveryRequest());
  assert.equal(found.kind, "found");
  if (found.kind !== "found") return;
  assert.equal(found.contacts.length, 2);
  assert.equal(found.cost, 6);

  const nothing = await leadmagic([
    { status: 404, body: { message: "not found" } },
    { status: 404, body: { message: "not found" } },
  ]).discover(discoveryRequest());
  assert.equal(nothing.kind, "no_result");
  if (nothing.kind === "no_result") assert.equal(nothing.cost, 0);
});

// ── Shared neutrality suite ─────────────────────────────────────────────────
// Every implementation of a capability — fake and real — satisfies the same
// contract shape (ADR-009's "a second adapter proves the interface is
// genuinely provider-neutral", satisfied for every category).

test("capability neutrality: all email verifiers return the closed vocabulary with bounded costs", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const { FakeEmailVerification } = await import("../src/providers/fake/email-verification.js");
  const dir = mkdtempSync(path.join(tmpdir(), "cap-neutral-"));
  try {
    const verifiers = [
      new FakeEmailVerification(path.join(dir, "ledger.json")),
      zerobounce([{ status: 200, body: { status: "valid" } }]),
      millionverifier([{ status: 200, body: { result: "ok", role: false } }]),
    ];
    const VOCAB = new Set(["valid", "invalid", "catch_all", "unknown", "role_based"]);
    for (const verifier of verifiers) {
      const result = await verifier.verify({ requestKey: `neutral-${verifier.name}`, email: "rita@austinroofpros.com" });
      assert.ok(VOCAB.has(result.status), `${verifier.name}: status in the closed vocabulary`);
      assert.ok(result.providerRequestId.length > 0, `${verifier.name}: providerRequestId present`);
      assert.ok(result.cost >= 0 && result.cost <= verifier.costPerRecord, `${verifier.name}: cost within bounds`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("capability neutrality: all phone validators report per-signal results, never a bare verified flag", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const { FakePhoneValidation } = await import("../src/providers/fake/phone-validation.js");
  const dir = mkdtempSync(path.join(tmpdir(), "cap-neutral-pv-"));
  try {
    const validators = [
      new FakePhoneValidation(path.join(dir, "ledger.json")),
      twilio([
        { status: 200, body: { valid: true, line_type_intelligence: { type: "mobile" }, line_status: { status: "active" } } },
      ]),
    ];
    const LINE_TYPES = new Set(["landline", "mobile", "voip", "toll_free", "unknown"]);
    const LINE_STATUSES = new Set(["active", "inactive", "unreachable", "unknown"]);
    for (const validator of validators) {
      const result = await validator.validate({
        requestKey: `neutral-${validator.name}`,
        phoneE164: "+15125550161",
        signals: ["line_type", "line_status"],
      });
      assert.equal(typeof result.formatValid, "boolean");
      assert.ok(!("verified" in result), `${validator.name}: no single verified boolean exists`);
      assert.ok(LINE_TYPES.has(result.lineType?.value ?? "unknown"));
      assert.ok(LINE_STATUSES.has(result.lineStatus?.value ?? "unknown"));
      assert.ok(result.cost >= 0);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("leadmagic: the no-job-id vendor — a timeout on a paid sub-call is ambiguous, never auto-retried", async () => {
  await assert.rejects(
    () => leadmagic(["timeout"]).discover(discoveryRequest()),
    (err: unknown) => err instanceof AmbiguousOutcomeError,
  );
  await assert.rejects(
    () => leadmagic([{ status: 401, body: "{}" }]).discover(discoveryRequest()),
    (err: unknown) => {
      assert.ok(err instanceof AppError && err.code === "PROVIDER_ERROR");
      assertNoSecret(err);
      return true;
    },
  );
});
