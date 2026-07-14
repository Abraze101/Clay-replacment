import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { exportRunCsv, resumeRun, reviewRun, runResults } from "../src/app/run-service.js";
import { suppress } from "../src/app/suppression-service.js";
import { EXPORT_COLUMNS, renderCsv, type ExportRowData } from "../src/engine/export/csv.js";
import { createDemoWorkflow, createTestApp, previewAndStart } from "./helpers/setup.js";

function emptyRow(overrides: Partial<ExportRowData>): ExportRowData {
  const row = Object.fromEntries(EXPORT_COLUMNS.map((c) => [c, null])) as ExportRowData;
  return { ...row, ...overrides };
}

test("csv: RFC 4180 CRLF records, UTF-8 BOM, and the fixed column whitelist", () => {
  const csv = renderCsv([emptyRow({ business_name: "Austin Roof Pros", score: 90 })]);
  assert.ok(csv.startsWith("﻿"), "BOM present");
  assert.ok(csv.includes("\r\n"), "CRLF record delimiter");
  const header = csv.slice(1).split("\r\n")[0];
  assert.equal(header, EXPORT_COLUMNS.join(","));
});

test("csv: formula neutralization is ON — spreadsheet-executable prefixes are escaped", () => {
  const csv = renderCsv([
    emptyRow({ business_name: "=SUM(A1:A9)", category: "+1234", address: "@import", locality: "-2,2" }),
  ]);
  const dataLine = csv.slice(1).split("\r\n")[1] ?? "";
  assert.ok(dataLine.includes("'=SUM(A1:A9)"), "formulas are neutralized with a leading apostrophe");
  assert.ok(dataLine.includes("'+1234"));
  assert.ok(dataLine.includes("'@import"));
  assert.ok(dataLine.includes("'-2,2"));
});

test("csv: export idempotency — no-op on unchanged dataset, fresh file after a review change, --force overrides", async () => {
  const t = await createTestApp();
  try {
    const slug = await createDemoWorkflow(t.app);
    const { run } = await previewAndStart(t.app, slug, { profile: "quick_list" });
    await reviewRun(t.app, run.id, { reviewStatus: "approved", itemIds: "all" });
    await resumeRun(t.app, run.id, {});

    // The in-run export already materialized; an identical request is a no-op.
    const second = await exportRunCsv(t.app, run.id, false);
    assert.equal(second.noop, true);
    const bytesBefore = readFileSync(second.filePath, "utf8");

    // A review decision AFTER the export changes the dataset checksum: the
    // no-op rule must re-materialize (never serve the stale file).
    const results = await runResults(t.app, run.id, { reviewStatus: "approved" });
    await reviewRun(t.app, run.id, { reviewStatus: "rejected", itemIds: [results[0]!.runItemId] });
    const third = await exportRunCsv(t.app, run.id, false);
    assert.equal(third.noop, false, "a new review decision always produces a fresh file");
    assert.equal(third.rowCount, second.rowCount - 1);
    assert.notEqual(third.datasetChecksum, second.datasetChecksum);
    assert.notEqual(readFileSync(third.filePath, "utf8"), bytesBefore);

    // --force rewrites even when nothing changed.
    const forced = await exportRunCsv(t.app, run.id, true);
    assert.equal(forced.noop, false);
    assert.equal(forced.datasetChecksum, third.datasetChecksum);

    // Request identity: repeated commands reuse one exports row per (run, kind, filters).
    const exportRows = await t.app.db.kysely.selectFrom("exports").selectAll().execute();
    assert.equal(exportRows.length, 1);
    assert.equal(exportRows[0]?.row_count, third.rowCount);
  } finally {
    await t.teardown();
  }
});

test("csv: suppression_status is evaluated LIVE at export — cleared only after a real check, suppressed rows visible on quick lists", async () => {
  const t = await createTestApp();
  try {
    const slug = await createDemoWorkflow(t.app);
    const { run } = await previewAndStart(t.app, slug, { profile: "quick_list" });
    await reviewRun(t.app, run.id, { reviewStatus: "approved", itemIds: "all" });
    await resumeRun(t.app, run.id, {});
    const result = await exportRunCsv(t.app, run.id, false);
    const lines = readFileSync(result.filePath, "utf8").trimEnd().split("\r\n");
    const columns = lines[0]!.replace("﻿", "").split(",");
    const idx = columns.indexOf("suppression_status");
    assert.ok(idx >= 0);
    for (const line of lines.slice(1)) {
      assert.equal(line.split(",")[idx], "cleared", "every identifier was evaluated against the live suppression list");
    }

    // A suppression added AFTER the export breaks the no-op and surfaces on
    // the quick-list row (a discovery list keeps the row, visibly marked; the
    // call-ready selection would exclude it).
    await suppress(t.app, { scope: "phone", value: "(512) 555-0101", reason: "asked to never be contacted" });
    const after = await exportRunCsv(t.app, run.id, false);
    assert.equal(after.noop, false, "a fresh suppression always re-materializes the file");
    const afterLines = readFileSync(after.filePath, "utf8").trimEnd().split("\r\n");
    const suppressedRows = afterLines.slice(1).filter((l) => l.split(",")[idx] === "suppressed");
    assert.equal(suppressedRows.length, 1);
    assert.ok(suppressedRows[0]!.includes("Austin Roof Pros"));
  } finally {
    await t.teardown();
  }
});
