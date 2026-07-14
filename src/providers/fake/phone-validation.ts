import { AmbiguousOutcomeError, RateLimitError, RetryableProviderError } from "../../shared/errors.js";
import type {
  PhoneSignal,
  PhoneValidationProvider,
  PhoneValidationRequest,
  PhoneValidationResult,
} from "../capabilities.js";
import { CapabilityLedgerStore } from "./capability-ledger.js";
import { fakePhoneBehavior, type FakePhoneSignals } from "./capability-fixtures.js";

/**
 * Deterministic Twilio-Lookup-shaped fake. Signals come from the phone's last
 * two digits (see capability-fixtures.ts); the persisted ledger dedupes on
 * requestKey so a crash replay provably cannot double-charge.
 */
export class FakePhoneValidation implements PhoneValidationProvider {
  readonly name = "fake-phone-validation";
  readonly supportedSignals: readonly PhoneSignal[] = ["line_type", "line_status", "identity_match"];
  readonly costPerSignal = { line_type: 1, line_status: 1, identity_match: 1 } as const;
  readonly costOnNoResult = 0;
  readonly idempotentReplay = true;

  private readonly store: CapabilityLedgerStore;

  constructor(ledgerPath: string) {
    this.store = new CapabilityLedgerStore(ledgerPath);
  }

  async validate(request: PhoneValidationRequest): Promise<PhoneValidationResult> {
    const ledger = this.store.load();
    const requestId = `${this.name}:${request.requestKey}`;

    const replay = ledger.requests[requestId];
    if (replay) {
      if (replay.outcome === "ambiguous") {
        throw new AmbiguousOutcomeError("Replayed ambiguous attempt (fixture).", 0, {
          providerRequestId: replay.providerRequestId,
        });
      }
      // Replay: recorded result returned, charge NOT repeated.
      return Promise.resolve({ ...(replay.payload as PhoneValidationResult), cost: 0 });
    }

    if (!/^\+[1-9][0-9]{1,14}$/.test(request.phoneE164)) {
      const result: PhoneValidationResult = {
        formatValid: false,
        cost: this.costOnNoResult,
        providerRequestId: `fake-pv-${request.requestKey}`,
      };
      ledger.requests[requestId] = { outcome: "invalid_format", charged: 0, providerRequestId: result.providerRequestId, payload: result };
      this.store.save(ledger);
      return Promise.resolve(result);
    }

    const behavior = fakePhoneBehavior(request.phoneE164);
    const callKey = `${this.name}:${request.phoneE164}`;
    const call = (ledger.callCounts[callKey] ?? 0) + 1;
    ledger.callCounts[callKey] = call;
    const providerRequestId = `fake-pv-${request.phoneE164}-${call}`;
    const cost = request.signals.reduce((sum, s) => sum + this.costPerSignal[s], 0);

    switch (behavior.kind) {
      case "rate_limit_once": {
        if (call === 1) {
          this.store.save(ledger);
          throw new RateLimitError("Rate limited (fixture: 75).", 1, { providerRequestId });
        }
        return Promise.resolve(this.record(ledger, requestId, providerRequestId, request, behavior.then, cost));
      }
      case "flaky_once": {
        if (call === 1) {
          ledger.requests[requestId] = { outcome: "retryable_failure", charged: 0, providerRequestId };
          this.store.save(ledger);
          throw new RetryableProviderError("Transient upstream failure (fixture: 77).", {
            charged: false,
            providerRequestId,
          });
        }
        return Promise.resolve(this.record(ledger, requestId, providerRequestId, request, behavior.then, cost));
      }
      case "ambiguous": {
        ledger.requests[requestId] = { outcome: "ambiguous", charged: cost, providerRequestId };
        ledger.totalCharged += cost;
        this.store.save(ledger);
        throw new AmbiguousOutcomeError(
          "Lookup may have completed; outcome unconfirmable (fixture: 76).",
          cost,
          { providerRequestId },
        );
      }
      case "signals":
        return Promise.resolve(this.record(ledger, requestId, providerRequestId, request, behavior.signals, cost));
    }
  }

  private record(
    ledger: ReturnType<CapabilityLedgerStore["load"]>,
    requestId: string,
    providerRequestId: string,
    request: PhoneValidationRequest,
    signals: FakePhoneSignals,
    cost: number,
  ): PhoneValidationResult {
    const result: PhoneValidationResult = {
      formatValid: true,
      normalizedE164: request.phoneE164,
      cost,
      providerRequestId,
      ...(request.signals.includes("line_type")
        ? { lineType: { value: signals.lineType, confidence: 0.95 } }
        : {}),
      ...(request.signals.includes("line_status")
        ? { lineStatus: { value: signals.lineStatus, confidence: 0.9 } }
        : {}),
      ...(request.signals.includes("identity_match")
        ? { identityMatch: { value: signals.identityMatch, confidence: 0.8 } }
        : {}),
    };
    ledger.requests[requestId] = { outcome: "ok", charged: cost, providerRequestId, payload: result };
    ledger.totalCharged += cost;
    this.store.save(ledger);
    return result;
  }
}
