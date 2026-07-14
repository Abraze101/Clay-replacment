import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * The end-to-end proof that no state lives in a conversation or a process:
 * every CLI command below runs in its OWN subprocess against the same on-disk
 * PGlite database. migrate → create → preview → start → (process exits) →
 * status → review → results → resume → export.
 */
test("e2e: the full CLI flow survives process exits between every command", { timeout: 420_000 }, async () => {
  const workDir = mkdtempSync(path.join(tmpdir(), "lead-engine-e2e-"));
  const projectRoot = path.resolve();
  const tsx = path.join(projectRoot, "node_modules", ".bin", "tsx");
  const cliEntry = path.join(projectRoot, "src", "cli", "index.ts");
  const env = {
    ...process.env,
    DATABASE_URL: `pglite://${path.join(workDir, "db")}`,
    EXPORT_DIR: path.join(workDir, "exports"),
    FAKE_ENRICH_LEDGER_PATH: path.join(workDir, "ledger.json"),
  };

  async function cli(...args: string[]): Promise<{ stdout: string }> {
    return await execFileAsync(tsx, [cliEntry, "--json", ...args], { env, cwd: projectRoot });
  }
  function parse<T>(stdout: string): { ok: boolean; data: T; summary: string } {
    return JSON.parse(stdout) as { ok: boolean; data: T; summary: string };
  }

  try {
    await cli("db", "migrate");
    await cli("workflow", "create", "--file", path.join(projectRoot, "examples", "local-service-demo.workflow.json"));

    const preview = parse<{ plan: { planHash: string }; approval: { token: string } }>(
      (await cli("run", "preview", "local-service-demo", "--profile", "full")).stdout,
    );
    assert.ok(preview.ok);
    const approvalToken = preview.data.approval.token;

    const started = parse<{ runId: string; status: string; creditsUsed: number }>(
      (await cli("run", "start", "local-service-demo", "--profile", "full", "--approval", approvalToken)).stdout,
    );
    assert.equal(started.data.status, "waiting_review");
    const runId = started.data.runId;

    // New process: the durable state is all there.
    const status = parse<{ status: string; counts: { items: number }; creditsUsed: number }>(
      (await cli("run", "status", runId)).stdout,
    );
    assert.equal(status.data.status, "waiting_review");
    assert.equal(status.data.counts.items, 15);
    assert.equal(status.data.creditsUsed, 32);

    const reviewed = parse<{ updated: number }>((await cli("run", "review", runId, "--approve", "--all")).stdout);
    assert.equal(reviewed.data.updated, 11);

    const results = parse<{ runItemId: string }[]>((await cli("run", "results", runId)).stdout);
    assert.equal(results.data.length, 15);

    const resumed = parse<{ status: string }>((await cli("run", "resume", runId)).stdout);
    assert.equal(resumed.data.status, "completed");

    const exported = parse<{ filePath: string; rowCount: number; noop: boolean }>(
      (await cli("export", "csv", runId)).stdout,
    );
    // fx-015's only phone is format-invalid: excluded from the call-ready selection.
    assert.equal(exported.data.rowCount, 8);
    assert.ok(existsSync(exported.data.filePath));
    const lines = readFileSync(exported.data.filePath, "utf8").trimEnd().split("\r\n");
    assert.equal(lines.length, 9);

    // A scope change is rejected by a fresh process too (the full-profile
    // token cannot start call_ready, even before its consumption is checked).
    await assert.rejects(
      () => cli("run", "start", "local-service-demo", "--profile", "call_ready", "--approval", approvalToken),
      (err: { stdout?: string }) => {
        const envelope = JSON.parse(err.stdout ?? "{}") as { ok?: boolean; error?: { code?: string } };
        return envelope.ok === false && envelope.error?.code === "APPROVAL_MISMATCH";
      },
    );

    // Reusing the consumed token for its own scope is rejected as consumed.
    await assert.rejects(
      () => cli("run", "start", "local-service-demo", "--profile", "full", "--approval", approvalToken),
      (err: { stdout?: string }) => {
        const envelope = JSON.parse(err.stdout ?? "{}") as { ok?: boolean; error?: { code?: string } };
        return envelope.ok === false && envelope.error?.code === "APPROVAL_CONSUMED";
      },
    );
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("e2e: the imported-list template runs from the CLI with --template and --import-csv", { timeout: 240_000 }, async () => {
  const workDir = mkdtempSync(path.join(tmpdir(), "lead-engine-e2e-import-"));
  const projectRoot = path.resolve();
  const tsx = path.join(projectRoot, "node_modules", ".bin", "tsx");
  const cliEntry = path.join(projectRoot, "src", "cli", "index.ts");
  const env = {
    ...process.env,
    DATABASE_URL: `pglite://${path.join(workDir, "db")}`,
    EXPORT_DIR: path.join(workDir, "exports"),
    FAKE_ENRICH_LEDGER_PATH: path.join(workDir, "ledger.json"),
  };

  async function cli(...args: string[]): Promise<{ stdout: string }> {
    return await execFileAsync(tsx, [cliEntry, "--json", ...args], { env, cwd: projectRoot });
  }
  function parse<T>(stdout: string): { ok: boolean; data: T; summary: string } {
    return JSON.parse(stdout) as { ok: boolean; data: T; summary: string };
  }

  try {
    await cli("db", "migrate");
    const created = parse<{ slug: string }>(
      (await cli("workflow", "create", "--template", "imported-list-enrich")).stdout,
    );
    assert.equal(created.data.slug, "imported-list-enrich");

    const csvPath = path.join(projectRoot, "test", "fixtures", "imported", "contacts-clean.csv");
    const preview = parse<{ plan: { estimatedCost: number }; approval: { token: string } }>(
      (await cli("run", "preview", "imported-list-enrich", "--import-csv", csvPath)).stdout,
    );
    assert.ok(preview.ok);
    assert.equal(preview.data.plan.estimatedCost, 0, "a quick_list import spends nothing");

    const started = parse<{ runId: string; status: string }>(
      (
        await cli(
          "run",
          "start",
          "imported-list-enrich",
          "--import-csv",
          csvPath,
          "--approval",
          preview.data.approval.token,
        )
      ).stdout,
    );
    assert.equal(started.data.status, "waiting_review");
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});
