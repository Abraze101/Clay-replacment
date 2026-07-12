import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { startMcpHttpServer } from "../src/mcp/http.js";
import { SERVER_INSTRUCTIONS } from "../src/mcp/instructions.js";
import { createTestApp } from "./helpers/setup.js";

const EXPECTED_TOOLS = [
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
];

const projectRoot = path.resolve();

function stdioTransport(workDir: string): StdioClientTransport {
  return new StdioClientTransport({
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
    },
  });
}

test("mcp contract: stdio and Streamable HTTP expose identical tools, schemas, annotations, and instructions", { timeout: 120_000 }, async () => {
  const workDir = mkdtempSync(path.join(tmpdir(), "mcp-contract-"));
  const t = await createTestApp();
  let httpServer: Awaited<ReturnType<typeof startMcpHttpServer>> | undefined;
  const stdioClient = new Client({ name: "contract-stdio", version: "0.0.1" });
  const httpClient = new Client({ name: "contract-http", version: "0.0.1" });
  try {
    // Real subprocess over stdio — this also proves the `pnpm mcp:stdio` command works.
    await stdioClient.connect(stdioTransport(workDir));

    // Same factory over Streamable HTTP, in-process on an ephemeral port.
    httpServer = await startMcpHttpServer(t.app, { port: 0 });
    await httpClient.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${httpServer.port}/mcp`)));

    const stdioTools = (await stdioClient.listTools()).tools.sort((a, b) => a.name.localeCompare(b.name));
    const httpTools = (await httpClient.listTools()).tools.sort((a, b) => a.name.localeCompare(b.name));

    assert.deepEqual(
      stdioTools.map((tool) => tool.name),
      EXPECTED_TOOLS,
      "the 12-tool contract over stdio",
    );
    // Transport equivalence: names, titles, descriptions, schemas, and annotations all match.
    assert.deepEqual(JSON.parse(JSON.stringify(httpTools)), JSON.parse(JSON.stringify(stdioTools)));

    // Annotations: read-only tools are marked; cancel is destructive.
    const byName = new Map(stdioTools.map((tool) => [tool.name, tool]));
    for (const name of ["workflow_list", "run_status", "run_results"]) {
      assert.equal(byName.get(name)?.annotations?.readOnlyHint, true, `${name} is read-only`);
    }
    assert.equal(byName.get("run_cancel")?.annotations?.destructiveHint, true);
    for (const name of ["run_start", "run_resume"]) {
      assert.equal(byName.get(name)?.annotations?.readOnlyHint, false, `${name} mutates state`);
    }

    // Instructions are identical on both transports, and the essential rules
    // sit inside the first 512 characters (Codex reads a prefix).
    assert.equal(stdioClient.getInstructions(), SERVER_INSTRUCTIONS);
    assert.equal(httpClient.getInstructions(), SERVER_INSTRUCTIONS);
    const prefix = SERVER_INSTRUCTIONS.slice(0, 512);
    for (const phrase of ["run_preview", "approval token", "run_start", "APPROVAL_", "No outbound actions"]) {
      assert.ok(prefix.includes(phrase), `first 512 chars contain '${phrase}'`);
    }
  } finally {
    await stdioClient.close().catch(() => undefined);
    await httpClient.close().catch(() => undefined);
    await httpServer?.close().catch(() => undefined);
    await t.teardown();
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("mcp contract: the HTTP transport enforces the bearer token when configured", { timeout: 60_000 }, async () => {
  const t = await createTestApp();
  let httpServer: Awaited<ReturnType<typeof startMcpHttpServer>> | undefined;
  const authedClient = new Client({ name: "contract-auth", version: "0.0.1" });
  try {
    httpServer = await startMcpHttpServer(t.app, { port: 0, bearerToken: "test-secret" });
    const url = `http://127.0.0.1:${httpServer.port}/mcp`;

    const unauthorized = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "initialize", params: {}, id: 1 }),
    });
    assert.equal(unauthorized.status, 401, "missing bearer is rejected before any MCP handling");

    await authedClient.connect(
      new StreamableHTTPClientTransport(new URL(url), {
        requestInit: { headers: { authorization: "Bearer test-secret" } },
      }),
    );
    const tools = await authedClient.listTools();
    assert.equal(tools.tools.length, EXPECTED_TOOLS.length);
  } finally {
    await authedClient.close().catch(() => undefined);
    await httpServer?.close().catch(() => undefined);
    await t.teardown();
  }
});
