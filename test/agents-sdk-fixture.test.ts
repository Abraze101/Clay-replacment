import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { MCPServerStdio } from "@openai/agents";

/**
 * Credential-free OpenAI Agents SDK fixture: the third harness family listed
 * in docs/harness-compatibility.md connects to our stdio server exactly the
 * way `MCPServerStdio` would inside an agent, without any OpenAI API key and
 * without a model. This proves harness compatibility at the transport/tool
 * layer, which is all M1 requires.
 */
test("agents sdk: MCPServerStdio connects, lists the 12 tools, and calls a read-only tool without any API key", { timeout: 120_000 }, async () => {
  const workDir = mkdtempSync(path.join(tmpdir(), "agents-fixture-"));
  const projectRoot = path.resolve();
  const server = new MCPServerStdio({
    name: "lead-engine-fixture",
    command: path.join(projectRoot, "node_modules", ".bin", "tsx"),
    args: [path.join(projectRoot, "src", "mcp", "stdio.ts")],
    cwd: projectRoot,
    env: {
      ...(Object.fromEntries(
        Object.entries(process.env).filter(([, v]) => v !== undefined),
      ) as Record<string, string>),
      DATABASE_URL: `pglite://${path.join(workDir, "db")}`,
      EXPORT_DIR: path.join(workDir, "exports"),
      FAKE_ENRICH_LEDGER_PATH: path.join(workDir, "ledger.json"),
      OPENAI_API_KEY: "",
      // Keep the fixture deterministic and fast: skip the pg-boss boot the
      // stdio entry now defaults to (driver choice is irrelevant here).
      JOB_DRIVER: "inprocess",
    },
    cacheToolsList: true,
    // tsx + PGlite subprocess boot can exceed the 5s default when the whole
    // suite runs concurrently.
    clientSessionTimeoutSeconds: 120,
  });
  try {
    await server.connect();

    const tools = await server.listTools();
    const names = tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, [
      "lead_review_update",
      "run_cancel",
      "run_export_csv",
      "run_preview",
      "run_results",
      "run_resume",
      "run_retry",
      "run_start",
      "run_status",
      "workflow_create",
      "workflow_list",
      "workflow_validate",
    ]);

    // A read-only call through the Agents SDK wrapper returns our envelope text.
    const content = await server.callTool("workflow_list", {});
    const text = JSON.stringify(content);
    assert.ok(text.includes("workflow(s)"), `workflow_list summary reached the Agents SDK (got: ${text.slice(0, 200)})`);
  } finally {
    await server.close().catch(() => undefined);
    rmSync(workDir, { recursive: true, force: true });
  }
});
