import assert from "node:assert/strict";

import type { RunStatusSummary } from "../../src/app/run-service.js";
import { startWebServer } from "../../src/web/server.js";
import type { TestApp } from "./setup.js";

/**
 * Offline web-API harness: the real HTTP server on port 0 over the in-memory
 * test container. Every response is asserted against the envelope shape.
 */
export interface WebEnvelope<T = unknown> {
  ok: boolean;
  data?: T;
  warnings?: string[];
  requestId?: string;
  error?: { code: string; message: string; details?: Record<string, unknown> };
}

export interface WebResponse<T = unknown> {
  status: number;
  body: WebEnvelope<T>;
}

export interface TestWebServer {
  baseUrl: string;
  getJson<T = unknown>(path: string): Promise<WebResponse<T>>;
  postJson<T = unknown>(path: string, body?: unknown): Promise<WebResponse<T>>;
  close(): Promise<void>;
}

function assertEnvelope(body: WebEnvelope, status: number): void {
  assert.equal(typeof body.ok, "boolean", "envelope has ok");
  assert.equal(typeof body.requestId, "string", "envelope has requestId");
  if (body.ok) {
    assert.ok(Array.isArray(body.warnings), "success envelope has warnings[]");
    assert.ok(status < 400, `ok envelope must not ride an error status (${status})`);
  } else {
    assert.ok(body.error, "failure envelope has error");
    assert.equal(typeof body.error.code, "string");
    assert.ok(status >= 400, `error envelope must ride an error status (${status})`);
  }
}

export async function startTestWebServer(t: TestApp): Promise<TestWebServer> {
  const server = await startWebServer(t.app, { port: 0 });
  const baseUrl = `http://127.0.0.1:${server.port}`;

  async function parse<T>(response: Response): Promise<WebResponse<T>> {
    const body = (await response.json()) as WebEnvelope<T>;
    assertEnvelope(body, response.status);
    return { status: response.status, body };
  }

  return {
    baseUrl,
    getJson: async <T>(path: string) => await parse<T>(await fetch(baseUrl + path)),
    postJson: async <T>(path: string, body: unknown = {}) =>
      await parse<T>(
        await fetch(baseUrl + path, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      ),
    close: () => server.close(),
  };
}

/** Poll run status over HTTP until the predicate holds (fails after timeoutMs). */
export async function pollRunStatus(
  web: TestWebServer,
  runId: string,
  until: (status: RunStatusSummary) => boolean,
  timeoutMs = 20_000,
): Promise<RunStatusSummary> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await web.getJson<RunStatusSummary>(`/api/runs/${runId}/status`);
    assert.equal(res.status, 200);
    const status = res.body.data;
    assert.ok(status, "status data present");
    if (until(status)) return status;
    if (Date.now() > deadline) {
      assert.fail(`run ${runId} did not reach the expected state in ${timeoutMs}ms (currently ${status.status})`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
