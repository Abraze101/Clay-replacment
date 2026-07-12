#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createContainer } from "../app/container.js";
import { migrate } from "../storage/migrate.js";
import { buildMcpServer } from "./server.js";

/**
 * Local stdio entry (`pnpm mcp:stdio`) for Claude Code, Codex, and OpenAI
 * Agents SDK clients. stdout belongs to the protocol — all logging goes to
 * stderr. Migrations are applied idempotently at startup so a fresh harness
 * connection never needs a separate CLI step.
 */
async function main(): Promise<void> {
  const app = await createContainer({ actor: "mcp:unknown" });
  await migrate(app.db);
  const server = buildMcpServer(app);
  server.server.onclose = () => {
    void app.close().finally(() => {
      process.exit(0);
    });
  };
  await server.connect(new StdioServerTransport());
  process.stderr.write("lead-engine MCP server ready on stdio\n");
}

main().catch((err: unknown) => {
  const detail = err instanceof Error ? (err.stack ?? err.message) : JSON.stringify(err);
  process.stderr.write(`lead-engine MCP stdio server failed: ${detail}\n`);
  process.exit(1);
});
