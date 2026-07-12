import assert from "node:assert/strict";
import { test } from "node:test";

import type {
  PreviewResult,
  ResultsPage,
  RunItemResult,
  RunListItem,
  StartRunResponse,
  WebExportResult,
  WorkflowCreateResponse,
} from "../src/web/contracts.js";
import { createTestApp } from "./helpers/setup.js";
import { pollRunStatus, startTestWebServer } from "./helpers/web.js";

test("web api: the full happy path works over HTTP — seed, preview, start, review, resume, export, download", async () => {
  const t = await createTestApp();
  const web = await startTestWebServer(t);
  try {
    // Seed the demo template; re-seeding is idempotent.
    const seeded = await web.postJson<WorkflowCreateResponse>("/api/workflows", { template: "local-service-demo" });
    assert.equal(seeded.status, 201);
    assert.equal(seeded.body.data?.slug, "local-service-demo");
    assert.equal(seeded.body.data?.created, true);
    const reseeded = await web.postJson<WorkflowCreateResponse>("/api/workflows", { template: "local-service-demo" });
    assert.equal(reseeded.status, 200);
    assert.equal(reseeded.body.data?.created, false);

    // Preview issues the plan and a single-use approval token; nothing runs yet.
    const options = { profile: "full", cap: 10, budget: 10 };
    const preview = await web.postJson<PreviewResult>("/api/workflows/local-service-demo/preview", options);
    assert.equal(preview.status, 200);
    const plan = preview.body.data?.plan;
    assert.ok(plan, "preview returns the resolved plan");
    assert.ok(plan.estimatedCost > 0, "the full profile has a paid step");
    assert.ok(plan.steps.some((s) => s.paid && s.willRun));
    const token = preview.body.data?.approval.token;
    assert.ok(token?.startsWith("apv_"));

    // Start returns 202 immediately; execution continues in the background.
    const started = await web.postJson<StartRunResponse>("/api/workflows/local-service-demo/start", {
      ...options,
      approval: token,
    });
    assert.equal(started.status, 202);
    const runId = started.body.data?.runId;
    assert.ok(runId);

    const atGate = await pollRunStatus(web, runId, (s) => s.status === "waiting_review");
    assert.ok(atGate.counts.items > 0, "items were sourced");
    assert.ok(atGate.creditsUsed > 0, "paid fake enrichment consumed credits");

    // Pagination: walk the cursor chain and account for every item exactly once.
    let cursor: string | null = null;
    let fetched = 0;
    let total = -1;
    do {
      const page: { status: number; body: { data?: ResultsPage<RunItemResult> } } = await web.getJson(
        `/api/runs/${runId}/results?limit=5${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      );
      assert.equal(page.status, 200);
      const data = page.body.data;
      assert.ok(data);
      assert.ok(data.items.length <= 5);
      fetched += data.items.length;
      total = data.page.total;
      cursor = data.page.nextCursor;
    } while (cursor !== null);
    assert.equal(fetched, total, "cursor chain covers every item exactly once");
    assert.equal(total, atGate.counts.items);

    // Review everything, reject one completed item, continue the run.
    const reviewed = await web.postJson<{ updated: number }>(`/api/runs/${runId}/review`, {
      decision: "approved",
      all: true,
    });
    assert.equal(reviewed.status, 200);
    assert.ok((reviewed.body.data?.updated ?? 0) > 0);

    // Items are still in_progress at the gate; they complete when the run resumes.
    const gateItems = await web.getJson<ResultsPage<RunItemResult>>(`/api/runs/${runId}/results?limit=200`);
    const rejectable = gateItems.body.data?.items.find((i) => i.status === "in_progress");
    assert.ok(rejectable, "at least one reviewable item at the gate");
    const rejectOne = await web.postJson<{ updated: number }>(`/api/runs/${runId}/review`, {
      decision: "rejected",
      itemIds: [rejectable.runItemId],
    });
    assert.equal(rejectOne.body.data?.updated, 1);

    const resumed = await web.postJson<StartRunResponse>(`/api/runs/${runId}/resume`, {});
    assert.equal(resumed.status, 202);
    const final = await pollRunStatus(web, runId, (s) => s.status === "completed" || s.status === "failed");
    assert.equal(final.status, "completed");
    assert.ok(final.reviewGatePassedAt, "the gate records who/when it was passed");

    // Export approved+completed leads; the rejected lead is excluded.
    const exported = await web.postJson<WebExportResult>(`/api/runs/${runId}/export`, {});
    assert.equal(exported.status, 200);
    const exportData = exported.body.data;
    assert.ok(exportData);
    assert.ok(exportData.rowCount > 0);
    assert.equal(exportData.fileName, `run-${runId}.csv`);
    assert.ok(!("filePath" in exportData), "absolute paths never reach the browser");

    const approvedCompleted = await web.getJson<ResultsPage<RunItemResult>>(
      `/api/runs/${runId}/results?reviewStatus=approved&status=completed&limit=200`,
    );
    assert.equal(exportData.rowCount, approvedCompleted.body.data?.items.length);

    const download = await fetch(web.baseUrl + exportData.downloadUrl);
    assert.equal(download.status, 200);
    assert.match(download.headers.get("content-type") ?? "", /text\/csv/);
    assert.match(download.headers.get("content-disposition") ?? "", /attachment; filename="run-.*\.csv"/);
    const csv = await download.text();
    const lines = csv.trim().split("\n");
    assert.equal(lines.length, exportData.rowCount + 1, "header plus one line per exported lead");
    assert.match(lines[0] ?? "", /business_name/);
    assert.match(lines[0] ?? "", /suppression_status/);
    assert.ok(!csv.includes(rejectable.runItemId), "the rejected lead is not exported");

    // Re-export without changes is a no-op.
    const reexported = await web.postJson<WebExportResult>(`/api/runs/${runId}/export`, {});
    assert.equal(reexported.body.data?.noop, true);

    // Home listing shows the run with its workflow identity.
    const runs = await web.getJson<{ runs: RunListItem[] }>("/api/runs");
    const listed = runs.body.data?.runs.find((r) => r.runId === runId);
    assert.ok(listed);
    assert.equal(listed.workflowSlug, "local-service-demo");
    assert.equal(listed.status, "completed");
    assert.ok(listed.creditsUsed > 0);
  } finally {
    await web.close();
    await t.teardown();
  }
});

test("web api: interpret endpoint returns suggestions for the guided request", async () => {
  const t = await createTestApp();
  const web = await startTestWebServer(t);
  try {
    const res = await web.postJson<{ suggestions: { businessType?: { value: string } }; unmatched: string[] }>(
      "/api/interpret",
      { text: "Find 25 roofing companies around Austin" },
    );
    assert.equal(res.status, 200);
    assert.equal(res.body.data?.suggestions.businessType?.value, "roofing");
  } finally {
    await web.close();
    await t.teardown();
  }
});
