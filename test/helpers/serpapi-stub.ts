import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";

export interface StubResponse {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

/** A `fetch` replacement that maps each request URL to a canned response. */
export function stubFetch(handler: (url: URL) => StubResponse): typeof fetch {
  return (input) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const r = handler(new URL(raw));
    const body = typeof r.body === "string" ? r.body : JSON.stringify(r.body);
    return Promise.resolve(
      new Response(body, { status: r.status, headers: { "content-type": "application/json", ...(r.headers ?? {}) } }),
    );
  };
}

/** A `fetch` that aborts when its signal fires (drives the client timeout path). */
export function abortingFetch(): typeof fetch {
  return (_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (signal?.aborted) reject(new DOMException("Aborted", "AbortError"));
      signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    });
}

/** A `fetch` that fails to connect (network error before any response). */
export function networkErrorFetch(): typeof fetch {
  return () => Promise.reject(new TypeError("fetch failed"));
}

export function loadSerpApiFixture(name: string): unknown {
  return JSON.parse(readFileSync(path.resolve("test/fixtures/serpapi", name), "utf8"));
}

export interface SerpApiStubServer {
  baseUrl: string;
  requests: URL[];
  close(): Promise<void>;
}

/**
 * A real localhost HTTP server that replays fixtures, so the e2e exercises the
 * actual client path (headers, envelope parsing) offline. `route` maps the
 * request URL to a response; defaults to the account fixture for /account and
 * the Austin fixture for /search.
 */
export async function startSerpApiStubServer(route?: (url: URL) => StubResponse): Promise<SerpApiStubServer> {
  const requests: URL[] = [];
  const resolve = route ?? defaultRoute;
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    requests.push(url);
    const r = resolve(url);
    const body = typeof r.body === "string" ? r.body : JSON.stringify(r.body);
    res.writeHead(r.status, { "content-type": "application/json", ...(r.headers ?? {}) });
    res.end(body);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

function defaultRoute(url: URL): StubResponse {
  if (url.pathname === "/account") return { status: 200, body: loadSerpApiFixture("account.json") };
  return { status: 200, body: loadSerpApiFixture("maps-austin-p0.json") };
}
