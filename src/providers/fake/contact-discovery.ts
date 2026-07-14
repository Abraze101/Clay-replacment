import { AmbiguousOutcomeError, AppError, RateLimitError, RetryableProviderError } from "../../shared/errors.js";
import type {
  ContactDiscoveryOutcome,
  ContactDiscoveryProvider,
  ContactDiscoveryRequest,
  ContactKind,
} from "../capabilities.js";
import { discoveryCostPerRecord } from "../capabilities.js";
import { CapabilityLedgerStore } from "./capability-ledger.js";
import { discoveredContacts, fakeDiscoveryBehavior } from "./capability-fixtures.js";

/**
 * Deterministic contact-discovery fake covering BOTH delivery modes: sync
 * (found/no_result) and async submit-then-poll for domains containing 'slow'
 * (pending → pending → found across two polls — the ADR-029 path, offline).
 * Charged only on delivered data; the persisted ledger dedupes on requestKey
 * and records vendor jobs so findJobByRequestKey can reconcile a submit crash.
 */
export class FakeContactDiscovery implements ContactDiscoveryProvider {
  readonly name = "fake-contact-discovery";
  readonly costPerKind: Readonly<Record<ContactKind, number>> = {
    work_email: 1,
    direct_phone: 5,
    mobile_phone: 5,
  };
  readonly costOnNoResult = 0;
  readonly asyncDelivery = true;
  readonly idempotentReplay = true;
  readonly maxPollSeconds = 600;

  private readonly store: CapabilityLedgerStore;

  constructor(ledgerPath: string) {
    this.store = new CapabilityLedgerStore(ledgerPath);
  }

  async discover(request: ContactDiscoveryRequest): Promise<ContactDiscoveryOutcome> {
    const ledger = this.store.load();
    const requestId = `${this.name}:${request.requestKey}`;

    const replay = ledger.requests[requestId];
    if (replay) {
      if (replay.outcome === "ambiguous") {
        throw new AmbiguousOutcomeError("Replayed ambiguous attempt (fixture).", 0, {
          providerRequestId: replay.providerRequestId,
        });
      }
      if (replay.outcome === "pending") {
        // Submit already accepted: re-submitting returns the same job.
        return Promise.resolve(replay.payload as ContactDiscoveryOutcome);
      }
      const recorded = replay.payload as ContactDiscoveryOutcome & { kind: "found" | "no_result" };
      return Promise.resolve({ ...recorded, cost: 0 });
    }

    const behavior = fakeDiscoveryBehavior(request.company.domain);
    const callKey = `${this.name}:${request.company.domain ?? "-"}`;
    const call = (ledger.callCounts[callKey] ?? 0) + 1;
    ledger.callCounts[callKey] = call;
    const providerRequestId = `fake-cd-${call}-${request.requestKey.slice(0, 8)}`;

    switch (behavior.kind) {
      case "async_found": {
        const jobId = `job-${request.requestKey}`;
        ledger.jobs[jobId] = { requestKey: request.requestKey, polls: 0 };
        const pending: ContactDiscoveryOutcome = { kind: "pending", jobId, pollAfterSeconds: 1, providerRequestId };
        ledger.requests[requestId] = { outcome: "pending", charged: 0, providerRequestId, payload: pending };
        this.store.save(ledger);
        return Promise.resolve(pending);
      }
      case "rate_limit_once": {
        if (call === 1) {
          this.store.save(ledger);
          throw new RateLimitError("Rate limited (fixture: ratelimit domain).", 1, { providerRequestId });
        }
        return Promise.resolve(this.recordFound(ledger, requestId, providerRequestId, request, behavior.then));
      }
      case "flaky_once": {
        if (call === 1) {
          ledger.requests[requestId] = { outcome: "retryable_failure", charged: 0, providerRequestId };
          this.store.save(ledger);
          throw new RetryableProviderError("Transient upstream failure (fixture: flaky domain).", {
            charged: false,
            providerRequestId,
          });
        }
        return Promise.resolve(this.recordFound(ledger, requestId, providerRequestId, request, behavior.then));
      }
      case "ambiguous": {
        const possibleCost = discoveryCostPerRecord(this, request.wanted);
        ledger.requests[requestId] = { outcome: "ambiguous", charged: possibleCost, providerRequestId };
        ledger.totalCharged += possibleCost;
        this.store.save(ledger);
        throw new AmbiguousOutcomeError(
          "Submit may have been accepted; no job id captured (fixture: ambiguous domain).",
          possibleCost,
          { providerRequestId },
        );
      }
      case "no_result": {
        const outcome: ContactDiscoveryOutcome = { kind: "no_result", cost: this.costOnNoResult, providerRequestId };
        ledger.requests[requestId] = { outcome: "no_result", charged: 0, providerRequestId, payload: outcome };
        this.store.save(ledger);
        return Promise.resolve(outcome);
      }
      case "found":
        return Promise.resolve(this.recordFound(ledger, requestId, providerRequestId, request, behavior.contacts));
    }
  }

  async poll(jobId: string, request: ContactDiscoveryRequest): Promise<ContactDiscoveryOutcome> {
    const ledger = this.store.load();
    const job = ledger.jobs[jobId];
    if (!job) {
      throw new AppError("PROVIDER_ERROR", `Unknown fake discovery job '${jobId}'.`, { jobId });
    }
    // A completed job returns its recorded result forever (vendors retain results).
    const doneKey = `${this.name}:job-done:${jobId}`;
    const done = ledger.requests[doneKey];
    if (done) return Promise.resolve({ ...(done.payload as ContactDiscoveryOutcome & { kind: "found" }), cost: 0 });

    job.polls += 1;
    if (job.polls < 2) {
      this.store.save(ledger);
      return Promise.resolve({ kind: "pending" as const, jobId, pollAfterSeconds: 1, providerRequestId: `fake-cd-poll-${job.polls}` });
    }
    const behavior = fakeDiscoveryBehavior(request.company.domain);
    const contacts =
      behavior.kind === "async_found" || behavior.kind === "found"
        ? behavior.contacts
        : { email: `owner@${request.company.domain ?? "unknown.example"}` };
    const found = discoveredContacts(contacts, request.wanted);
    const cost = this.chargeFor(found);
    const outcome: ContactDiscoveryOutcome = {
      kind: found.length > 0 ? "found" : "no_result",
      ...(found.length > 0 ? { contacts: found } : {}),
      cost: found.length > 0 ? cost : 0,
      providerRequestId: `fake-cd-poll-${job.polls}`,
    } as ContactDiscoveryOutcome;
    ledger.requests[doneKey] = { outcome: "found", charged: cost, providerRequestId: `fake-cd-poll-${job.polls}`, payload: outcome };
    ledger.totalCharged += cost;
    this.store.save(ledger);
    return Promise.resolve(outcome);
  }

  /** Vendor billing model: email enrichment and phone enrichment each charge ONCE per delivered kind class. */
  private chargeFor(found: readonly { type: "phone" | "email" }[]): number {
    const email = found.some((c) => c.type === "email") ? this.costPerKind.work_email : 0;
    const phone = found.some((c) => c.type === "phone")
      ? Math.max(this.costPerKind.direct_phone, this.costPerKind.mobile_phone)
      : 0;
    return email + phone;
  }

  async findJobByRequestKey(requestKey: string): Promise<{ jobId: string } | null> {
    const ledger = this.store.load();
    const entry = Object.entries(ledger.jobs).find(([, job]) => job.requestKey === requestKey);
    return Promise.resolve(entry ? { jobId: entry[0] } : null);
  }

  private recordFound(
    ledger: ReturnType<CapabilityLedgerStore["load"]>,
    requestId: string,
    providerRequestId: string,
    request: ContactDiscoveryRequest,
    contacts: { email?: string; directPhone?: string; mobilePhone?: string },
  ): ContactDiscoveryOutcome {
    const found = discoveredContacts(contacts, request.wanted);
    if (found.length === 0) {
      const outcome: ContactDiscoveryOutcome = { kind: "no_result", cost: 0, providerRequestId };
      ledger.requests[requestId] = { outcome: "no_result", charged: 0, providerRequestId, payload: outcome };
      this.store.save(ledger);
      return outcome;
    }
    const cost = this.chargeFor(found);
    const outcome: ContactDiscoveryOutcome = { kind: "found", contacts: found, cost, providerRequestId };
    ledger.requests[requestId] = { outcome: "found", charged: cost, providerRequestId, payload: outcome };
    ledger.totalCharged += cost;
    this.store.save(ledger);
    return outcome;
  }
}
