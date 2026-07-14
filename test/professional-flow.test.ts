import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { previewRun, resumeRun, reviewRun, runResults, startRun } from "../src/app/run-service.js";
import { createWorkflowFromDefinition } from "../src/app/workflow-service.js";
import { executeRun } from "../src/engine/runner/runner.js";
import type { EnrichProvider, EnrichRequest, SourceProvider, SourceQuery, SourceRecord } from "../src/providers/types.js";
import { listContactPoints } from "../src/storage/repositories/lead-repo.js";
import { listRunItems, listSteps } from "../src/storage/repositories/run-repo.js";
import { num } from "../src/storage/database-types.js";
import { createTestApp, type TestApp } from "./helpers/setup.js";

/**
 * The M4 professional workflow e2e, on stubs registered under the REAL
 * provider-neutral names so the shipped template runs verbatim: free
 * contact-less search → score → review gate BEFORE paid enrichment → enrich
 * only approved rows within the cap → export approved rows only.
 */

function personRecords(count: number): SourceRecord[] {
  return Array.from({ length: count }, (_unused, i) => ({
    sourceKey: `ap-${i + 1}`,
    name: `Person ${i + 1} Sample`,
    kind: "person" as const,
    title: i % 2 === 0 ? "CEO" : "Founder",
    locality: "Austin",
    region: "TX",
    country: "US",
    linkedinUrl: `https://www.linkedin.com/in/sanitized-person-${i + 1}`,
    person: {
      firstName: `Person${i + 1}`,
      lastName: "Sample",
      apolloPersonId: `ap-${i + 1}`,
      employer: {
        name: `Employer ${(i % 2) + 1} Co`,
        domain: `employer-${(i % 2) + 1}.example`,
        websiteUrl: `https://employer-${(i % 2) + 1}.example`,
        apolloOrganizationId: `org-${(i % 2) + 1}`,
      },
    },
  }));
}

class StubPeopleSource implements SourceProvider {
  readonly name = "professional-contacts";
  constructor(private readonly count: number) {}
  search(query: SourceQuery): Promise<{ records: SourceRecord[]; requestId: string; coverageNote?: string }> {
    return Promise.resolve({
      records: personRecords(this.count).slice(0, query.limit),
      requestId: "stub-apollo-search",
      coverageNote: "stubbed people search (no contact data)",
    });
  }
}

class StubPersonEnricher implements EnrichProvider {
  readonly name = "person-enrichment";
  readonly costPerRecord = 1;
  readonly idempotentReplay = true;
  readonly enrichedKeys: string[] = [];
  enrich(request: EnrichRequest) {
    this.enrichedKeys.push(request.sourceKey);
    const n = request.sourceKey.split("-")[1];
    return Promise.resolve({
      kind: "match" as const,
      cost: this.costPerRecord,
      providerRequestId: `stub-match-${request.sourceKey}`,
      person: {
        firstName: request.firstName ?? "Person",
        lastName: request.lastName ?? "Sample",
        title: request.title ?? "CEO",
        workEmail: `person${n}@employer.example`,
        emailStatusClaim: "verified",
        apolloPersonId: request.apolloPersonId ?? request.sourceKey,
      },
    });
  }
}

async function createProfessionalWorkflow(t: TestApp, sourceCount: number): Promise<{ slug: string; enricher: StubPersonEnricher }> {
  const enricher = new StubPersonEnricher();
  t.app.providers.sources.set("professional-contacts", new StubPeopleSource(sourceCount));
  t.app.providers.enrichers.set("person-enrichment", enricher);
  const definition = JSON.parse(readFileSync(path.resolve("examples/professional-executive.workflow.json"), "utf8")) as Record<
    string,
    unknown
  >;
  const created = await createWorkflowFromDefinition(t.app, definition);
  return { slug: created.slug, enricher };
}

test("professional flow: quick_list is a contact-free list at zero credits — enrich never runs", async () => {
  const t = await createTestApp();
  try {
    const { slug, enricher } = await createProfessionalWorkflow(t, 5);
    const preview = await previewRun(t.app, slug, { profile: "quick_list" });
    assert.equal(preview.plan.estimatedCost, 0);
    const enrichStep = preview.plan.steps.find((s) => s.id === "enrich");
    assert.equal(enrichStep?.willRun, false);
    assert.equal(enrichStep?.excludedBy, "profile");

    const run = await startRun(t.app, slug, preview.approval.token, { profile: "quick_list" });
    assert.equal(run.status, "waiting_review");

    await reviewRun(t.app, run.id, { reviewStatus: "approved", itemIds: "all" });
    const finished = await resumeRun(t.app, run.id, {});
    assert.equal(finished.status, "completed");
    assert.equal(num(finished.credits_used), 0, "search is free and enrichment never ran");
    assert.equal(enricher.enrichedKeys.length, 0);

    // Person leads exist, scored by executive-fit, with shared employer leads.
    const leads = await t.app.db.kysely.selectFrom("leads").selectAll().execute();
    assert.equal(leads.filter((l) => l.kind === "person").length, 5);
    assert.equal(leads.filter((l) => l.kind === "business").length, 2, "two employers, deduped across people");
    const results = await runResults(t.app, run.id, {});
    assert.ok(results.every((r) => r.score !== null && r.score >= 70), "titles + linkedin + employer score pre-payment");

    const csvPath = path.join(t.exportDir, `run-${run.id}.csv`);
    assert.ok(existsSync(csvPath));
  } finally {
    await t.teardown();
  }
});

test("professional flow: full profile enriches ONLY approved rows within the cap, after the gate", async () => {
  const t = await createTestApp();
  try {
    const { slug, enricher } = await createProfessionalWorkflow(t, 5);
    const preview = await previewRun(t.app, slug, { profile: "full", cap: 3 });
    const enrichAction = preview.plan.estimatedPaidActions.find((a) => a.provider === "person-enrichment");
    assert.equal(enrichAction?.count, 3, "the cap bounds the estimated paid volume");
    // enrich 3×1 + phone discovery 3×5 + validation 3×2 + email verification 3×1.
    assert.equal(preview.plan.estimatedCost, 27);

    const run = await startRun(t.app, slug, preview.approval.token, { profile: "full", cap: 3 });
    assert.equal(run.status, "waiting_review");
    assert.equal(num(run.credits_used), 0, "the gate sits BEFORE any paid enrichment");
    assert.equal(enricher.enrichedKeys.length, 0, "no provider call before human review");

    // Reject the first row; approve the rest.
    const items = await listRunItems(t.app.db.kysely, run.id);
    const rejected = items.find((i) => i.source_key === "ap-1");
    assert.ok(rejected);
    await reviewRun(t.app, run.id, { reviewStatus: "rejected", itemIds: [rejected.id] });
    await reviewRun(
      t.app,
      run.id,
      { reviewStatus: "approved", itemIds: items.filter((i) => i.id !== rejected.id).map((i) => i.id) },
    );

    const finished = await resumeRun(t.app, run.id, {});
    assert.equal(finished.status, "completed");

    // The rejected row spent nothing and consumed NO cap slot: the cap admits
    // the next three approved rows (ap-2..ap-4). Post-gate spend covers the
    // full M5 contact chain: enrich 3 + discovery 15 + validation 6 + verify 3.
    assert.deepEqual(enricher.enrichedKeys.sort(), ["ap-2", "ap-3", "ap-4"]);
    assert.equal(num(finished.credits_used), 27);

    const rejectedSteps = await listSteps(t.app.db.kysely, rejected.id);
    assert.equal(rejectedSteps.find((s) => s.step_id === "enrich")?.status, "skipped");
    assert.equal(rejectedSteps.find((s) => s.step_id === "enrich")?.skip_reason, "review_rejected");
    const capped = items.find((i) => i.source_key === "ap-5");
    const cappedSteps = await listSteps(t.app.db.kysely, capped!.id);
    assert.equal(cappedSteps.find((s) => s.step_id === "enrich")?.skip_reason, "paid_record_cap_reached");

    // Apollo's own email claim stays metadata; what upgraded the status to
    // 'valid' is the ENGINE's M5 deliverability check (its provider recorded),
    // which is also verified_email's first and only writer.
    const enrichedItem = items.find((i) => i.source_key === "ap-2");
    const contactPoints = await listContactPoints(t.app.db.kysely, enrichedItem?.lead_id as string);
    const email = contactPoints.find((cp) => cp.type === "email");
    assert.equal(email?.email_status, "valid");
    assert.equal(email?.email_status_provider, "fake-email-verification");
    assert.equal((email?.source_metadata as { providerClaimedStatus?: string }).providerClaimedStatus, "verified");
    const lead = await t.app.db.kysely.selectFrom("leads").selectAll().where("id", "=", enrichedItem!.lead_id!).executeTakeFirstOrThrow();
    assert.equal(lead.verified_email, email?.normalized_value, "set by the 'valid' deliverability result, not by Apollo's claim");

    // The export carries only approved rows: 4 approved of 5 (rejected row out).
    const csvPath = path.join(t.exportDir, `run-${run.id}.csv`);
    const lines = readFileSync(csvPath, "utf8").trimEnd().split("\r\n");
    assert.equal(lines.length, 5, "header + the 4 approved rows");
    assert.ok(!lines.some((l) => l.includes("Person 1 Sample")), "the rejected row is not exported");
  } finally {
    await t.teardown();
  }
});

test("professional flow: replaying the completed run repeats no enrichment", async () => {
  const t = await createTestApp();
  try {
    const { slug, enricher } = await createProfessionalWorkflow(t, 3);
    const preview = await previewRun(t.app, slug, { profile: "full" });
    const run = await startRun(t.app, slug, preview.approval.token, { profile: "full" });
    await reviewRun(t.app, run.id, { reviewStatus: "approved", itemIds: "all" });
    const finished = await resumeRun(t.app, run.id, {});
    assert.equal(finished.status, "completed");
    const callsAfterFirst = enricher.enrichedKeys.length;
    assert.equal(callsAfterFirst, 3);

    // The service refuses to resume a completed run; a raw runner replay
    // (what a crash-recovery sweep could do) walks the completed steps as
    // no-ops and never repeats paid work.
    await assert.rejects(() => resumeRun(t.app, run.id, {}), /completed/);
    const again = await executeRun(t.app.runnerDeps, run.id);
    assert.equal(again.status, "completed");
    assert.equal(enricher.enrichedKeys.length, callsAfterFirst, "no second spend on replay");
    assert.equal(num(again.credits_used), 27, "enrich 3 + discovery 15 + validation 6 + verify 3, spent once");
  } finally {
    await t.teardown();
  }
});
