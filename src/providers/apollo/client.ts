import { setTimeout as sleep } from "node:timers/promises";

import { z } from "zod";

import { AmbiguousOutcomeError, AppError, RateLimitError, RetryableProviderError } from "../../shared/errors.js";

/**
 * Minimal typed client for Apollo's REST API (ADR-014/ADR-028). Plain fetch +
 * Zod (ADR-025): two documented endpoints, strict validation, no SDK retry
 * semantics to audit. The key travels ONLY in the X-Api-Key header — never in
 * a URL, log line, or error detail. Apollo MCP is prototyping-only and is
 * never called from production paths.
 *
 * Endpoints (a MASTER API key is required for people search):
 * - POST /api/v1/mixed_people/api_search — people search. FREE (no credits),
 *   returns NO emails/phones. The legacy /mixed_people/search endpoint 403s
 *   on Basic plans and is never used.
 * - POST /api/v1/people/match — person enrichment. Consumes ~1 credit when
 *   data is returned. reveal_personal_emails is ALWAYS false;
 *   reveal_phone_number is NEVER sent (it requires Apollo's async webhook
 *   flow — deferred to M5).
 * - GET  /api/v1/auth/health — zero-cost key check for the provider-setup UI.
 *
 * Paid-call idempotency contract (docs/architecture.md §"Idempotency and
 * paid-provider safety"), per endpoint:
 *
 * mixed_people/api_search (free):
 * 1. Idempotency key: none accepted.
 * 2. Stable request id: none in the response; the engine's request_key is
 *    stored as the provider_request_id fallback.
 * 3. Ambiguous outcomes reconcilable: moot — search consumes no credits.
 * 4. Failures consume credits: never.
 * 5. Retryable: network, 5xx, AND timeouts/malformed 200s (deliberate
 *    divergence from paid clients, justified by zero cost) →
 *    RetryableProviderError{charged:false}. 429 → RateLimitError (durable
 *    pause; the attempt is not counted).
 * 6. needs_review outcomes: none.
 *
 * people/match (paid):
 * 1. Idempotency key: none accepted.
 * 2. Stable request id: none; the matched person.id is recorded on
 *    lead_sources; provider_request_id falls back to the engine request_key.
 * 3. Ambiguous outcomes reconcilable: NO automatic reconciliation (Apollo has
 *    no per-request ledger API) — manual review against the Apollo dashboard.
 * 4. Failures consume credits: clean 4xx/5xx and no-data responses do not;
 *    a timeout/malformed 200 MAY have (charged if Apollo completed).
 * 5. Retryable: 5xx / network-before-send → RetryableProviderError
 *    {charged:false}; 429 → RateLimitError; 401/402/403 (key, plan, or
 *    credits) → AppError PROVIDER_ERROR (operator action).
 * 6. needs_review: timeout or malformed 200 → AmbiguousOutcomeError
 *    (possibleCost = costPerEnrichment); the runner also books any crash
 *    replay of an interrupted paid attempt as ambiguous (the adapter declares
 *    idempotentReplay:false) — a possibly-completed paid call is NEVER
 *    auto-retried.
 */

export const apolloOrganizationSchema = z
  .object({
    id: z.string().optional(),
    name: z.string().optional(),
    website_url: z.string().nullish(),
    primary_domain: z.string().nullish(),
  })
  .passthrough();

export const apolloPersonSchema = z
  .object({
    id: z.string(),
    first_name: z.string().nullish(),
    last_name: z.string().nullish(),
    name: z.string().nullish(),
    title: z.string().nullish(),
    linkedin_url: z.string().nullish(),
    email: z.string().nullish(),
    email_status: z.string().nullish(),
    city: z.string().nullish(),
    state: z.string().nullish(),
    country: z.string().nullish(),
    organization: apolloOrganizationSchema.nullish(),
  })
  .passthrough();
export type ApolloPerson = z.infer<typeof apolloPersonSchema>;

// People are validated PER ITEM by the adapter (apolloPersonSchema): one
// malformed hit must not fail the whole response.
export const apolloSearchResponseSchema = z
  .object({
    people: z.array(z.unknown()).optional(),
    contacts: z.array(z.unknown()).optional(),
    pagination: z
      .object({
        page: z.number().optional(),
        per_page: z.number().optional(),
        total_entries: z.number().optional(),
        total_pages: z.number().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();
export type ApolloSearchResponse = z.infer<typeof apolloSearchResponseSchema>;

export const apolloMatchResponseSchema = z
  .object({ person: z.unknown().nullish() })
  .passthrough();
export type ApolloMatchResponse = z.infer<typeof apolloMatchResponseSchema>;

const apolloHealthSchema = z.object({ is_logged_in: z.boolean().optional() }).passthrough();

export interface ApolloClientOptions {
  apiKey: string;
  baseUrl?: string;
  maxRequestsPerMinute: number;
  requestTimeoutMs?: number;
  /** Fallback when a 429 carries no rate-limit header. */
  defaultRetryAfterSeconds?: number;
  /** Provisional cost booked for an unconfirmable (ambiguous) enrichment. */
  costPerEnrichment?: number;
  fetchImpl?: typeof fetch;
}

export interface ApolloSearchParams {
  personTitles?: string[];
  personLocations?: string[];
  qKeywords?: string;
  page: number;
  perPage: number;
}

export interface ApolloMatchParams {
  apolloPersonId?: string | null;
  linkedinUrl?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  name?: string | null;
  organizationName?: string | null;
  domain?: string | null;
  email?: string | null;
}

export class ApolloClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly minIntervalMs: number;
  private readonly timeoutMs: number;
  private readonly defaultRetryAfter: number;
  readonly costPerEnrichment: number;
  private readonly fetchImpl: typeof fetch;
  private lastRequestAt = 0;

  constructor(opts: ApolloClientOptions) {
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl ?? "https://api.apollo.io";
    this.minIntervalMs = Math.ceil(60_000 / Math.max(1, opts.maxRequestsPerMinute));
    this.timeoutMs = opts.requestTimeoutMs ?? 30_000;
    this.defaultRetryAfter = opts.defaultRetryAfterSeconds ?? 60;
    this.costPerEnrichment = opts.costPerEnrichment ?? 1;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /** FREE people search (no credits, no contact data). Master API key required. */
  async searchPeople(params: ApolloSearchParams): Promise<ApolloSearchResponse> {
    const body: Record<string, unknown> = {
      page: params.page,
      per_page: params.perPage,
    };
    if (params.personTitles && params.personTitles.length > 0) body["person_titles"] = params.personTitles;
    if (params.personLocations && params.personLocations.length > 0) body["person_locations"] = params.personLocations;
    if (params.qKeywords) body["q_keywords"] = params.qKeywords;

    const { status, text, retryAfter } = await this.request("/api/v1/mixed_people/api_search", body, {
      // Search is credit-free: an unconfirmed outcome costs nothing, so even
      // timeouts stay retryable instead of ambiguous.
      ambiguousOnUnconfirmed: false,
    });
    this.throwForStatus("people search", status, text, retryAfter);

    const parsed = apolloSearchResponseSchema.safeParse(safeJson(text));
    if (!parsed.success) {
      throw new RetryableProviderError("Apollo search returned an unrecognized 200 response; retrying is free.", {
        charged: false,
        provider: "apollo",
      });
    }
    return parsed.data;
  }

  /**
   * PAID person enrichment (~1 credit when data is returned). Personal-email
   * reveal stays off; phone reveal (webhook-only) is never requested.
   */
  async matchPerson(params: ApolloMatchParams): Promise<ApolloMatchResponse> {
    const body: Record<string, unknown> = { reveal_personal_emails: false };
    if (params.apolloPersonId) body["id"] = params.apolloPersonId;
    if (params.linkedinUrl) body["linkedin_url"] = params.linkedinUrl;
    if (params.firstName) body["first_name"] = params.firstName;
    if (params.lastName) body["last_name"] = params.lastName;
    if (params.name) body["name"] = params.name;
    if (params.organizationName) body["organization_name"] = params.organizationName;
    if (params.domain) body["domain"] = params.domain;
    if (params.email) body["email"] = params.email;

    const { status, text, retryAfter } = await this.request("/api/v1/people/match", body, {
      ambiguousOnUnconfirmed: true,
    });
    this.throwForStatus("person enrichment", status, text, retryAfter);

    const parsed = apolloMatchResponseSchema.safeParse(safeJson(text));
    if (!parsed.success) {
      throw new AmbiguousOutcomeError(
        "Apollo enrichment returned an unrecognized 200 response; the credit outcome is unconfirmed.",
        this.costPerEnrichment,
        { provider: "apollo" },
      );
    }
    return parsed.data;
  }

  /** Zero-cost key check for the provider-setup UI. */
  async healthCheck(): Promise<{ ok: boolean }> {
    const { status, text } = await this.request("/api/v1/auth/health", null, { ambiguousOnUnconfirmed: false });
    if (status !== 200) {
      throw new AppError("PROVIDER_ERROR", `Apollo key check failed (${status}): ${errorMessage(text)}`, {
        provider: "apollo",
        status,
      });
    }
    const parsed = apolloHealthSchema.safeParse(safeJson(text));
    return { ok: parsed.success && parsed.data.is_logged_in !== false };
  }

  private throwForStatus(operation: string, status: number, text: string, retryAfter: number | null): void {
    if (status === 200) return;
    if (status === 429) {
      // A daily/24h-window exhaustion needs a long pause, not a minute-window one.
      const daily = /daily|24.?hour|per day/i.test(text);
      const wait = retryAfter ?? this.defaultRetryAfter;
      throw new RateLimitError(
        `Apollo rate limit exceeded on ${operation}${daily ? " (daily window)" : ""}.`,
        daily ? Math.max(3600, wait) : wait,
        { provider: "apollo", status },
      );
    }
    if (status === 401 || status === 402 || status === 403 || status === 422) {
      // Key/plan/credit/config problems need an operator, not a retry. 403 on
      // people search usually means a non-master key or an insufficient plan.
      throw new AppError("PROVIDER_ERROR", `Apollo rejected the ${operation} request (${status}): ${errorMessage(text)}`, {
        provider: "apollo",
        status,
      });
    }
    if (status >= 500 || status !== 200) {
      throw new RetryableProviderError(`Apollo server error (${status}) on ${operation}.`, {
        charged: false,
        provider: "apollo",
        status,
      });
    }
  }

  private async request(
    path: string,
    body: Record<string, unknown> | null,
    opts: { ambiguousOnUnconfirmed: boolean },
  ): Promise<{ status: number; text: string; retryAfter: number | null }> {
    const wait = this.lastRequestAt + this.minIntervalMs - Date.now();
    if (wait > 0) await sleep(wait);
    this.lastRequestAt = Date.now();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      // The timeout covers the WHOLE exchange including the body read: a
      // stalled body would otherwise hang the run holding its lease.
      const res = await this.fetchImpl(new URL(path, this.baseUrl).toString(), {
        method: body === null ? "GET" : "POST",
        signal: controller.signal,
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "x-api-key": this.apiKey,
        },
        ...(body === null ? {} : { body: JSON.stringify(body) }),
      });
      const text = await res.text();
      const header = res.headers.get("retry-after") ?? res.headers.get("x-rate-limit-reset");
      const retryAfter = header && /^\d+$/.test(header.trim()) ? Number(header.trim()) : null;
      return { status: res.status, text, retryAfter };
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        if (opts.ambiguousOnUnconfirmed) {
          // Timed out on our side; Apollo may have matched (and charged).
          throw new AmbiguousOutcomeError("Apollo request timed out; the credit outcome is unconfirmed.", this.costPerEnrichment, {
            provider: "apollo",
          });
        }
        throw new RetryableProviderError("Apollo request timed out; retrying is free for this endpoint.", {
          charged: false,
          provider: "apollo",
        });
      }
      throw new RetryableProviderError(
        `Apollo network error: ${err instanceof Error ? err.message : String(err)}`,
        { charged: false, provider: "apollo" },
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function errorMessage(text: string): string {
  const parsed = safeJson(text) as { error?: unknown; message?: unknown } | null;
  const err = parsed?.error ?? parsed?.message;
  return typeof err === "string" ? err.slice(0, 200) : text.slice(0, 120);
}
