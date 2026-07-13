import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { previewRun, resumeRun, reviewRun, startRun } from "../src/app/run-service.js";
import { createWorkflowFromDefinition } from "../src/app/workflow-service.js";
import { listRunItems } from "../src/storage/repositories/run-repo.js";
import { num } from "../src/storage/database-types.js";
import { createTestApp, type TestApp } from "./helpers/setup.js";

function importedDefinition(): Record<string, unknown> {
  return JSON.parse(readFileSync(path.resolve("examples/imported-list-enrich.workflow.json"), "utf8")) as Record<
    string,
    unknown
  >;
}

function fixtureCsv(name: string): string {
  return readFileSync(path.resolve("test/fixtures/imported", name), "utf8");
}

async function createImportedWorkflow(t: TestApp): Promise<string> {
  // The shipped template runs verbatim: imported-list is always registered;
  // person-enrichment/website-research are catalog-known (create-time OK) and
  // excluded by the quick_list profile at plan time.
  const created = await createWorkflowFromDefinition(t.app, importedDefinition());
  return created.slug;
}

test("imported list e2e: paste CSV → preview with reject warnings → approve → run → export; re-import dedupes", async () => {
  const t = await createTestApp();
  try {
    const slug = await createImportedWorkflow(t);
    const importCsv = fixtureCsv("contacts-messy.csv");

    const preview = await previewRun(t.app, slug, { importCsv });
    assert.equal(preview.plan.estimatedCost, 0, "quick_list import spends nothing");
    assert.ok(preview.plan.warnings.some((w) => /Accepted 4 of 6/.test(w)), "row rejects surface in the preview");
    assert.ok(preview.plan.warnings.some((w) => /import line \d+: /.test(w)));

    const run = await startRun(t.app, slug, preview.approval.token, { importCsv });
    assert.equal(run.status, "waiting_review");

    const items = await listRunItems(t.app.db.kysely, run.id);
    assert.equal(items.length, 4, "only accepted rows become items");
    // Same-domain/different-name is a flagged conflict, not a merge.
    const conflicted = items.filter((i) => i.dedupe_status === "conflict");
    assert.equal(conflicted.length, 1);
    assert.equal(conflicted[0]?.skip_reason, "identity_conflict");
    assert.equal((await t.app.db.kysely.selectFrom("identity_conflicts").selectAll().execute()).length, 1);

    await reviewRun(t.app, run.id, { reviewStatus: "approved", itemIds: "all" });
    const finished = await resumeRun(t.app, run.id, {});
    assert.equal(finished.status, "completed");
    assert.equal(num(finished.credits_used), 0);

    const csvPath = path.join(t.exportDir, `run-${run.id}.csv`);
    assert.ok(existsSync(csvPath));
    const lines = readFileSync(csvPath, "utf8").trimEnd().split("\r\n");
    assert.equal(lines.length, 4, "header + 3 approved rows (the conflicted row stays out)");
    assert.ok(lines.some((l) => l.includes("final@goodfinal.example")), "imported emails export");

    // Identical re-import: every accepted row matches its existing lead.
    const second = await previewRun(t.app, slug, { importCsv });
    const secondRun = await startRun(t.app, slug, second.approval.token, { importCsv });
    const secondItems = await listRunItems(t.app.db.kysely, secondRun.id);
    assert.ok(
      secondItems.every((i) => i.dedupe_status === "matched" || i.dedupe_status === "conflict"),
      "no new leads from an identical re-import",
    );
    const leadCount = (await t.app.db.kysely.selectFrom("leads").selectAll().execute()).length;
    assert.equal(leadCount, 4, "the four leads from the first run, no duplicates");
  } finally {
    await t.teardown();
  }
});

test("imported list e2e: approval binds row CONTENT — an edited CSV cannot start on the old token", async () => {
  const t = await createTestApp();
  try {
    const slug = await createImportedWorkflow(t);
    const original = fixtureCsv("contacts-clean.csv");
    const preview = await previewRun(t.app, slug, { importCsv: original });

    const edited = original.replace("Acme Roof Sample Co", "Acme Roof EDITED Co");
    await assert.rejects(
      () => startRun(t.app, slug, preview.approval.token, { importCsv: edited }),
      (err: unknown) => err instanceof Error && /approval|scope|hash/i.test(String((err as { code?: string }).code ?? err.message)),
    );

    // The untouched text still starts (same rows → same plan hash).
    const run = await startRun(t.app, slug, preview.approval.token, { importCsv: original });
    assert.equal(run.status, "waiting_review");
  } finally {
    await t.teardown();
  }
});

test("imported list e2e: guard rails — XOR with importRows, and the source refuses empty runs", async () => {
  const t = await createTestApp();
  try {
    const slug = await createImportedWorkflow(t);
    await assert.rejects(
      () =>
        previewRun(t.app, slug, {
          importCsv: fixtureCsv("contacts-clean.csv"),
          inputs: { importRows: [{ name: "Inline Co" }] },
        }),
      /not both/,
    );
    await assert.rejects(() => previewRun(t.app, slug, {}), /needs rows/);
  } finally {
    await t.teardown();
  }
});

test("imported list e2e: structured callers pass inputs.importRows directly (no CSV text)", async () => {
  const t = await createTestApp();
  try {
    const slug = await createImportedWorkflow(t);
    const preview = await previewRun(t.app, slug, {
      inputs: { importRows: [{ name: "Inline Sample Co", website: "https://inlinesample.example", title: "Owner" }] },
    });
    const run = await startRun(t.app, slug, preview.approval.token, {
      inputs: { importRows: [{ name: "Inline Sample Co", website: "https://inlinesample.example", title: "Owner" }] },
    });
    assert.equal(run.status, "waiting_review");
    const items = await listRunItems(t.app.db.kysely, run.id);
    assert.equal(items.length, 1);
    assert.match(items[0]?.source_key ?? "", /^import:domain:inlinesample\.example:[0-9a-f]{8}$/);
    assert.ok(num(items[0]?.score ?? 0) >= 25, "imported-list completeness scoring ran");
  } finally {
    await t.teardown();
  }
});
