import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { exportRunCsv, resumeRun, reviewRun } from "../src/app/run-service.js";
import { suppress } from "../src/app/suppression-service.js";
import { createWorkflowFromDefinition } from "../src/app/workflow-service.js";
import { listRunItems } from "../src/storage/repositories/run-repo.js";
import { createTestApp, previewAndStart } from "./helpers/setup.js";

function callReadyWorkflow(): Record<string, unknown> {
  return {
    id: "call-ready-export-test",
    version: 1,
    name: "Call-ready export test",
    inputs: { businessType: "roofing contractor", locations: ["Austin, TX"], limit: 3, enrichmentProfile: "call_ready" },
    steps: [
      { id: "discover", type: "source", provider: "fake-places" },
      { id: "normalize", type: "normalize" },
      { id: "dedupe", type: "dedupe" },
      { id: "find-phones", type: "enrich", capability: "phone_discovery", profiles: ["call_ready", "full"] },
      { id: "validate-phones", type: "enrich", capability: "phone_validation", profiles: ["call_ready", "full"] },
      { id: "review", type: "review_gate" },
      { id: "export", type: "export", format: "csv" },
    ],
  };
}

function parseCsv(filePath: string): { columns: string[]; rows: Map<string, Record<string, string>> } {
  const lines = readFileSync(filePath, "utf8").trimEnd().split("\r\n");
  const columns = lines[0]!.replace("﻿", "").split(",");
  const rows = new Map<string, Record<string, string>>();
  for (const line of lines.slice(1)) {
    const cells = line.split(",");
    const row = Object.fromEntries(columns.map((c, i) => [c, cells[i] ?? ""]));
    rows.set(row["business_name"] ?? "", row);
  }
  return { columns, rows };
}

test("call-ready export: per-role groups with honest validation levels; invalid and suppressed rows excluded but retained", async () => {
  const t = await createTestApp();
  try {
    const created = await createWorkflowFromDefinition(t.app, callReadyWorkflow());
    // requireDirectPhone: fx-001/fx-003 get validated directs; fx-002 (no
    // domain, main line unacceptable) becomes call-readiness 'invalid'.
    const { run } = await previewAndStart(t.app, created.slug, {
      profile: "call_ready",
      overrides: { requireDirectPhone: true },
    });
    assert.equal(run.status, "waiting_review");
    await reviewRun(t.app, run.id, { reviewStatus: "approved", itemIds: "all" });
    const finished = await resumeRun(t.app, run.id, {});
    assert.equal(finished.status, "completed");

    const result = await exportRunCsv(t.app, run.id, false);
    const { columns, rows } = parseCsv(result.filePath);

    // Per-role column groups exist and are never conflated.
    for (const role of ["business_main", "direct", "mobile"]) {
      for (const suffix of ["line_type", "validation_level", "validation_result", "last_checked_at"]) {
        assert.ok(columns.includes(`${role}_${suffix}`), `${role}_${suffix} column present`);
      }
    }

    // fx-002 is call-readiness invalid: EXCLUDED from the export, retained in DB.
    assert.equal(result.rowCount, 2, "the invalid row is not exported");
    assert.ok(!rows.has("Hill Country Roofing"));
    const items = await listRunItems(t.app.db.kysely, run.id);
    const excluded = items.find((i) => i.position === 2);
    assert.equal(excluded?.status, "completed", "excluded from the CSV, not from the database");
    assert.equal(excluded?.call_readiness_status, "invalid");

    // fx-001: validated direct (status-checked mobile line) + untouched main.
    // (E.164 cells carry the formula-neutralizing apostrophe: '+... — the
    // CSV-injection defense treats a leading '+' as spreadsheet-executable.)
    const first = rows.get("Austin Roof Pros");
    assert.ok(first);
    assert.equal(first["direct_phone_e164"], "'+15125550161");
    assert.equal(first["direct_line_type"], "mobile");
    assert.equal(first["direct_validation_level"], "line_status");
    assert.equal(first["direct_validation_result"], "active");
    assert.ok(first["direct_last_checked_at"]);
    assert.equal(first["business_main_validation_level"], "format", "the unvalidated main is honestly format-only");
    assert.equal(first["business_main_validation_result"], "valid");
    assert.equal(first["call_readiness_status"], "ready");
    assert.equal(first["suppression_status"], "cleared");

    // ── Suppressing the validated direct AFTER the run breaks the no-op and
    // drops the row from the callable export (live evaluation, never stored).
    const noop = await exportRunCsv(t.app, run.id, false);
    assert.equal(noop.noop, true);
    await suppress(t.app, { scope: "phone", value: "+15125550161", reason: "operator do-not-call" });
    const after = await exportRunCsv(t.app, run.id, false);
    assert.equal(after.noop, false, "a post-run suppression re-materializes the export");
    const reduced = parseCsv(after.filePath);
    assert.ok(!reduced.rows.has("Austin Roof Pros"), "the row whose only callable number is suppressed drops out");
    assert.ok(reduced.rows.has("ATX Plumbing Co"), "unaffected rows remain");
  } finally {
    await t.teardown();
  }
});
