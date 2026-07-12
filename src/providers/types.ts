/**
 * Provider-neutral interfaces. Workflow definitions reference providers by
 * name; the registry resolves them. Nothing here is specific to any vendor —
 * M0 registers only fake implementations.
 */

export interface SourceRecord {
  /** Stable provider-scoped identifier (survives pagination and re-fetch). */
  sourceKey: string;
  name: string;
  category?: string;
  address?: string;
  locality?: string;
  region?: string;
  country?: string;
  phone?: string;
  website?: string;
  rating?: number;
  reviewCount?: number;
  /** Per-record provenance URL (e.g. the Maps listing); stored on lead_sources. */
  sourceUrl?: string;
}

export interface SourceQuery {
  businessType?: string;
  locations?: string[];
  limit: number;
}

/** Free discovery of candidate businesses/people. */
export interface SourceProvider {
  readonly name: string;
  search(query: SourceQuery): Promise<{ records: SourceRecord[]; requestId: string; coverageNote?: string }>;
}

/** One planned, billable request within a paged paid source (ledger identity). */
export interface SourceRequestSpec {
  /** Stable ordinal = run_source_requests.request_index. */
  index: number;
  /** Human-readable + deterministic label for the request row. */
  descriptor: string;
  estimatedCost: number;
}

/**
 * A PAID, MULTI-REQUEST source (e.g. a Maps-search API billed per query). When
 * a provider implements this, the runner drives it through the durable
 * run_source_requests ledger so a crash / 429 / credit pause never re-pays for
 * a completed request. `search()` (the base contract) is still implemented for
 * symmetry but the runner never uses it for these providers.
 */
export interface PagedPaidSource extends SourceProvider {
  planSearchRequests(query: SourceQuery): SourceRequestSpec[];
  /**
   * Execute one planned request. The `query` is passed so the provider can
   * deterministically re-derive the concrete request for `spec.index` (the
   * engine only persists the neutral index/descriptor, not vendor params).
   */
  executeSearchRequest(
    spec: SourceRequestSpec,
    query: SourceQuery,
    opts: { requestKey: string },
  ): Promise<{ records: SourceRecord[]; providerRequestId: string; cost: number; coverageNote: string }>;
  estimateSearchCost(query: SourceQuery): { requests: number; creditsPerRequest: number };
}

export function isPagedPaidSource(provider: SourceProvider): provider is PagedPaidSource {
  return "executeSearchRequest" in provider && typeof (provider as PagedPaidSource).executeSearchRequest === "function";
}

export interface EnrichRequest {
  /**
   * The engine's stored, attempt-scoped idempotency key. The fake provider
   * dedupes on it — the contract real (M3/M4) adapters must document.
   */
  requestKey: string;
  sourceKey: string;
  name: string;
  normalizedDomain?: string | null;
  normalizedPhone?: string | null;
  locality?: string | null;
}

export interface EnrichPerson {
  firstName: string;
  lastName: string;
  title: string;
  directPhone?: string;
  workEmail?: string;
}

export type EnrichOutcome =
  | { kind: "match"; person: EnrichPerson; cost: number; providerRequestId: string }
  | { kind: "no_match"; cost: number; providerRequestId: string };

/**
 * Paid-style enrichment. May throw RetryableProviderError (safe to retry;
 * `charged` in details says whether the failed attempt consumed credits) or
 * AmbiguousOutcomeError (possibly completed; never auto-retried).
 */
export interface EnrichProvider {
  readonly name: string;
  readonly costPerRecord: number;
  enrich(request: EnrichRequest): Promise<EnrichOutcome>;
}

export type ResearchOutcome =
  | { kind: "ok"; summary: string; facts: Record<string, string>; providerRequestId: string }
  | { kind: "unavailable"; reason: string };

/**
 * Bounded public-website research. Free by default (the fake provider); a live
 * provider (Firecrawl) sets `costPerRecord`, which makes the research step a
 * paid item step priced by the plan resolver. `research` may throw
 * RateLimitError (the run pauses/reschedules); site-level failures return
 * `unavailable` so the run continues on source data.
 */
export interface ResearchProvider {
  readonly name: string;
  readonly costPerRecord?: number;
  research(input: { websiteUrl?: string | null; normalizedDomain?: string | null }): Promise<ResearchOutcome>;
}

/**
 * Shared model-provider interface (MiniMax/OpenAI/Anthropic adapters arrive
 * M5). M0 keeps the registry EMPTY: a workflow with a generate step must still
 * complete, skipping generation with `model_provider_not_configured`.
 */
export interface ModelProvider {
  readonly name: string;
  generate(input: { template: string; evidence: Record<string, unknown> }): Promise<Record<string, unknown>>;
}

export interface ProviderRegistry {
  sources: Map<string, SourceProvider>;
  enrichers: Map<string, EnrichProvider>;
  researchers: Map<string, ResearchProvider>;
  models: Map<string, ModelProvider>;
}

export function emptyRegistry(): ProviderRegistry {
  return { sources: new Map(), enrichers: new Map(), researchers: new Map(), models: new Map() };
}
