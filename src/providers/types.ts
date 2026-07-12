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

/** Free, bounded public-website research. */
export interface ResearchProvider {
  readonly name: string;
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
