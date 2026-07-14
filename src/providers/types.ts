/**
 * Provider-neutral interfaces. Workflow definitions reference providers by
 * name; the registry resolves them. Nothing here is specific to any vendor —
 * M0 registers only fake implementations.
 */
import type {
  ContactDiscoveryProvider,
  EmailVerificationProvider,
  PhoneValidationProvider,
} from "./capabilities.js";
import type { ModelProvider } from "./models/types.js";

export * from "./capabilities.js";

/** Structured person hit from a professional-contact search (M4/Apollo). */
export interface SourcePersonFields {
  firstName?: string;
  lastName?: string;
  apolloPersonId?: string;
  employer?: {
    name?: string;
    websiteUrl?: string;
    domain?: string;
    apolloOrganizationId?: string;
  };
}

export interface SourceRecord {
  /** Stable provider-scoped identifier (survives pagination and re-fetch). */
  sourceKey: string;
  name: string;
  /** Lead kind this record becomes; defaults to "business". */
  kind?: "business" | "person";
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
  /**
   * M4 contact/person extensions. Only IMPORTED rows may carry an email —
   * search providers never fabricate contact data (Apollo search returns none).
   * A linkedinUrl comes from an approved source only (Apollo or import).
   */
  email?: string;
  linkedinUrl?: string;
  /** Unstructured contact name from an imported row. */
  contactName?: string;
  title?: string;
  person?: SourcePersonFields;
}

/**
 * One imported-list row after engine-side validation (bounded, typed). The
 * Zod schema lives in src/engine/import/csv-import.ts; this is the neutral
 * shape carried through SourceQuery/workflow inputs.
 */
export interface ImportRow {
  name?: string;
  website?: string;
  phone?: string;
  email?: string;
  linkedinUrl?: string;
  contactName?: string;
  title?: string;
  address?: string;
  locality?: string;
  region?: string;
  country?: string;
}

export interface SourceQuery {
  businessType?: string;
  locations?: string[];
  limit: number;
  /** Professional-contact searches (M4): job titles to match. */
  personTitles?: string[];
  /** Imported-list runs (M4): validated rows from the run inputs. */
  importRows?: ImportRow[];
  /**
   * Selected-lead continuation (M5): re-emit the prior run's approved leads
   * from the database instead of calling any provider. Free by construction;
   * the lead-id set is bound into the approval plan hash at preview.
   */
  continuation?: { runId: string; leadIds: string[] };
}

/** Free discovery of candidate businesses/people. */
export interface SourceProvider {
  readonly name: string;
  /** Optional pre-run input validation (e.g. imported-list requires rows). Throws AppError VALIDATION_FAILED. */
  validateQuery?(query: SourceQuery): void;
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
  /** M4 person-lead extensions; a person-aware enricher prefers stable ids over name matching. */
  kind?: "business" | "person";
  firstName?: string | null;
  lastName?: string | null;
  title?: string | null;
  apolloPersonId?: string | null;
  normalizedLinkedinUrl?: string | null;
  employerName?: string | null;
  employerDomain?: string | null;
}

export interface EnrichPerson {
  firstName: string;
  lastName: string;
  title: string;
  directPhone?: string;
  workEmail?: string;
  /** M4 identity backfill: stable ids the match revealed (approved sources only). */
  apolloPersonId?: string;
  apolloOrganizationId?: string;
  linkedinUrl?: string;
  /**
   * The provider's OWN claim about the email's status (e.g. Apollo
   * email_status). Stored as data on the contact point, never as our
   * verification judgment — the engine keeps email_status='not_checked'.
   */
  emailStatusClaim?: string;
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
  /**
   * True when replaying a stored requestKey provably cannot double-charge
   * (the fake provider's persisted ledger). Adapters without provider-side
   * idempotency (Apollo) set false: the runner books a crash-replay of an
   * interrupted paid attempt as ambiguous → needs_review instead of
   * re-calling the provider.
   */
  readonly idempotentReplay?: boolean;
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
 * Shared model-provider interface (M5, ADR-032) — see models/types.ts. The
 * registry stays EMPTY unless a model provider is configured: a workflow with
 * a generate step must still complete, skipping generation with
 * `model_provider_not_configured`.
 */
export type { ModelProvider } from "./models/types.js";
export * from "./models/types.js";

export interface ProviderRegistry {
  sources: Map<string, SourceProvider>;
  enrichers: Map<string, EnrichProvider>;
  researchers: Map<string, ResearchProvider>;
  models: Map<string, ModelProvider>;
  /** M5 contact-enrichment capabilities. Each map holds the configured provider(s) for that capability. */
  phoneValidation: Map<string, PhoneValidationProvider>;
  emailVerification: Map<string, EmailVerificationProvider>;
  contactDiscovery: Map<string, ContactDiscoveryProvider>;
}

export function emptyRegistry(): ProviderRegistry {
  return {
    sources: new Map(),
    enrichers: new Map(),
    researchers: new Map(),
    models: new Map(),
    phoneValidation: new Map(),
    emailVerification: new Map(),
    contactDiscovery: new Map(),
  };
}
