import assert from "node:assert/strict";
import { test } from "node:test";

import { ApolloClient } from "../src/providers/apollo/client.js";
import { ApolloEnrichProvider } from "../src/providers/apollo/enrich.js";
import { ApolloPeopleSource } from "../src/providers/apollo/people-source.js";
import { apolloFetchStub, apolloFixture } from "./helpers/apollo-stub.js";

function makeClient(fetchImpl: typeof fetch) {
  return new ApolloClient({
    apiKey: "test-master-key",
    maxRequestsPerMinute: 100_000,
    requestTimeoutMs: 1000,
    fetchImpl,
  });
}

test("apollo people-source: page math, deterministic descriptors, zero-cost estimate", () => {
  const source = new ApolloPeopleSource({ client: makeClient(fetch), maxPagesPerQuery: 5 });

  const q = (limit: number) => ({ personTitles: ["CEO", "Founder"], locations: ["Austin, TX"], limit });
  assert.equal(source.planSearchRequests(q(25)).length, 1);
  assert.equal(source.planSearchRequests(q(250)).length, 3);
  assert.equal(source.planSearchRequests(q(500)).length, 5);

  const specs = source.planSearchRequests(q(250));
  assert.deepEqual(
    specs.map((s) => s.descriptor),
    [
      "apollo:people:(none):CEO|Founder:Austin, TX:p1",
      "apollo:people:(none):CEO|Founder:Austin, TX:p2",
      "apollo:people:(none):CEO|Founder:Austin, TX:p3",
    ],
  );
  assert.ok(specs.every((s) => s.estimatedCost === 0));
  assert.deepEqual(source.estimateSearchCost(q(500)), { requests: 5, creditsPerRequest: 0 });
});

test("apollo people-source: maps hits to person records with employer blocks and NEVER contact data", async () => {
  const { fetchImpl, requests } = apolloFetchStub([{ status: 200, body: apolloFixture("search-page1.json") }]);
  const source = new ApolloPeopleSource({ client: makeClient(fetchImpl) });

  const [spec] = source.planSearchRequests({ personTitles: ["CEO"], locations: ["Austin, TX"], limit: 100 });
  const result = await source.executeSearchRequest(spec!, { personTitles: ["CEO"], locations: ["Austin, TX"], limit: 100 }, { requestKey: "run:step:src:0:1" });

  assert.equal(result.cost, 0);
  assert.equal(result.providerRequestId, "run:step:src:0:1", "no provider id exists; the request key is the fallback");
  assert.equal(result.records.length, 3);
  assert.match(result.coverageNote, /No contact data at search time/);
  assert.match(result.coverageNote, /not complete market coverage/);

  const jane = result.records[0]!;
  assert.equal(jane.kind, "person");
  assert.equal(jane.sourceKey, "sanitized-person-0001");
  assert.equal(jane.title, "Chief Executive Officer");
  assert.equal(jane.person?.apolloPersonId, "sanitized-person-0001");
  assert.equal(jane.person?.employer?.apolloOrganizationId, "sanitized-org-0001");
  assert.equal(jane.person?.employer?.domain, "acmehealth.example");
  for (const record of result.records) {
    assert.equal(record.phone, undefined, "search returns no phones");
    assert.equal(record.email, undefined, "search returns no emails");
  }
  // The third hit has no organization: still a valid person record.
  assert.equal(result.records[2]?.person?.employer, undefined);

  const body = requests[0]?.body as Record<string, unknown>;
  assert.equal(body["page"], 1);
  assert.equal(body["per_page"], 100);
});

test("apollo people-source: malformed hits are dropped per item and counted, not fatal", async () => {
  const fixture = JSON.parse(apolloFixture("search-page1.json")) as { people: unknown[] };
  fixture.people.push({ not_a_person: true });
  const { fetchImpl } = apolloFetchStub([{ status: 200, body: JSON.stringify(fixture) }]);
  const source = new ApolloPeopleSource({ client: makeClient(fetchImpl) });

  const query = { personTitles: ["CEO"], limit: 100 };
  const [spec] = source.planSearchRequests(query);
  const result = await source.executeSearchRequest(spec!, query, { requestKey: "k" });
  assert.equal(result.records.length, 3);
  assert.match(result.coverageNote, /1 hit\(s\) dropped as unparseable/);
});

test("apollo enrich: a match costs one credit, filters the locked-email placeholder, and carries identity backfill", async () => {
  const { fetchImpl, requests } = apolloFetchStub([
    { status: 200, body: apolloFixture("match-found.json") },
    { status: 200, body: apolloFixture("match-locked-email.json") },
    { status: 200, body: apolloFixture("match-none.json") },
  ]);
  const enricher = new ApolloEnrichProvider({ client: makeClient(fetchImpl) });
  assert.equal(enricher.idempotentReplay, false, "Apollo has no request-key idempotency");

  // 1. Full match: work email + Apollo's own claim kept as a CLAIM.
  const match = await enricher.enrich({
    requestKey: "rk-1",
    sourceKey: "sanitized-person-0001",
    name: "Jane Sample",
    kind: "person",
    firstName: "Jane",
    lastName: "Sample",
    apolloPersonId: "sanitized-person-0001",
    employerDomain: "acmehealth.example",
  });
  assert.equal(match.kind, "match");
  assert.equal(match.cost, 1);
  if (match.kind === "match") {
    assert.equal(match.person.workEmail, "jane.sample@acmehealth.example");
    assert.equal(match.person.emailStatusClaim, "verified");
    assert.equal(match.person.apolloPersonId, "sanitized-person-0001");
    assert.equal(match.person.apolloOrganizationId, "sanitized-org-0001");
  }
  const body = requests[0]?.body as Record<string, unknown>;
  assert.equal(body["reveal_personal_emails"], false);
  assert.ok(!("reveal_phone_number" in body));

  // 2. Locked placeholder is NOT an address.
  const locked = await enricher.enrich({ requestKey: "rk-2", sourceKey: "s2", name: "Rob Fictional", kind: "person" });
  assert.equal(locked.kind, "match");
  if (locked.kind === "match") {
    assert.equal(locked.person.workEmail, undefined);
    assert.equal(locked.person.emailStatusClaim, undefined);
  }

  // 3. 200 without a person: free no_match — the lead stays valid.
  const none = await enricher.enrich({ requestKey: "rk-3", sourceKey: "s3", name: "Nobody Here", kind: "person" });
  assert.equal(none.kind, "no_match");
  assert.equal(none.cost, 0);
});

test("apollo enrich: business leads match by company identity, not person name", async () => {
  const { fetchImpl, requests } = apolloFetchStub([{ status: 200, body: apolloFixture("match-none.json") }]);
  const enricher = new ApolloEnrichProvider({ client: makeClient(fetchImpl) });

  await enricher.enrich({
    requestKey: "rk-4",
    sourceKey: "pid:abc",
    name: "Austin Roof Pros",
    kind: "business",
    normalizedDomain: "austinroofpros.example",
  });
  const body = requests[0]?.body as Record<string, unknown>;
  assert.equal(body["name"], undefined, "a business display name is not a person name");
  assert.equal(body["organization_name"], "Austin Roof Pros");
  assert.equal(body["domain"], "austinroofpros.example");
});
