import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createContainer } from "../src/app/container.js";
import {
  exportRunCsv,
  previewRun,
  resumeRun,
  reviewRun,
  runResults,
  startRun,
} from "../src/app/run-service.js";
import { createWorkflowFromDefinition } from "../src/app/workflow-service.js";
import { migrate } from "../src/storage/migrate.js";
import { startSerpApiStubServer } from "./helpers/serpapi-stub.js";

const EXAMPLE = JSON.parse(
  readFileSync(path.resolve("examples/local-business-quick-list.workflow.json"), "utf8"),
) as Record<string, unknown>;

test("quicklist e2e: SerpAPI stub -> preview cost -> approve -> run -> review -> export CSV, second run dedupes", async () => {
  const stub = await startSerpApiStubServer(); // serves the Austin fixture for /search
  const tempDir = mkdtempSync(path.join(tmpdir(), "lb-e2e-"));
  const app = await createContainer({
    DATABASE_URL: "pglite://memory",
    EXPORT_DIR: path.join(tempDir, "exports"),
    FAKE_ENRICH_LEDGER_PATH: path.join(tempDir, "ledger.json"),
    SERPAPI_API_KEY: "test-key",
    SERPAPI_BASE_URL: stub.baseUrl,
    SERPAPI_MAX_RPM: 6000,
  });
  await migrate(app.db);

  try {
    const created = await createWorkflowFromDefinition(app, EXAMPLE);
    const slug = created.slug;

    // Preview: the paid source cost is visible (1 location -> 1 search @ 1 credit).
    const preview = await previewRun(app, slug, {});
    assert.equal(preview.plan.estimatedCost, 1);
    const sourceAction = preview.plan.estimatedPaidActions.find((a) => a.stepId === "discover");
    assert.equal(sourceAction?.count, 1);
    assert.equal(preview.plan.paidRecordCap, 0, "a Quick List source does not consume the per-record cap");

    // Approve + run to the review gate.
    const run = await startRun(app, slug, preview.approval.token, {});
    assert.equal(run.status, "waiting_review");

    const items = await runResults(app, run.id, {});
    assert.equal(items.length, 4, "the Austin fixture's four listings became four leads");

    // Review, resume past the gate (runs the export step), then read the CSV.
    await reviewRun(app, run.id, { reviewStatus: "approved", itemIds: "all" });
    await resumeRun(app, run.id, {});
    const exported = await exportRunCsv(app, run.id, false);
    const csv = readFileSync(exported.filePath, "utf8");

    // New M3 columns are present and populated from the source record.
    const header = csv.split("\r\n")[0] ?? "";
    for (const col of ["rating", "review_count", "source_url", "timezone"]) {
      assert.ok(header.includes(col), `CSV header includes ${col}`);
    }
    assert.ok(csv.includes("https://www.google.com/maps?cid=1111111111111111111"), "per-listing provenance URL");
    assert.ok(csv.includes("320"), "review count from the fixture");
    assert.equal(exported.rowCount, 4);

    // A second run over the same listings dedupes onto the existing leads.
    const preview2 = await previewRun(app, slug, {});
    await startRun(app, slug, preview2.approval.token, {});
    const leads = await app.db.kysely.selectFrom("leads").selectAll().execute();
    assert.equal(leads.length, 4, "re-sourcing the same businesses did not duplicate leads");
    // place_id populated for the pid: listings; CID retained separately.
    const withPlaceId = leads.filter((l) => l.place_id !== null);
    assert.equal(withPlaceId.length, 2, "the two listings with a Google place_id carry it on the lead");

    const searchCalls = stub.requests.filter((u) => u.pathname === "/search");
    assert.equal(searchCalls.length, 2, "one SerpAPI search per run");
  } finally {
    await app.close();
    await stub.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});
