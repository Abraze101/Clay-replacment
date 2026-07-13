import assert from "node:assert/strict";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { buildMcpServer } from "../src/mcp/server.js";
import type { ToolEnvelope } from "../src/mcp/tools.js";
import type { AppContainer } from "../src/app/container.js";
import { createTestApp, demoDefinition } from "./helpers/setup.js";

/** Connect an SDK client (simulating a named harness) to a fresh server over the same engine. */
async function connectClient(app: AppContainer, clientName: string): Promise<Client> {
  const server = buildMcpServer(app);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: clientName, version: "1.0.0" });
  await client.connect(clientTransport);
  return client;
}

function env(result: unknown): ToolEnvelope {
  const structured = (result as { structuredContent?: unknown }).structuredContent;
  assert.ok(structured, "every tool result carries the structured envelope");
  return structured as ToolEnvelope;
}

test("mcp flow: workflow_create seeds templates by id; importCsv rides the run options", async () => {
  const t = await createTestApp();
  try {
    const client = await connectClient(t.app, "codex-sim");

    // XOR: neither or both of definition/template is a validation error.
    const neither = env(await client.callTool({ name: "workflow_create", arguments: {} }));
    assert.equal(neither.ok, false);
    assert.equal(neither.error?.code, "VALIDATION_FAILED");

    const seeded = env(
      await client.callTool({ name: "workflow_create", arguments: { template: "imported-list-enrich" } }),
    );
    assert.equal(seeded.ok, true);
    assert.equal((seeded.data as { slug: string }).slug, "imported-list-enrich");

    const importCsv = "company,website\nAcme Sample Co,https://acmesample.example\n";
    const preview = env(
      await client.callTool({
        name: "run_preview",
        arguments: { workflow: "imported-list-enrich", importCsv },
      }),
    );
    assert.equal(preview.ok, true);
    const token = (preview.data as { approval: { token: string } }).approval.token;

    // Different CSV content on start = different plan hash = rejected approval.
    const drifted = env(
      await client.callTool({
        name: "run_start",
        arguments: { workflow: "imported-list-enrich", importCsv: importCsv.replace("Acme", "Edited"), approval: token },
      }),
    );
    assert.equal(drifted.ok, false);
    assert.match(drifted.error?.code ?? "", /^APPROVAL_/);

    const started = env(
      await client.callTool({
        name: "run_start",
        arguments: { workflow: "imported-list-enrich", importCsv, approval: token },
      }),
    );
    assert.equal(started.ok, true);
  } finally {
    await t.teardown();
  }
});

test("mcp flow: preview → approve → start → review → resume → results → export, all through the tool contract", async () => {
  const t = await createTestApp();
  try {
    const client = await connectClient(t.app, "claude-code-sim");

    const created = env(await client.callTool({ name: "workflow_create", arguments: { definition: demoDefinition() } }));
    assert.equal(created.ok, true);
    assert.ok(created.requestId);
    assert.deepEqual(created.nextActions, ["run_preview"]);

    const preview = env(
      await client.callTool({ name: "run_preview", arguments: { workflow: "local-service-demo", profile: "full" } }),
    );
    assert.equal(preview.ok, true);
    const previewData = preview.data as { plan: { planHash: string }; approval: { token: string } };
    assert.match(previewData.approval.token, /^apv_/);
    assert.deepEqual(preview.nextActions, ["run_start"]);

    // Engine-level approval: a mutating call without a valid token fails with a machine code.
    const rejected = env(
      await client.callTool({
        name: "run_start",
        arguments: { workflow: "local-service-demo", profile: "full", approval: "apv_forged" },
      }),
    );
    assert.equal(rejected.ok, false);
    assert.equal(rejected.error?.code, "APPROVAL_REQUIRED");
    assert.deepEqual(Object.keys(rejected.error ?? {}).sort(), ["code", "message"], "no stack traces on the wire");

    const started = env(
      await client.callTool({
        name: "run_start",
        arguments: { workflow: "local-service-demo", profile: "full", approval: previewData.approval.token },
      }),
    );
    assert.equal(started.ok, true);
    const startedData = started.data as { runId: string; status: string; creditsUsed: number };
    assert.equal(startedData.status, "waiting_review");
    const runId = startedData.runId;

    // Reusing the consumed token is rejected with its own code.
    const reused = env(
      await client.callTool({
        name: "run_start",
        arguments: { workflow: "local-service-demo", profile: "full", approval: previewData.approval.token },
      }),
    );
    assert.equal(reused.error?.code, "APPROVAL_CONSUMED");

    const reviewed = env(
      await client.callTool({ name: "lead_review_update", arguments: { runId, decision: "approved", all: true } }),
    );
    assert.equal(reviewed.ok, true);

    // Review attribution carries the client name from the initialize handshake.
    const reviewedItems = await t.app.db.kysely
      .selectFrom("run_items")
      .select(["review_actor"])
      .where("run_id", "=", runId)
      .where("review_status", "=", "approved")
      .execute();
    assert.ok(reviewedItems.length > 0);
    assert.ok(
      reviewedItems.every((r) => r.review_actor === "mcp:claude-code-sim"),
      `actor is mcp:<clientName> (got ${reviewedItems[0]?.review_actor ?? "none"})`,
    );

    const resumed = env(await client.callTool({ name: "run_resume", arguments: { runId } }));
    assert.equal(resumed.ok, true);
    assert.equal((resumed.data as { status: string }).status, "completed");

    const exported = env(await client.callTool({ name: "run_export_csv", arguments: { runId } }));
    assert.equal(exported.ok, true);
    assert.ok((exported.data as { filePath: string }).filePath.endsWith(".csv"));

    // Harness switch: a different client reads the same durable run state.
    const other = await connectClient(t.app, "codex-sim");
    const status = env(await other.callTool({ name: "run_status", arguments: { runId } }));
    assert.equal(status.ok, true);
    assert.equal((status.data as { status: string }).status, "completed");

    await client.close();
    await other.close();
  } finally {
    await t.teardown();
  }
});

test("mcp flow: a budget/cap change through run_resume needs a fresh token from run_preview", async () => {
  const t = await createTestApp();
  try {
    const client = await connectClient(t.app, "claude-code-sim");
    env(await client.callTool({ name: "workflow_create", arguments: { definition: demoDefinition() } }));

    const preview = env(
      await client.callTool({
        name: "run_preview",
        arguments: { workflow: "local-service-demo", profile: "full", budget: 3 },
      }),
    );
    const previewData = preview.data as { approval: { token: string } };
    const started = env(
      await client.callTool({
        name: "run_start",
        arguments: { workflow: "local-service-demo", profile: "full", budget: 3, approval: previewData.approval.token },
      }),
    );
    const runId = (started.data as { runId: string }).runId;
    assert.equal((started.data as { status: string }).status, "paused");

    const noToken = env(await client.callTool({ name: "run_resume", arguments: { runId, budget: 20 } }));
    assert.equal(noToken.error?.code, "APPROVAL_REQUIRED");
    assert.deepEqual(noToken.nextActions, ["run_preview"], "the error tells the harness how to recover");

    const reapproval = env(
      await client.callTool({
        name: "run_preview",
        arguments: { workflow: "local-service-demo", profile: "full", budget: 20 },
      }),
    );
    const reapprovalData = reapproval.data as { approval: { token: string } };
    const resumed = env(
      await client.callTool({
        name: "run_resume",
        arguments: { runId, budget: 20, approval: reapprovalData.approval.token },
      }),
    );
    assert.equal(resumed.ok, true);
    assert.equal((resumed.data as { status: string }).status, "waiting_review");

    await client.close();
  } finally {
    await t.teardown();
  }
});
