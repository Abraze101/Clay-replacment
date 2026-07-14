import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface CapabilityLedgerEntry {
  outcome: string;
  charged: number;
  providerRequestId: string;
  /** Recorded result payload for deterministic replay (JSON-safe). */
  payload?: unknown;
}

export interface CapabilityLedger {
  /** namespaced `${provider}:${requestKey}` → recorded outcome. Replays NEVER charge again. */
  requests: Record<string, CapabilityLedgerEntry>;
  /** namespaced `${provider}:${inputValue}` → distinct executed calls (drives once-then-succeed fixtures). */
  callCounts: Record<string, number>;
  /** async jobs: jobId → poll bookkeeping (fake contact discovery). */
  jobs: Record<string, { requestKey: string; polls: number }>;
  totalCharged: number;
}

/**
 * One persisted ledger file shared by the three fake capability providers —
 * the same provider-side idempotency contract as FakeEnrichProvider: replaying
 * a stored requestKey returns the recorded outcome without executing or
 * charging again, across process boundaries (crash-resume tests).
 */
export class CapabilityLedgerStore {
  constructor(private readonly ledgerPath: string) {}

  load(): CapabilityLedger {
    if (!existsSync(this.ledgerPath)) return { requests: {}, callCounts: {}, jobs: {}, totalCharged: 0 };
    const parsed = JSON.parse(readFileSync(this.ledgerPath, "utf8")) as Partial<CapabilityLedger>;
    return {
      requests: parsed.requests ?? {},
      callCounts: parsed.callCounts ?? {},
      jobs: parsed.jobs ?? {},
      totalCharged: parsed.totalCharged ?? 0,
    };
  }

  save(ledger: CapabilityLedger): void {
    mkdirSync(path.dirname(this.ledgerPath), { recursive: true });
    writeFileSync(this.ledgerPath, JSON.stringify(ledger, null, 2), "utf8");
  }

  /** Total charged across all fake capability providers (test/audit hook). */
  totalCharged(): number {
    return this.load().totalCharged;
  }
}
