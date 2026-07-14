import { AmbiguousOutcomeError, RateLimitError, RetryableProviderError } from "../../shared/errors.js";
import type {
  EmailVerificationProvider,
  EmailVerificationRequest,
  EmailVerificationResult,
} from "../capabilities.js";
import { CapabilityLedgerStore } from "./capability-ledger.js";
import { fakeEmailBehavior } from "./capability-fixtures.js";

/**
 * Deterministic email-deliverability fake (ZeroBounce-shaped statuses). The
 * local part selects the outcome (see capability-fixtures.ts); the persisted
 * ledger dedupes on requestKey; 'unknown' results cost 0 (vendors refund them).
 */
export class FakeEmailVerification implements EmailVerificationProvider {
  readonly name = "fake-email-verification";
  readonly costPerRecord = 1;
  readonly costOnUnknown = 0;
  readonly idempotentReplay = true;

  private readonly store: CapabilityLedgerStore;

  constructor(ledgerPath: string) {
    this.store = new CapabilityLedgerStore(ledgerPath);
  }

  async verify(request: EmailVerificationRequest): Promise<EmailVerificationResult> {
    const ledger = this.store.load();
    const requestId = `${this.name}:${request.requestKey}`;

    const replay = ledger.requests[requestId];
    if (replay) {
      if (replay.outcome === "ambiguous") {
        throw new AmbiguousOutcomeError("Replayed ambiguous attempt (fixture).", 0, {
          providerRequestId: replay.providerRequestId,
        });
      }
      return Promise.resolve({ ...(replay.payload as EmailVerificationResult), cost: 0 });
    }

    const behavior = fakeEmailBehavior(request.email);
    const callKey = `${this.name}:${request.email.toLowerCase()}`;
    const call = (ledger.callCounts[callKey] ?? 0) + 1;
    ledger.callCounts[callKey] = call;
    const providerRequestId = `fake-ev-${call}-${request.requestKey.slice(0, 8)}`;

    switch (behavior.kind) {
      case "rate_limit": {
        this.store.save(ledger);
        throw new RateLimitError("Rate limited (fixture: ratelimit@).", 1, { providerRequestId });
      }
      case "ambiguous": {
        ledger.requests[requestId] = { outcome: "ambiguous", charged: this.costPerRecord, providerRequestId };
        ledger.totalCharged += this.costPerRecord;
        this.store.save(ledger);
        throw new AmbiguousOutcomeError(
          "Verification may have completed; outcome unconfirmable (fixture: ambiguous@).",
          this.costPerRecord,
          { providerRequestId },
        );
      }
      case "flaky_once": {
        if (call === 1) {
          ledger.requests[requestId] = { outcome: "retryable_failure", charged: 0, providerRequestId };
          this.store.save(ledger);
          throw new RetryableProviderError("Transient upstream failure (fixture: flaky@).", {
            charged: false,
            providerRequestId,
          });
        }
        return Promise.resolve(this.record(ledger, requestId, providerRequestId, {
          status: behavior.then.status,
          confidence: behavior.then.confidence,
          cost: behavior.then.cost,
          providerRequestId,
        }));
      }
      case "status":
        return Promise.resolve(this.record(ledger, requestId, providerRequestId, {
          status: behavior.status,
          subStatus: behavior.subStatus,
          confidence: behavior.confidence,
          cost: behavior.cost,
          providerRequestId,
        }));
    }
  }

  private record(
    ledger: ReturnType<CapabilityLedgerStore["load"]>,
    requestId: string,
    providerRequestId: string,
    result: EmailVerificationResult,
  ): EmailVerificationResult {
    ledger.requests[requestId] = { outcome: result.status, charged: result.cost, providerRequestId, payload: result };
    ledger.totalCharged += result.cost;
    this.store.save(ledger);
    return result;
  }
}
