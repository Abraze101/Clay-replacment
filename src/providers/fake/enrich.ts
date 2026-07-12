import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { AmbiguousOutcomeError, AppError, RetryableProviderError } from "../../shared/errors.js";
import type { EnrichOutcome, EnrichProvider, EnrichRequest } from "../types.js";
import { FIXTURE_BUSINESSES } from "./fixtures.js";

interface LedgerEntry {
  outcome: "match" | "no_match" | "retryable_failure" | "ambiguous";
  charged: number;
  providerRequestId: string;
}

interface Ledger {
  /** requestKey → recorded outcome. Replaying a stored key NEVER charges again. */
  requests: Record<string, LedgerEntry>;
  /** sourceKey → how many distinct (non-replayed) calls were executed. */
  callCounts: Record<string, number>;
  totalCharged: number;
}

/**
 * Apollo-like fake enrichment with a PERSISTED request_key-deduplicated
 * ledger — the provider-side idempotency contract the engine's crash-replay
 * semantics rely on (and that real M3/M4 adapters must document). The ledger
 * file survives process exits so the subprocess crash-resume test can prove
 * exactly-once charging.
 */
export class FakeEnrichProvider implements EnrichProvider {
  readonly name = "fake-apollo";
  readonly costPerRecord = 1;

  constructor(private readonly ledgerPath: string) {}

  async enrich(request: EnrichRequest): Promise<EnrichOutcome> {
    const ledger = this.load();

    // Provider-side idempotency: a replayed request key returns the recorded
    // outcome without executing or charging again.
    const replay = ledger.requests[request.requestKey];
    if (replay) {
      return this.replayOutcome(request, replay);
    }

    const fixture = FIXTURE_BUSINESSES.find((f) => f.sourceKey === request.sourceKey);
    const behavior = fixture?.enrichBehavior ?? "no_match";
    const call = (ledger.callCounts[request.sourceKey] ?? 0) + 1;
    ledger.callCounts[request.sourceKey] = call;
    const providerRequestId = `fake-apollo-${request.sourceKey}-${call}`;

    switch (behavior) {
      case "flaky": {
        if (call === 1) {
          ledger.requests[request.requestKey] = { outcome: "retryable_failure", charged: 0, providerRequestId };
          this.save(ledger);
          throw new RetryableProviderError("Transient upstream failure (fixture: flaky).", {
            charged: false,
            providerRequestId,
          });
        }
        return Promise.resolve(this.recordMatch(ledger, request, providerRequestId));
      }
      case "always_broken_charged": {
        const charged = call === 1 ? this.costPerRecord : 0;
        ledger.requests[request.requestKey] = { outcome: "retryable_failure", charged, providerRequestId };
        ledger.totalCharged += charged;
        this.save(ledger);
        throw new RetryableProviderError("Upstream permanently failing (fixture: always-broken).", {
          charged: charged > 0,
          cost: charged,
          providerRequestId,
        });
      }
      case "ambiguous": {
        // The provider actually completed and charged, but reports an
        // unconfirmable outcome. Never auto-retry a call like this.
        ledger.requests[request.requestKey] = { outcome: "ambiguous", charged: this.costPerRecord, providerRequestId };
        ledger.totalCharged += this.costPerRecord;
        this.save(ledger);
        throw new AmbiguousOutcomeError(
          "Request may have completed; the provider cannot confirm the outcome (fixture: ambiguous).",
          this.costPerRecord,
          { providerRequestId },
        );
      }
      case "match":
        return this.recordMatch(ledger, request, providerRequestId);
      case "no_match": {
        ledger.requests[request.requestKey] = { outcome: "no_match", charged: this.costPerRecord, providerRequestId };
        ledger.totalCharged += this.costPerRecord;
        this.save(ledger);
        return { kind: "no_match", cost: this.costPerRecord, providerRequestId };
      }
    }
  }

  /** Test/audit hook: provider-side view of total charges and executed calls. */
  stats(): { totalCharged: number; executedCalls: number } {
    const ledger = this.load();
    return {
      totalCharged: ledger.totalCharged,
      executedCalls: Object.values(ledger.callCounts).reduce((a, b) => a + b, 0),
    };
  }

  private recordMatch(ledger: Ledger, request: EnrichRequest, providerRequestId: string): EnrichOutcome {
    const fixture = FIXTURE_BUSINESSES.find((f) => f.sourceKey === request.sourceKey);
    if (!fixture?.person) {
      throw new AppError("INTERNAL", `Fixture ${request.sourceKey} has behavior 'match' but no person.`, {});
    }
    ledger.requests[request.requestKey] = { outcome: "match", charged: this.costPerRecord, providerRequestId };
    ledger.totalCharged += this.costPerRecord;
    this.save(ledger);
    return { kind: "match", person: fixture.person, cost: this.costPerRecord, providerRequestId };
  }

  private replayOutcome(request: EnrichRequest, entry: LedgerEntry): EnrichOutcome {
    switch (entry.outcome) {
      case "match": {
        const fixture = FIXTURE_BUSINESSES.find((f) => f.sourceKey === request.sourceKey);
        if (!fixture?.person) throw new AppError("INTERNAL", "Replay of match without fixture person.", {});
        // Replay: outcome returned from the provider's cache, charge NOT repeated.
        return { kind: "match", person: fixture.person, cost: entry.charged, providerRequestId: entry.providerRequestId };
      }
      case "no_match":
        return { kind: "no_match", cost: entry.charged, providerRequestId: entry.providerRequestId };
      case "retryable_failure":
        throw new RetryableProviderError("Replayed failed attempt (fixture).", {
          charged: false,
          providerRequestId: entry.providerRequestId,
        });
      case "ambiguous":
        throw new AmbiguousOutcomeError("Replayed ambiguous attempt (fixture).", 0, {
          providerRequestId: entry.providerRequestId,
        });
    }
  }

  private load(): Ledger {
    if (!existsSync(this.ledgerPath)) return { requests: {}, callCounts: {}, totalCharged: 0 };
    return JSON.parse(readFileSync(this.ledgerPath, "utf8")) as Ledger;
  }

  private save(ledger: Ledger): void {
    mkdirSync(path.dirname(this.ledgerPath), { recursive: true });
    writeFileSync(this.ledgerPath, JSON.stringify(ledger, null, 2), "utf8");
  }
}
