import assert from "node:assert/strict";
import { test } from "node:test";

import { SerpApiClient } from "../src/providers/serpapi/client.js";
import { extractSourceKey, parseUsAddress } from "../src/providers/serpapi/identity.js";
import { SerpApiLocalBusinessSource } from "../src/providers/serpapi/maps-source.js";
import { loadSerpApiFixture, stubFetch } from "./helpers/serpapi-stub.js";

function source(fetchImpl: typeof fetch, opts: { maxPagesPerQuery?: number } = {}) {
  const client = new SerpApiClient({ apiKey: "k", baseUrl: "https://serpapi.test", maxRequestsPerMinute: 6000, fetchImpl });
  return new SerpApiLocalBusinessSource({ client, creditsPerRequest: 1, ...opts });
}

const okFetch = stubFetch(() => ({ status: 200, body: loadSerpApiFixture("maps-austin-p0.json") }));

test("maps source: one request per named location (page 1 only)", () => {
  const s = source(okFetch);
  const specs = s.planSearchRequests({ businessType: "roofing contractor", locations: ["Austin, TX", "Dallas, TX"], limit: 50 });
  assert.equal(specs.length, 2);
  assert.equal(s.estimateSearchCost({ businessType: "roofing contractor", locations: ["Austin, TX", "Dallas, TX"], limit: 50 }).requests, 2);
});

test("maps source: a coordinate location paginates up to the page ceiling", () => {
  const s = source(okFetch, { maxPagesPerQuery: 6 });
  const specs = s.planSearchRequests({ businessType: "roofing contractor", locations: ["@30.26,-97.74,12z"], limit: 100 });
  // limit 100 / 20 per page = 5 pages, under the ceiling of 6.
  assert.equal(specs.length, 5);
  assert.ok(specs.every((sp) => sp.descriptor.includes("@30.26,-97.74,12z")));
});

test("maps source: maps SerpAPI fields onto SourceRecord and derives a stable key", async () => {
  const s = source(okFetch);
  const query = { businessType: "roofing contractor", locations: ["Austin, TX"], limit: 50 };
  const [spec] = s.planSearchRequests(query);
  const result = await s.executeSearchRequest(spec!, query, { requestKey: "rk-0" });

  assert.equal(result.cost, 1);
  assert.equal(result.records.length, 4);
  const [first, second, third, fourth] = result.records;

  assert.equal(first?.name, "Austin Roofing Co");
  assert.equal(first?.category, "Roofing contractor");
  assert.equal(first?.phone, "+1 512-555-0100");
  assert.equal(first?.website, "https://austinroofingco.example");
  assert.equal(first?.rating, 4.8);
  assert.equal(first?.reviewCount, 320);
  assert.equal(first?.locality, "Austin");
  assert.equal(first?.region, "TX");
  assert.equal(first?.sourceKey, "pid:ChIJsanitizedAAA");
  assert.equal(first?.sourceUrl, "https://www.google.com/maps?cid=1111111111111111111");

  // No place_id -> CID key; no place_id and no CID -> deterministic hash key.
  assert.equal(third?.sourceKey, "cid:3333333333333333333");
  assert.ok(fourth?.sourceKey.startsWith("nk:"));
  assert.equal(second?.sourceKey, "pid:ChIJsanitizedBBB");

  assert.ok(result.coverageNote.includes("page 1 only"));
  assert.ok(result.coverageNote.includes("not complete coverage"));
});

test("maps source: one malformed listing is dropped without losing the rest of a charged 200", async () => {
  const body = {
    search_metadata: { id: "req-x", status: "Success" },
    local_results: [
      { title: "Good Roofing", place_id: "ChIJgood", type: "Roofing contractor", rating: 4.5, reviews: 10 },
      { title: 12345, rating: "not-a-number" }, // malformed listing
      { title: "Also Good", data_cid: "999", type: "Roofing contractor" },
    ],
  };
  const s = source(stubFetch(() => ({ status: 200, body })));
  const query = { businessType: "roofing contractor", locations: ["Austin, TX"], limit: 50 };
  const [spec] = s.planSearchRequests(query);
  const result = await s.executeSearchRequest(spec!, query, { requestKey: "rk-0" });
  assert.equal(result.records.length, 2, "valid listings survive");
  assert.equal(result.cost, 1, "the search is still a charged success");
  assert.ok(result.coverageNote.includes("1 listing(s) dropped"));
});

test("maps source: near-miss coordinate forms fall back to named-location handling", () => {
  const s = source(okFetch);
  // Missing zoom / missing z-suffix would be rejected by SerpAPI at execution;
  // they must plan as ordinary named locations (q-based, page 1) instead.
  for (const loc of ["@30.2,-97.7", "@30.2,-97.7,12"]) {
    const specs = s.planSearchRequests({ businessType: "roofing", locations: [loc], limit: 100 });
    assert.equal(specs.length, 1, `${loc} plans a single q-based request`);
  }
  const coord = s.planSearchRequests({ businessType: "roofing", locations: ["@30.2,-97.7,12z"], limit: 100 });
  assert.equal(coord.length, 5, "the exact @lat,lon,zoomz form paginates");
});

test("maps source: extractSourceKey is deterministic for the hash fallback", () => {
  const a = extractSourceKey({ title: "Joe's Roofing", address: "1 Main St, Austin, TX 78701, United States" });
  const b = extractSourceKey({ title: "Joe's Roofing", address: "1 Main St, Austin, TX 78701, United States" });
  assert.equal(a, b);
  assert.ok(a.startsWith("nk:"));
});

test("maps source: US address parse extracts locality/region, no-ops on odd formats", () => {
  assert.deepEqual(parseUsAddress("100 Congress Ave, Austin, TX 78701, United States"), {
    addressLine: "100 Congress Ave, Austin, TX 78701, United States",
    locality: "Austin",
    region: "TX",
    country: "United States",
  });
  const odd = parseUsAddress("Some Plaza, Building 4");
  assert.equal(odd.region, null);
  assert.equal(odd.locality, null);
});
