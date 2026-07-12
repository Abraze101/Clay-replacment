import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { exportRunCsv, resumeRun, reviewRun, runResults, runStatus } from "../src/app/run-service.js";
import { exportRun } from "../src/engine/export/export-run.js";
import { createDemoWorkflow, createTestApp, previewAndStart } from "./helpers/setup.js";

test("review gate: the run halts durably at waiting_review; export is refused before the gate", async () => {
  const t = await createTestApp();
  try {
    const slug = await createDemoWorkflow(t.app);
    const { run } = await previewAndStart(t.app, slug, { profile: "quick_list" });
    assert.equal(run.status, "waiting_review");

    // The export executor independently asserts gate passage — REVIEW_REQUIRED
    // even when invoked directly, and --force does NOT bypass it.
    await assert.rejects(
      () => exportRunCsv(t.app, run.id, false),
      (err: { code?: string }) => err.code === "REVIEW_REQUIRED",
    );
    await assert.rejects(
      () => exportRun(t.app.db, { runId: run.id, exportDir: t.exportDir, force: true }),
      (err: { code?: string }) => err.code === "REVIEW_REQUIRED",
    );
  } finally {
    await t.teardown();
  }
});

test("review gate: resume records gate passage with actor; export contains ONLY approved leads", async () => {
  const t = await createTestApp();
  try {
    const slug = await createDemoWorkflow(t.app);
    const { run } = await previewAndStart(t.app, slug, { profile: "quick_list" });

    const results = await runResults(t.app, run.id, {});
    const reviewable = results.filter((r) => r.status !== "skipped").map((r) => r.runItemId);
    const approved = reviewable.slice(0, 2);
    const rejected = reviewable.slice(2);
    await reviewRun(t.app, run.id, { reviewStatus: "approved", itemIds: approved });
    await reviewRun(t.app, run.id, { reviewStatus: "rejected", itemIds: rejected });

    const finished = await resumeRun(t.app, run.id, {});
    assert.equal(finished.status, "completed");
    const status = await runStatus(t.app, run.id);
    assert.ok(status.reviewGatePassedAt);
    assert.equal(status.counts.approved, 2);

    const csv = readFileSync(path.join(t.exportDir, `run-${run.id}.csv`), "utf8");
    const lines = csv.trimEnd().split("\r\n");
    assert.equal(lines.length, 3, "header + exactly the 2 approved leads");
    for (const line of lines.slice(1)) assert.ok(line.includes("approved"));
  } finally {
    await t.teardown();
  }
});

test("review gate: reviews require explicit targets — no silent bulk approval", async () => {
  const t = await createTestApp();
  try {
    const slug = await createDemoWorkflow(t.app);
    const { run } = await previewAndStart(t.app, slug, { profile: "quick_list" });
    await assert.rejects(
      () => reviewRun(t.app, run.id, { reviewStatus: "approved", itemIds: [] }),
      /--item ids or an explicit --all/,
    );
  } finally {
    await t.teardown();
  }
});
