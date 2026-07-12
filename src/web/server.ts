import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { AppContainer } from "../app/container.js";
import { createContainer } from "../app/container.js";
import { migrate } from "../storage/migrate.js";
import { handleApi } from "./routes.js";
import { serveStatic } from "./static.js";

/**
 * The M2 web UI server (`pnpm web`): raw node:http, same composition as the
 * MCP HTTP transport — one long-lived process co-hosting the engine, because
 * PGlite is single-connection and the in-process worker executes runs here.
 * Binds localhost only; real authentication arrives at Milestone 6.
 */
export interface WebServer {
  port: number;
  close(): Promise<void>;
}

export async function startWebServer(
  app: AppContainer,
  opts: { port: number; host?: string },
): Promise<WebServer> {
  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      await handleApi(app, req, res, url);
      return;
    }
    if (req.method === "GET" || req.method === "HEAD") {
      await serveStatic(res, url.pathname);
      return;
    }
    res.writeHead(405, { "content-type": "text/plain; charset=utf-8" });
    res.end("Method not allowed");
  }

  const httpServer = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: { code: "INTERNAL", message: "Internal server error." } }));
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
      await new Promise<void>((resolve, reject) => {
        httpServer.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

async function main(): Promise<void> {
  const app = await createContainer({ actor: "web" });
  await migrate(app.db);
  const server = await startWebServer(app, { port: app.env.WEB_PORT });
  process.stderr.write(
    `lead-engine web UI listening on http://127.0.0.1:${server.port} (localhost only; auth arrives at M6)\n`,
  );
}

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  main().catch((err: unknown) => {
    process.stderr.write(`lead-engine web server failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
