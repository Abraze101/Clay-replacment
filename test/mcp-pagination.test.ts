import assert from "node:assert/strict";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { buildMcpServer } from "../src/mcp/server.js";
import type { ToolEnvelope } from "../src/mcp/tools.js";
import { createTestApp, demoDefinition } from "./helpers/setup.js";

interface ResultsPage {
  items: { runItemId: string }[];
  page: { offset: number; limit: number; total: number; nextCursor: string | null };
}

function env(result: unknown): ToolEnvelope {
  return (result as { structuredContent: unknown }).structuredContent as ToolEnvelope;
}

test("mcp pagination: run_results pages cover every item exactly once and reject a bad cursor", async () => {
  const t = await createTestApp();
  try {
    const server = buildMcpServer(t.app);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "pagination-test", version: "1.0.0" });
    await client.connect(clientTransport);

    env(await client.callTool({ name: "workflow_create", arguments: { definition: demoDefinition() } }));
    const preview = env(
      await client.callTool({ name: "run_preview", arguments: { workflow: "local-service-demo", profile: "full" } }),
    );
    const token = (preview.data as { approval: { token: string } }).approval.token;
    const started = env(
      await client.callTool({
        name: "run_start",
        arguments: { workflow: "local-service-demo", profile: "full", approval: token },
      }),
    );
    const runId = (started.data as { runId: string }).runId;

    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    let total = -1;
    do {
      const result = env(
        await client.callTool({
          name: "run_results",
          arguments: { runId, limit: 6, ...(cursor !== undefined ? { cursor } : {}) },
        }),
      );
      assert.equal(result.ok, true);
      const page = result.data as ResultsPage;
      if (total === -1) total = page.page.total;
      assert.equal(page.page.total, total, "total is stable across pages");
      assert.equal(page.page.limit, 6);
      seen.push(...page.items.map((i) => i.runItemId));
      cursor = page.page.nextCursor ?? undefined;
      pages += 1;
    } while (cursor !== undefined);

    assert.equal(total, 15, "demo run sources 15 items");
    assert.equal(pages, 3, "15 items at limit 6 → 3 pages");
    assert.equal(seen.length, 15);
    assert.equal(new Set(seen).size, 15, "no item repeats across pages");

    // Default limit is 50: one page, no cursor.
    const single = env(await client.callTool({ name: "run_results", arguments: { runId } }));
    const singlePage = single.data as ResultsPage;
    assert.equal(singlePage.items.length, 15);
    assert.equal(singlePage.page.nextCursor, null);

    const bad = env(await client.callTool({ name: "run_results", arguments: { runId, cursor: "!!not-a-cursor!!" } }));
    assert.equal(bad.ok, false);
    assert.equal(bad.error?.code, "VALIDATION_FAILED");

    await client.close();
  } finally {
    await t.teardown();
  }
});
