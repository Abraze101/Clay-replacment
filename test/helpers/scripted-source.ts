import { AmbiguousOutcomeError, RateLimitError, RetryableProviderError } from "../../src/shared/errors.js";
import type { PagedPaidSource, SourceQuery, SourceRecord, SourceRequestSpec } from "../../src/providers/types.js";

/** Per-attempt scripted outcome for one request index. */
export type ScriptedOutcome =
  | { kind: "ok"; records?: number }
  | { kind: "rate_limit"; retryAfter?: number }
  | { kind: "ambiguous"; cost?: number }
  | { kind: "retryable"; charged?: boolean; cost?: number }
  | { kind: "crash" };

export interface ScriptedSourceOptions {
  name?: string;
  creditsPerRequest?: number;
  /** Outcomes keyed by request index; entry N is the outcome for attempt N+1. Default: one "ok". */
  script?: Record<number, ScriptedOutcome[]>;
}

/**
 * A deterministic PagedPaidSource for exercising the plan resolver and the
 * durable source-request ledger without any live vendor. One request per
 * location; each request's per-attempt outcome is scripted by index.
 */
export class ScriptedPagedSource implements PagedPaidSource {
  readonly name: string;
  readonly creditsPerRequest: number;
  private readonly script: Record<number, ScriptedOutcome[]>;
  readonly attempts = new Map<number, number>();
  readonly executedKeys: string[] = [];

  constructor(opts: ScriptedSourceOptions = {}) {
    this.name = opts.name ?? "local-business";
    this.creditsPerRequest = opts.creditsPerRequest ?? 5;
    this.script = opts.script ?? {};
  }

  planSearchRequests(query: SourceQuery): SourceRequestSpec[] {
    const locations = query.locations && query.locations.length > 0 ? query.locations : ["(none)"];
    return locations.map((loc, index) => ({
      index,
      descriptor: `search:${query.businessType ?? ""}:${loc}`,
      estimatedCost: this.creditsPerRequest,
    }));
  }

  estimateSearchCost(query: SourceQuery): { requests: number; creditsPerRequest: number } {
    return { requests: this.planSearchRequests(query).length, creditsPerRequest: this.creditsPerRequest };
  }

  executeSearchRequest(
    spec: SourceRequestSpec,
    _query: SourceQuery,
    opts: { requestKey: string },
  ): Promise<{ records: SourceRecord[]; providerRequestId: string; cost: number; coverageNote: string }> {
    this.executedKeys.push(opts.requestKey);
    const attempt = (this.attempts.get(spec.index) ?? 0) + 1;
    this.attempts.set(spec.index, attempt);
    const outcome = this.script[spec.index]?.[attempt - 1] ?? { kind: "ok" };
    switch (outcome.kind) {
      case "rate_limit":
        return Promise.reject(new RateLimitError(`429 at index ${spec.index}`, outcome.retryAfter ?? 30));
      case "ambiguous":
        return Promise.reject(
          new AmbiguousOutcomeError(`ambiguous at index ${spec.index}`, outcome.cost ?? this.creditsPerRequest, {
            providerRequestId: `amb-${spec.index}-${attempt}`,
          }),
        );
      case "retryable":
        return Promise.reject(
          new RetryableProviderError(`retryable at index ${spec.index}`, {
            charged: outcome.charged ?? false,
            cost: outcome.cost ?? 0,
          }),
        );
      case "crash":
        return Promise.reject(new Error(`crash at index ${spec.index}`));
      case "ok":
      default: {
        const n = outcome.records ?? 2;
        const records: SourceRecord[] = Array.from({ length: n }, (_unused, i) => ({
          sourceKey: `pid:idx${spec.index}-rec${i}`,
          name: `Business ${spec.index}-${i}`,
          category: "Roofing contractor",
          address: `${100 + i} Main St, Austin, TX`,
          locality: "Austin",
          region: "TX",
          country: "US",
          phone: "+15125550100",
          website: `https://biz-${spec.index}-${i}.example`,
          rating: 4.5,
          reviewCount: 20 + i,
          sourceUrl: `https://maps.example/idx${spec.index}/rec${i}`,
        }));
        return Promise.resolve({
          records,
          providerRequestId: `req-${spec.index}-${attempt}`,
          cost: this.creditsPerRequest,
          coverageNote: `index ${spec.index}: ${n} listings`,
        });
      }
    }
  }

  /** Base contract — provided for symmetry; the runner never uses it for paged paid sources. */
  search(query: SourceQuery): Promise<{ records: SourceRecord[]; requestId: string; coverageNote?: string }> {
    return Promise.all(
      this.planSearchRequests(query).map((spec) => this.executeSearchRequest(spec, query, { requestKey: `direct:${spec.index}` })),
    ).then((results) => ({
      records: results.flatMap((r) => r.records),
      requestId: results[0]?.providerRequestId ?? "scripted",
      coverageNote: "scripted",
    }));
  }
}
