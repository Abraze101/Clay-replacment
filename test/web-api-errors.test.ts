import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

import type { PreviewResult, ProviderStatusInfo, StartRunResponse } from "../src/web/contracts.js";
import { setRunStatus } from "../src/storage/repositories/run-repo.js";
import { createDemoWorkflow, createTestApp } from "./helpers/setup.js";
import { pollRunStatus, startTestWebServer, type TestWebServer } from "./helpers/web.js";

async function startDemoRun(
  web: TestWebServer,
  slug: string,
  profile: "quick_list" | "full" = "quick_list",
): Promise<string> {
  const preview = await web.postJson<PreviewResult>(`/api/workflows/${slug}/preview`, { profile });
  const started = await web.postJson<StartRunResponse>(`/api/workflows/${slug}/start`, {
    approval: preview.body.data?.approval.token,
    profile,
  });
  assert.equal(started.status, 202);
  const runId = started.body.data?.runId;
  assert.ok(runId);
  return runId;
}

test("web api: transport and validation errors map to machine-readable envelopes", async () => {
  const t = await createTestApp();
  const web = await startTestWebServer(t);
  try {
    const unknownRoute = await web.getJson("/api/nope");
    assert.equal(unknownRoute.status, 404);
    assert.equal(unknownRoute.body.error?.code, "NOT_FOUND");

    const deleted = await fetch(`${web.baseUrl}/api/runs`, { method: "DELETE" });
    assert.equal(deleted.status, 405);

    const malformed = await fetch(`${web.baseUrl}/api/interpret`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{oops",
    });
    assert.equal(malformed.status, 400);
    const malformedBody = (await malformed.json()) as { error?: { code?: string } };
    assert.equal(malformedBody.error?.code, "VALIDATION_FAILED");

    const oversized = await fetch(`${web.baseUrl}/api/interpret`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "x".repeat(1_100_000) }),
    });
    assert.equal(oversized.status, 413);

    const missingRun = await web.getJson(`/api/runs/${randomUUID()}/status`);
    assert.equal(missingRun.status, 404);
    assert.equal(missingRun.body.error?.code, "NOT_FOUND");

    const badRunId = await web.getJson("/api/runs/not-a-uuid/export/download");
    assert.equal(badRunId.status, 400);
    assert.equal(badRunId.body.error?.code, "VALIDATION_FAILED");

    const badBody = await web.postJson("/api/interpret", { text: "" });
    assert.equal(badBody.status, 400);
    assert.equal(badBody.body.error?.code, "VALIDATION_FAILED");
  } finally {
    await web.close();
    await t.teardown();
  }
});

test("web api: run-state guards — review-while-running, invalid cursor, export before gate, XOR, cancel terminal", async () => {
  const t = await createTestApp();
  const web = await startTestWebServer(t);
  try {
    const slug = await createDemoWorkflow(t.app);
    const runId = await startDemoRun(web, slug);
    await pollRunStatus(web, runId, (s) => s.status === "waiting_review");

    // Review XOR: both or neither selector is a validation error.
    const both = await web.postJson(`/api/runs/${runId}/review`, {
      decision: "approved",
      all: true,
      itemIds: ["x"],
    });
    assert.equal(both.status, 400);
    const neither = await web.postJson(`/api/runs/${runId}/review`, { decision: "approved" });
    assert.equal(neither.status, 400);

    // Export before the review gate has been passed.
    const early = await web.postJson(`/api/runs/${runId}/export`, {});
    assert.equal(early.status, 409);
    assert.equal(early.body.error?.code, "REVIEW_REQUIRED");

    // Review while running: force the state directly (deterministic, no race).
    await setRunStatus(t.app.db.kysely, runId, "running");
    const whileRunning = await web.postJson(`/api/runs/${runId}/review`, { decision: "approved", all: true });
    assert.equal(whileRunning.status, 409);
    assert.equal(whileRunning.body.error?.code, "CONFLICT");
    await setRunStatus(t.app.db.kysely, runId, "waiting_review");

    // Invalid results cursor.
    const badCursor = await web.getJson(`/api/runs/${runId}/results?cursor=garbage`);
    assert.equal(badCursor.status, 400);
    assert.equal(badCursor.body.error?.code, "VALIDATION_FAILED");

    // Finish the run, then cancel must refuse.
    await web.postJson(`/api/runs/${runId}/review`, { decision: "approved", all: true });
    await web.postJson(`/api/runs/${runId}/resume`, {});
    await pollRunStatus(web, runId, (s) => s.status === "completed");
    const cancelDone = await web.postJson(`/api/runs/${runId}/cancel`, {});
    assert.equal(cancelDone.status, 409);
    assert.equal(cancelDone.body.error?.code, "RUN_NOT_RUNNABLE");
  } finally {
    await web.close();
    await t.teardown();
  }
});

test("web api: provider status exposes connection booleans and never the key value", async () => {
  const t = await createTestApp();
  // A real-looking key value in the environment must never cross the wire —
  // the payload may only name the env VAR that would connect a provider.
  const SECRET = "sk-super-secret-serpapi-value-12345";
  t.app.env.SERPAPI_API_KEY = SECRET;
  const web = await startTestWebServer(t);
  try {
    const res = await web.getJson<{ providers: ProviderStatusInfo[] }>("/api/providers");
    assert.equal(res.status, 200);
    const providers = res.body.data?.providers;
    assert.ok(providers);
    // M3: the three fakes (registered) plus the live-provider catalog, which
    // surfaces unconfigured providers as connected:false.
    assert.deepEqual(
      providers.map((p) => p.name).sort(),
      ["fake-apollo", "fake-places", "fake-website", "local-business", "website-research"],
    );
    for (const provider of providers.filter((p) => p.name.startsWith("fake-"))) {
      assert.equal(provider.connected, true);
    }
    const enricher = providers.find((p) => p.kind === "enrich");
    assert.equal(enricher?.paid, true);
    assert.equal(enricher?.costPerRecord, 1);

    // The registry was built before the key was injected, so local-business
    // reports missing here; the catalog names its env var without any value.
    const localBusiness = providers.find((p) => p.name === "local-business");
    assert.equal(localBusiness?.connected, false);
    assert.equal(localBusiness?.requiresEnv, "SERPAPI_API_KEY");
    assert.equal(localBusiness?.paid, true);

    const raw = JSON.stringify(res.body);
    assert.ok(!raw.includes(SECRET), "the key VALUE never appears in the provider payload");
    assert.ok(!/"apiKey"|"api_key"|"token"|"secret"/i.test(raw), "no secret-shaped FIELDS in the provider payload");
  } finally {
    await web.close();
    await t.teardown();
  }
});
