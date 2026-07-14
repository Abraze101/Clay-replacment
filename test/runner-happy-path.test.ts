import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { resumeRun, reviewRun, runResults, runStatus } from "../src/app/run-service.js";
import { listContactPoints } from "../src/storage/repositories/lead-repo.js";
import { createDemoWorkflow, createTestApp, previewAndStart } from "./helpers/setup.js";

test("happy path: full profile runs to review, resumes to completion, and exports", async () => {
  const t = await createTestApp();
  try {
    const slug = await createDemoWorkflow(t.app);
    const { run } = await previewAndStart(t.app, slug, { profile: "full" });
    assert.equal(run.status, "waiting_review");

    const mid = await runStatus(t.app, run.id);
    assert.equal(mid.counts.items, 15);
    assert.equal(mid.counts.skipped, 4);
    assert.equal(mid.counts.filtered, 1);
    assert.equal(mid.counts.identityConflicts, 3);
    assert.equal(mid.counts.failed, 1);
    assert.equal(mid.counts.stepsNeedingReview, 1);
    // 11 enrich + 18 phone validation (9 mains × 2) + 3 email verification.
    assert.equal(mid.creditsUsed, 32);

    await reviewRun(t.app, run.id, { reviewStatus: "approved", itemIds: "all" });
    const finished = await resumeRun(t.app, run.id, {});
    assert.equal(finished.status, "completed");

    const final = await runStatus(t.app, run.id);
    assert.equal(final.counts.completed, 9);
    assert.equal(final.counts.inProgress, 1, "the needs_review item stays visible, never silently completed");
    assert.ok(final.reviewGatePassedAt, "gate passage is recorded with actor attribution");

    const results = await runResults(t.app, run.id, {});
    const withOwners = results.filter((r) => r.owner !== null);
    assert.deepEqual(
      withOwners.map((r) => r.owner?.name).sort(),
      ["Dana Whitfield", "Gus Trench", "Rita Vaughn"],
    );
    const scored = results.filter((r) => r.score !== null);
    assert.ok(scored.length >= 9);
    assert.equal(results.find((r) => r.sourceKey === "fx-001")?.score, 90);

    // CSV materialized by the in-run export step: 8 data rows — fx-015's only
    // phone is format-invalid, so the call-ready selection excludes the row
    // (retained in the database and in results).
    const csvPath = path.join(t.exportDir, `run-${run.id}.csv`);
    assert.ok(existsSync(csvPath));
    const lines = readFileSync(csvPath, "utf8").trimEnd().split("\r\n");
    assert.equal(lines.length, 9);

    // Contact honesty on the enriched lead: business_main + direct + work
    // email as SEPARATE rows. Under the M5 full profile the email was
    // deliverability-checked ('valid' with provider + timestamp) and the
    // direct line status-checked — never a bare 'verified' boolean.
    const fx001 = results.find((r) => r.sourceKey === "fx-001");
    const contactPoints = await listContactPoints(t.app.db.kysely, fx001?.leadId as string);
    const roles = contactPoints.map((cp) => `${cp.type}:${cp.role}`).sort();
    assert.deepEqual(roles, ["email:work", "phone:business_main", "phone:direct"]);
    const email = contactPoints.find((cp) => cp.type === "email");
    assert.equal(email?.email_status, "valid");
    assert.equal(email?.email_status_provider, "fake-email-verification");
    assert.equal(email?.format_valid, true);
    const fx001Lead = await t.app.db.kysely
      .selectFrom("leads")
      .select(["verified_email"])
      .where("id", "=", fx001?.leadId as string)
      .executeTakeFirstOrThrow();
    assert.equal(fx001Lead.verified_email, "rita@austinroofpros.com", "a 'valid' result is verified_email's first writer");

    // Deterministic rationale persisted with evidence referencing stored rows.
    const outputs = await t.app.db.kysely.selectFrom("generated_outputs").selectAll().execute();
    assert.ok(outputs.length >= 9);
    assert.ok(outputs.every((o) => o.kind === "score_rationale" && o.model_provider === null));
    assert.ok(outputs.every((o) => o.evidence.length > 0 && o.evidence[0]?.leadSourceId));
  } finally {
    await t.teardown();
  }
});

test("happy path: quick_list spends nothing, still passes the review gate, still exports", async () => {
  const t = await createTestApp();
  try {
    const slug = await createDemoWorkflow(t.app);
    const { run } = await previewAndStart(t.app, slug, { profile: "quick_list" });
    assert.equal(run.status, "waiting_review", "quick_list still passes through review_gate");

    await reviewRun(t.app, run.id, { reviewStatus: "approved", itemIds: "all" });
    const finished = await resumeRun(t.app, run.id, {});
    assert.equal(finished.status, "completed");

    const status = await runStatus(t.app, run.id);
    assert.equal(status.creditsUsed, 0, "zero cost rows for quick_list");
    assert.equal(status.creditLimit, 0);
    assert.equal(status.counts.completed, 11, "no enrich failures in quick_list");
    assert.equal(status.counts.stepsNeedingReview, 0);

    const csvPath = path.join(t.exportDir, `run-${run.id}.csv`);
    const lines = readFileSync(csvPath, "utf8").trimEnd().split("\r\n");
    assert.equal(lines.length, 12, "11 approved completed leads exported");
    // Paid-only columns stay empty but present (whitelisted shape).
    assert.ok(lines[0]?.includes("owner_name"));
  } finally {
    await t.teardown();
  }
});
