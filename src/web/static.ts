import { readFile } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Static hosting for the built SPA (`web/dist`). Resolved relative to this
 * module so it works both from `src/web/` under tsx and from `dist/web/`
 * after a build (both are one directory below the project root).
 */
const WEB_DIST = fileURLToPath(new URL("../../web/dist", import.meta.url));

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".map": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

export async function serveStatic(res: ServerResponse, urlPath: string): Promise<void> {
  const relative = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
  const resolved = path.resolve(WEB_DIST, relative);
  // Containment: a traversal attempt must never escape web/dist.
  if (resolved !== WEB_DIST && !resolved.startsWith(WEB_DIST + path.sep)) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
    return;
  }
  const content = await readFile(resolved).catch(() => null);
  if (content === null) {
    if (urlPath === "/") {
      res.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
      res.end("The web UI has not been built yet. Run `pnpm ui:build`, then reload this page.");
      return;
    }
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
    return;
  }
  const type = CONTENT_TYPES[path.extname(resolved).toLowerCase()] ?? "application/octet-stream";
  res.writeHead(200, { "content-type": type });
  res.end(content);
}
