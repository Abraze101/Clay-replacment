import { readFileSync } from "node:fs";
import path from "node:path";

/** One scripted HTTP exchange for the Apollo client's fetchImpl. */
export interface ApolloStubResponse {
  status: number;
  body: string;
  headers?: Record<string, string>;
}

export interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

export function apolloFixture(name: string): string {
  return readFileSync(path.resolve("test/fixtures/apollo", name), "utf8");
}

/**
 * Scripted fetch stub: responses are consumed in order (the last one repeats),
 * every request is recorded for header/body/URL assertions. `hang: true`
 * entries never resolve until the client's own timeout aborts them — the
 * timeout-mapping tests rely on that.
 */
export function apolloFetchStub(script: (ApolloStubResponse | { hang: true })[]): {
  fetchImpl: typeof fetch;
  requests: RecordedRequest[];
} {
  const requests: RecordedRequest[] = [];
  let index = 0;
  const fetchImpl = ((input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(init?.headers ?? {})) headers[k.toLowerCase()] = String(v);
    requests.push({
      url,
      method: init?.method ?? "GET",
      headers,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
    });
    const step = script[Math.min(index, script.length - 1)];
    index += 1;
    if (step && "hang" in step) {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const err = new Error("This operation was aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    }
    const res = step ?? { status: 200, body: "{}" };
    return Promise.resolve(
      new Response(res.body, {
        status: res.status,
        headers: { "content-type": "application/json", ...(res.headers ?? {}) },
      }),
    );
  }) as typeof fetch;
  return { fetchImpl, requests };
}
