import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { parseEnv } from "../src/config/env.js";
import { previewRun } from "../src/app/run-service.js";
import { createWorkflowFromDefinition } from "../src/app/workflow-service.js";
import { buildRegistry } from "../src/providers/registry.js";
import { FirecrawlClient } from "../src/providers/firecrawl/client.js";
import { FirecrawlWebsiteResearch } from "../src/providers/firecrawl/website-research.js";
import { AmbiguousOutcomeError, RateLimitError } from "../src/shared/errors.js";
import { num } from "../src/storage/database-types.js";
import { createTestApp, previewAndStart } from "./helpers/setup.js";
import { stubFetch } from "./helpers/serpapi-stub.js";

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(path.resolve("test/fixtures/firecrawl", name), "utf8"));
}

function research(fetchImpl: typeof fetch): FirecrawlWebsiteResearch {
  const client = new FirecrawlClient({
    apiKey: "fc-test",
    baseUrl: "https://firecrawl.test",
    maxRequestsPerMinute: 6000,
    fetchImpl,
  });
  return new FirecrawlWebsiteResearch({ client, costPerRecord: 1 });
}

test("firecrawl research: a successful scrape yields a grounded summary and facts", async () => {
  const provider = research(stubFetch(() => ({ status: 200, body: loadFixture("scrape-ok.json") })));
  const outcome = await provider.research({ websiteUrl: "https://austinroofingco.example", normalizedDomain: "austinroofingco.example" });
  assert.equal(outcome.kind, "ok");
  if (outcome.kind === "ok") {
    assert.ok(outcome.summary.includes("Austin Roofing Co"));
    assert.equal(outcome.facts["description"], "Family-owned Austin roofing contractor. Free estimates.");
    assert.equal(outcome.providerRequestId, "https://austinroofingco.example");
  }
});

test("firecrawl research: site failures leave research unavailable; the run continues", async () => {
  // Vendor-level "cannot scrape this site" (success:false on 200).
  const notSupported = research(stubFetch(() => ({ status: 200, body: loadFixture("scrape-failed.json") })));
  const o1 = await notSupported.research({ websiteUrl: "https://blocked.example" });
  assert.equal(o1.kind, "unavailable");

  // Site 404 via Firecrawl error status.
  const notFound = research(stubFetch(() => ({ status: 404, body: { error: "not found" } })));
  const o2 = await notFound.research({ websiteUrl: "https://gone.example" });
  assert.equal(o2.kind, "unavailable");

  // Out of credits: non-retryable, but still leaves the lead usable.
  const noCredits = research(stubFetch(() => ({ status: 402, body: { error: "no credits" } })));
  const o3 = await noCredits.research({ websiteUrl: "https://site.example" });
  assert.equal(o3.kind, "unavailable");

  // No website at all.
  const o4 = await notSupported.research({ websiteUrl: null, normalizedDomain: null });
  assert.equal(o4.kind, "unavailable");
});

test("firecrawl research: a 429 propagates as RateLimitError (Retry-After honored)", async () => {
  const provider = research(
    stubFetch(() => ({ status: 429, body: { error: "rate limited" }, headers: { "retry-after": "45" } })),
  );
  await assert.rejects(
    () => provider.research({ websiteUrl: "https://site.example" }),
    (err: unknown) => err instanceof RateLimitError && err.retryAfterSeconds === 45,
  );
});

test("firecrawl research: a possibly-billed outcome (unreadable 200) propagates as ambiguous with provisional cost", async () => {
  // The scrape may have completed and been charged — it must reach the runner's
  // needs_review handler, never be swallowed into a free 'unavailable'.
  const provider = research(stubFetch(() => ({ status: 200, body: "not-json{{{" })));
  await assert.rejects(
    () => provider.research({ websiteUrl: "https://site.example" }),
    (err: unknown) => err instanceof AmbiguousOutcomeError && err.possibleCost === 1,
  );
});

test("firecrawl research: a scraped 404 page is unavailable, not research evidence", async () => {
  const provider = research(
    stubFetch(() => ({
      status: 200,
      body: {
        success: true,
        data: { markdown: "Page not found", metadata: { title: "404", statusCode: 404, sourceURL: "https://x.example" } },
      },
    })),
  );
  const outcome = await provider.research({ websiteUrl: "https://x.example" });
  assert.equal(outcome.kind, "unavailable");
});

test("firecrawl client: creditUsage reads remaining credits (zero-scrape connection test)", async () => {
  const client = new FirecrawlClient({
    apiKey: "fc-test",
    baseUrl: "https://firecrawl.test",
    maxRequestsPerMinute: 6000,
    fetchImpl: stubFetch(() => ({ status: 200, body: loadFixture("credit-usage.json") })),
  });
  const usage = await client.creditUsage();
  assert.equal(usage.remainingCredits, 987);
});

test("registry: firecrawl research is doubly opt-in (flag AND key)", () => {
  const base = { FAKE_ENRICH_LEDGER_PATH: "./x.json" };
  const off = buildRegistry(parseEnv({}), { enrichLedgerPath: base.FAKE_ENRICH_LEDGER_PATH });
  assert.ok(!off.researchers.has("website-research"));

  const keyOnly = buildRegistry(parseEnv({ FIRECRAWL_API_KEY: "fc-k" }), { enrichLedgerPath: base.FAKE_ENRICH_LEDGER_PATH });
  assert.ok(!keyOnly.researchers.has("website-research"), "key without the flag stays off");

  const flagOnly = buildRegistry(parseEnv({ WEBSITE_RESEARCH_PROVIDER: "firecrawl" }), { enrichLedgerPath: base.FAKE_ENRICH_LEDGER_PATH });
  assert.ok(!flagOnly.researchers.has("website-research"), "flag without the key stays off");

  const on = buildRegistry(parseEnv({ WEBSITE_RESEARCH_PROVIDER: "firecrawl", FIRECRAWL_API_KEY: "fc-k" }), {
    enrichLedgerPath: base.FAKE_ENRICH_LEDGER_PATH,
  });
  assert.ok(on.researchers.has("website-research"));
});

test("plan + runner: a paid research provider is priced per record and books cost on success", async () => {
  const t = await createTestApp();
  try {
    // Register a paid research provider under a distinct name.
    t.app.providers.researchers.set(
      "website-research",
      research(stubFetch(() => ({ status: 200, body: loadFixture("scrape-ok.json") }))),
    );
    const created = await createWorkflowFromDefinition(t.app, {
      id: "research-paid-demo",
      version: 1,
      name: "Paid research demo",
      inputs: { businessType: "roofing contractor", locations: ["Austin, TX"], limit: 5, enrichmentProfile: "call_ready" },
      steps: [
        { id: "discover", type: "source", provider: "fake-places" },
        { id: "normalize", type: "normalize" },
        { id: "dedupe", type: "dedupe" },
        { id: "website", type: "research", provider: "website-research" },
        { id: "review", type: "review_gate" },
        { id: "export", type: "export", format: "csv" },
      ],
    });

    const { plan } = await previewRun(t.app, created.slug, {});
    const action = plan.estimatedPaidActions.find((a) => a.stepId === "website");
    assert.ok(action, "paid research appears in the estimated actions");
    assert.equal(action?.costPerRecord, 1);
    assert.equal(plan.paidRecordCap, 5, "research is an item-level paid step and uses the record cap");

    const { run } = await previewAndStart(t.app, created.slug, {});
    assert.equal(run.status, "waiting_review");
    // One credit per lead whose site was actually scraped; leads without a
    // website (research 'unavailable') and dedupe-skipped items book nothing.
    const researchSteps = await t.app.db.kysely
      .selectFrom("run_item_steps")
      .selectAll()
      .where("step_id", "=", "website")
      .where("status", "=", "completed")
      .execute();
    const charged = researchSteps.filter((s) => num(s.cost_units) > 0);
    const free = researchSteps.filter((s) => num(s.cost_units) === 0);
    assert.ok(charged.length >= 2, "at least two fixture leads have scrapeable websites");
    assert.ok(free.length >= 1, "the no-website fixture lead books nothing");
    assert.equal(num(run.credits_used), charged.length, "credits match the scraped-lead count exactly");
  } finally {
    await t.teardown();
  }
});
