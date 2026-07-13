import assert from "node:assert/strict";
import { test } from "node:test";

import { ApolloClient } from "../src/providers/apollo/client.js";
import { AmbiguousOutcomeError, AppError, RateLimitError, RetryableProviderError } from "../src/shared/errors.js";
import { apolloFetchStub, apolloFixture } from "./helpers/apollo-stub.js";

function client(fetchImpl: typeof fetch, overrides: Partial<ConstructorParameters<typeof ApolloClient>[0]> = {}) {
  return new ApolloClient({
    apiKey: "test-master-key-never-logged",
    maxRequestsPerMinute: 100_000, // effectively no client-side throttle in tests
    requestTimeoutMs: 100,
    defaultRetryAfterSeconds: 60,
    fetchImpl,
    ...overrides,
  });
}

const SEARCH = { personTitles: ["CEO"], personLocations: ["Austin, TX"], page: 1, perPage: 100 };
const MATCH = { apolloPersonId: "sanitized-person-0001" };

test("apollo client: search calls api_search with the key in the header only; match always disables reveals", async () => {
  const { fetchImpl, requests } = apolloFetchStub([
    { status: 200, body: apolloFixture("search-page1.json") },
    { status: 200, body: apolloFixture("match-found.json") },
  ]);
  const c = client(fetchImpl);

  const search = await c.searchPeople(SEARCH);
  assert.equal(search.people?.length, 3);
  const searchReq = requests[0]!;
  assert.ok(searchReq.url.endsWith("/api/v1/mixed_people/api_search"), "must use api_search");
  assert.ok(!searchReq.url.includes("/mixed_people/search"), "the legacy search endpoint 403s on Basic plans");
  assert.equal(searchReq.method, "POST");
  assert.equal(searchReq.headers["x-api-key"], "test-master-key-never-logged");
  assert.ok(!searchReq.url.includes("test-master-key"), "key never travels in the URL");
  assert.deepEqual((searchReq.body as { person_titles?: string[] }).person_titles, ["CEO"]);

  await c.matchPerson(MATCH);
  const matchReq = requests[1]!;
  assert.ok(matchReq.url.endsWith("/api/v1/people/match"));
  const body = matchReq.body as Record<string, unknown>;
  assert.equal(body["reveal_personal_emails"], false, "personal-email reveal stays off in M4");
  assert.ok(!("reveal_phone_number" in body), "phone reveal (webhook-only) is never requested");
  assert.equal(body["id"], "sanitized-person-0001");
});

test("apollo client: 429 maps to RateLimitError — header wins, daily-window exhaustion waits at least an hour", async () => {
  const { fetchImpl } = apolloFetchStub([
    { status: 429, body: '{"error":"rate limit exceeded"}', headers: { "retry-after": "17" } },
    { status: 429, body: '{"error":"You have reached your daily request limit"}' },
  ]);
  const c = client(fetchImpl);

  await assert.rejects(
    () => c.searchPeople(SEARCH),
    (err: unknown) => err instanceof RateLimitError && err.retryAfterSeconds === 17,
  );
  await assert.rejects(
    () => c.searchPeople(SEARCH),
    (err: unknown) => err instanceof RateLimitError && err.retryAfterSeconds >= 3600,
  );
});

test("apollo client: key/plan/credit rejections are non-retryable operator errors", async () => {
  for (const status of [401, 402, 403, 422]) {
    const { fetchImpl } = apolloFetchStub([{ status, body: '{"error":"denied"}' }]);
    await assert.rejects(
      () => client(fetchImpl).matchPerson(MATCH),
      (err: unknown) =>
        err instanceof AppError &&
        !(err instanceof RetryableProviderError) &&
        !(err instanceof RateLimitError) &&
        err.code === "PROVIDER_ERROR",
      `status ${status}`,
    );
  }
});

test("apollo client: 5xx is retryable and uncharged on both endpoints", async () => {
  const { fetchImpl } = apolloFetchStub([{ status: 503, body: "upstream sad" }]);
  const c = client(fetchImpl);
  await assert.rejects(
    () => c.searchPeople(SEARCH),
    (err: unknown) => err instanceof RetryableProviderError && err.details["charged"] === false,
  );
  await assert.rejects(
    () => c.matchPerson(MATCH),
    (err: unknown) => err instanceof RetryableProviderError && err.details["charged"] === false,
  );
});

test("apollo client: timeouts diverge by endpoint — free search retries, paid match books an ambiguous outcome", async () => {
  const searchStub = apolloFetchStub([{ hang: true }]);
  await assert.rejects(
    () => client(searchStub.fetchImpl).searchPeople(SEARCH),
    (err: unknown) => err instanceof RetryableProviderError && err.details["charged"] === false,
  );

  const matchStub = apolloFetchStub([{ hang: true }]);
  await assert.rejects(
    () => client(matchStub.fetchImpl).matchPerson(MATCH),
    (err: unknown) => err instanceof AmbiguousOutcomeError && err.possibleCost === 1,
  );
});

test("apollo client: malformed 200s diverge the same way", async () => {
  const searchStub = apolloFetchStub([{ status: 200, body: "<html>not json</html>" }]);
  await assert.rejects(
    () => client(searchStub.fetchImpl).searchPeople(SEARCH),
    (err: unknown) => err instanceof RetryableProviderError && err.details["charged"] === false,
  );

  const matchStub = apolloFetchStub([{ status: 200, body: "<html>not json</html>" }]);
  await assert.rejects(
    () => client(matchStub.fetchImpl).matchPerson(MATCH),
    (err: unknown) => err instanceof AmbiguousOutcomeError && err.possibleCost === 1,
  );
});

test("apollo client: serial min-interval limiter spaces consecutive requests", async () => {
  const { fetchImpl } = apolloFetchStub([
    { status: 200, body: apolloFixture("search-page1.json") },
    { status: 200, body: apolloFixture("search-page1.json") },
  ]);
  // 1200 rpm → one request per 50ms.
  const c = client(fetchImpl, { maxRequestsPerMinute: 1200, requestTimeoutMs: 5000 });
  const startedAt = Date.now();
  await c.searchPeople(SEARCH);
  await c.searchPeople(SEARCH);
  assert.ok(Date.now() - startedAt >= 45, "second request waited for the min interval");
});

test("apollo client: healthCheck is a zero-cost GET and never throws on a healthy key", async () => {
  const { fetchImpl, requests } = apolloFetchStub([{ status: 200, body: '{"is_logged_in":true}' }]);
  const result = await client(fetchImpl).healthCheck();
  assert.deepEqual(result, { ok: true });
  assert.equal(requests[0]?.method, "GET");
  assert.ok(requests[0]?.url.endsWith("/api/v1/auth/health"));

  const bad = apolloFetchStub([{ status: 401, body: '{"error":"invalid key"}' }]);
  await assert.rejects(() => client(bad.fetchImpl).healthCheck(), (err: unknown) => err instanceof AppError);
});
