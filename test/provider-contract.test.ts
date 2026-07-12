import assert from "node:assert/strict";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { test } from "node:test";

import { FakeEnrichProvider } from "../src/providers/fake/enrich.js";
import { FakeResearchProvider } from "../src/providers/fake/research.js";
import { FakeSourceProvider } from "../src/providers/fake/source.js";
import { AmbiguousOutcomeError, RetryableProviderError } from "../src/shared/errors.js";

/**
 * Provider contract tests — the anchor for the M3 Places and M4 Apollo
 * adapters: stable record keys, request_key idempotency, charged-failure
 * reporting, and ambiguous outcomes.
 */
function tempLedger(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), "fake-enrich-"));
  return { path: path.join(dir, "ledger.json"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("source contract: stable keys, limit respected, coverage note present", async () => {
  const source = new FakeSourceProvider();
  const a = await source.search({ businessType: "roofing contractor", limit: 5 });
  const b = await source.search({ businessType: "roofing contractor", limit: 5 });
  assert.equal(a.records.length, 5);
  assert.deepEqual(a.records.map((r) => r.sourceKey), b.records.map((r) => r.sourceKey));
  assert.equal(a.requestId, b.requestId);
  assert.ok(a.coverageNote?.includes("never equals complete market coverage"));
});

test("enrich contract: replaying the same request_key never charges twice", async () => {
  const ledger = tempLedger();
  try {
    const enrich = new FakeEnrichProvider(ledger.path);
    const request = { requestKey: "r1:e:i1:1", sourceKey: "fx-001", name: "Austin Roof Pros" };
    const first = await enrich.enrich(request);
    const statsAfterFirst = enrich.stats();
    const replay = await enrich.enrich(request);
    const statsAfterReplay = enrich.stats();

    assert.equal(first.kind, "match");
    assert.equal(replay.kind, "match");
    assert.equal(statsAfterFirst.totalCharged, 1);
    assert.equal(statsAfterReplay.totalCharged, 1, "replay must not charge again");
    assert.equal(statsAfterReplay.executedCalls, 1, "replay must not execute again");
  } finally {
    ledger.cleanup();
  }
});

test("enrich contract: a DIFFERENT request_key (rotated on requeue) executes fresh", async () => {
  const ledger = tempLedger();
  try {
    const enrich = new FakeEnrichProvider(ledger.path);
    await enrich.enrich({ requestKey: "k1", sourceKey: "fx-008", name: "Bee Cave Roofing" });
    await enrich.enrich({ requestKey: "k2", sourceKey: "fx-008", name: "Bee Cave Roofing" });
    assert.equal(enrich.stats().totalCharged, 2);
  } finally {
    ledger.cleanup();
  }
});

test("enrich contract: flaky fails uncharged then succeeds; broken charges its first failed attempt", async () => {
  const ledger = tempLedger();
  try {
    const enrich = new FakeEnrichProvider(ledger.path);

    await assert.rejects(
      () => enrich.enrich({ requestKey: "f1", sourceKey: "fx-009", name: "Flaky Gutters LLC" }),
      RetryableProviderError,
    );
    assert.equal(enrich.stats().totalCharged, 0, "flaky first failure is uncharged");
    const second = await enrich.enrich({ requestKey: "f2", sourceKey: "fx-009", name: "Flaky Gutters LLC" });
    assert.equal(second.kind, "match");

    await assert.rejects(
      () => enrich.enrich({ requestKey: "b1", sourceKey: "fx-010", name: "Broken Data Roofing" }),
      (err: RetryableProviderError) => err.details["charged"] === true && err.details["cost"] === 1,
    );
    await assert.rejects(
      () => enrich.enrich({ requestKey: "b2", sourceKey: "fx-010", name: "Broken Data Roofing" }),
      (err: RetryableProviderError) => err.details["charged"] === false,
    );
  } finally {
    ledger.cleanup();
  }
});

test("enrich contract: ambiguous outcome charges and throws AmbiguousOutcomeError", async () => {
  const ledger = tempLedger();
  try {
    const enrich = new FakeEnrichProvider(ledger.path);
    await assert.rejects(
      () => enrich.enrich({ requestKey: "a1", sourceKey: "fx-011", name: "Ambiguous Analytics Roofing" }),
      AmbiguousOutcomeError,
    );
    assert.equal(enrich.stats().totalCharged, 1, "the provider actually charged");
  } finally {
    ledger.cleanup();
  }
});

test("research contract: summary for reachable sites, unavailable for the ghost site, no site → unavailable", async () => {
  const research = new FakeResearchProvider();
  const ok = await research.research({ websiteUrl: "https://www.austinroofpros.com", normalizedDomain: "austinroofpros.com" });
  assert.equal(ok.kind, "ok");
  const ghost = await research.research({ websiteUrl: "https://www.ghostsiterenovations.com", normalizedDomain: "ghostsiterenovations.com" });
  assert.deepEqual(ghost, { kind: "unavailable", reason: "site_unreachable" });
  const none = await research.research({ websiteUrl: null, normalizedDomain: null });
  assert.deepEqual(none, { kind: "unavailable", reason: "no_website" });
});
