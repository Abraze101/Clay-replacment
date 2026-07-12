import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import type { AppContainer } from "../app/container.js";
import { createContainer } from "../app/container.js";
import { migrate } from "../storage/migrate.js";
import { buildMcpServer } from "./server.js";

/**
 * Auth-ready Streamable HTTP transport over the SAME buildMcpServer factory
 * as stdio (`pnpm mcp:http`). Binds localhost; MCP_HTTP_TOKEN enables a
 * static bearer check as the placeholder for M6's real authentication.
 * Stateful session mode: each initialize creates a session-scoped server so
 * concurrent clients get independent handshakes over one shared engine.
 */
export interface McpHttpServer {
  port: number;
  close(): Promise<void>;
}

export async function startMcpHttpServer(
  app: AppContainer,
  opts: { port: number; bearerToken?: string; host?: string },
): Promise<McpHttpServer> {
  const sessions = new Map<string, StreamableHTTPServerTransport>();

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (url.pathname !== "/mcp") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not_found" }));
      return;
    }
    if (opts.bearerToken !== undefined && req.headers.authorization !== `Bearer ${opts.bearerToken}`) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    const sessionHeader = req.headers["mcp-session-id"];
    const sessionId = typeof sessionHeader === "string" ? sessionHeader : undefined;
    const existing = sessionId ? sessions.get(sessionId) : undefined;
    if (existing) {
      await existing.handleRequest(req, res);
      return;
    }
    if (req.method !== "POST" || sessionId !== undefined) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Bad Request: unknown session; initialize first" },
          id: null,
        }),
      );
      return;
    }
    // New session: this POST must be an initialize request (the SDK rejects others).
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid) => {
        sessions.set(sid, transport);
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) sessions.delete(transport.sessionId);
    };
    const server = buildMcpServer(app);
    await server.connect(transport);
    await transport.handleRequest(req, res);
  }

  const httpServer = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null }));
    });
  });

  await new Promise<void>((resolve) => {
    httpServer.listen(opts.port, opts.host ?? "127.0.0.1", resolve);
  });
  const address = httpServer.address();
  const port = typeof address === "object" && address !== null ? address.port : opts.port;
  return {
    port,
    close: async () => {
      await Promise.all([...sessions.values()].map((t) => t.close().catch(() => undefined)));
      await new Promise<void>((resolve, reject) => {
        httpServer.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

async function main(): Promise<void> {
  const app = await createContainer({ actor: "mcp:unknown" });
  await migrate(app.db);
  const server = await startMcpHttpServer(app, {
    port: app.env.MCP_HTTP_PORT,
    bearerToken: app.env.MCP_HTTP_TOKEN,
  });
  process.stderr.write(
    `lead-engine MCP server listening on http://127.0.0.1:${server.port}/mcp${app.env.MCP_HTTP_TOKEN ? " (bearer auth enabled)" : " (no auth; local use only)"}\n`,
  );
}

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  main().catch((err: unknown) => {
    process.stderr.write(`lead-engine MCP HTTP server failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
