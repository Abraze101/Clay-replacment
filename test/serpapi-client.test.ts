import assert from "node:assert/strict";
import { test } from "node:test";

import { SerpApiClient, type SerpApiClientOptions } from "../src/providers/serpapi/client.js";
import { AmbiguousOutcomeError, AppError, RateLimitError, RetryableProviderError } from "../src/shared/errors.js";
import { abortingFetch, loadSerpApiFixture, networkErrorFetch, stubFetch } from "./helpers/serpapi-stub.js";

function client(fetchImpl: typeof fetch, extra: Partial<SerpApiClientOptions> = {}) {
  return new SerpApiClient({
    apiKey: "test-key",
    baseUrl: "https://serpapi.test",
    maxRequestsPerMinute: 6000,
    defaultRetryAfterSeconds: 42,
    fetchImpl,
    ...extra,
  });
}

test("serpapi client: builds the Google Maps request URL and parses local_results", async () => {
  let captured: URL | undefined;
  const c = client(
    stubFetch((url) => {
      captured = url;
      return { status: 200, body: loadSerpApiFixture("maps-austin-p0.json") };
    }),
  );
  const res = await c.searchMaps({ q: "roofing Austin", ll: "@30.2,-97.7,12z", start: 20 });

  assert.equal(captured?.pathname, "/search");
  assert.equal(captured?.searchParams.get("engine"), "google_maps");
  assert.equal(captured?.searchParams.get("type"), "search");
  assert.equal(captured?.searchParams.get("q"), "roofing Austin");
  assert.equal(captured?.searchParams.get("ll"), "@30.2,-97.7,12z");
  assert.equal(captured?.searchParams.get("start"), "20");
  assert.equal(captured?.searchParams.get("api_key"), "test-key");
  assert.equal(res.local_results?.length, 4);
});

test("serpapi client: an empty 200 (charged success) returns without throwing", async () => {
  const c = client(stubFetch(() => ({ status: 200, body: loadSerpApiFixture("maps-empty.json") })));
  const res = await c.searchMaps({ q: "no results" });
  assert.equal(res.local_results, undefined);
  assert.ok(res.error);
});

test("serpapi client: a malformed 200 is an unconfirmable outcome", async () => {
  const c = client(stubFetch(() => ({ status: 200, body: loadSerpApiFixture("maps-malformed.json") })));
  await assert.rejects(() => c.searchMaps({ q: "x" }), (err: unknown) => err instanceof AmbiguousOutcomeError);
});

test("serpapi client: 429 throughput maps to RateLimitError (Retry-After honored, else default)", async () => {
  const withHeader = client(
    stubFetch(() => ({ status: 429, body: loadSerpApiFixture("error-429.json"), headers: { "retry-after": "90" } })),
  );
  await assert.rejects(
    () => withHeader.searchMaps({ q: "x" }),
    (err: unknown) => err instanceof RateLimitError && err.retryAfterSeconds === 90,
  );

  const noHeader = client(stubFetch(() => ({ status: 429, body: loadSerpApiFixture("error-429.json") })));
  await assert.rejects(
    () => noHeader.searchMaps({ q: "x" }),
    (err: unknown) => err instanceof RateLimitError && err.retryAfterSeconds === 42,
  );
});

test("serpapi client: 429 out-of-searches is a non-retryable provider error", async () => {
  const c = client(stubFetch(() => ({ status: 429, body: loadSerpApiFixture("error-quota.json") })));
  await assert.rejects(
    () => c.searchMaps({ q: "x" }),
    (err: unknown) => err instanceof AppError && !(err instanceof RateLimitError) && err.code === "PROVIDER_ERROR",
  );
});

test("serpapi client: 4xx config errors are non-retryable; 5xx is retryable and uncharged", async () => {
  for (const status of [400, 401, 402, 403]) {
    const c = client(stubFetch(() => ({ status, body: { error: "nope" } })));
    await assert.rejects(
      () => c.searchMaps({ q: "x" }),
      (err: unknown) => err instanceof AppError && !(err instanceof RetryableProviderError) && err.code === "PROVIDER_ERROR",
      `status ${status} should be non-retryable`,
    );
  }
  const c = client(stubFetch(() => ({ status: 503, body: { error: "unavailable" } })));
  await assert.rejects(
    () => c.searchMaps({ q: "x" }),
    (err: unknown) => err instanceof RetryableProviderError && err.details["charged"] === false,
  );
});

test("serpapi client: a timeout is unconfirmable; a network error is retryable and uncharged", async () => {
  const timeoutClient = client(abortingFetch(), { requestTimeoutMs: 20 });
  await assert.rejects(() => timeoutClient.searchMaps({ q: "x" }), (err: unknown) => err instanceof AmbiguousOutcomeError);

  const netClient = client(networkErrorFetch());
  await assert.rejects(
    () => netClient.searchMaps({ q: "x" }),
    (err: unknown) => err instanceof RetryableProviderError && err.details["charged"] === false,
  );
});

test("serpapi client: the throttle spaces sequential requests by the min interval", async () => {
  // 600/min -> 100ms min interval; 3 sequential calls -> >= ~2 gaps.
  const c = client(stubFetch(() => ({ status: 200, body: loadSerpApiFixture("maps-empty.json") })), {
    maxRequestsPerMinute: 600,
  });
  const start = Date.now();
  await c.searchMaps({ q: "1" });
  await c.searchMaps({ q: "2" });
  await c.searchMaps({ q: "3" });
  assert.ok(Date.now() - start >= 150, "two ~100ms gaps between three calls");
});

test("serpapi client: creditUsage reads the remaining search balance", async () => {
  const c = client(stubFetch(() => ({ status: 200, body: loadSerpApiFixture("account.json") })));
  const usage = await c.creditUsage();
  assert.equal(usage.totalSearchesLeft, 240);
});
