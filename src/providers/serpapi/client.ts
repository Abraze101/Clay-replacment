import { setTimeout as sleep } from "node:timers/promises";

import { z } from "zod";

import { AmbiguousOutcomeError, AppError, RateLimitError, RetryableProviderError } from "../../shared/errors.js";

/**
 * Minimal typed client for SerpAPI's Google Maps engine. Plain fetch + Zod
 * (ADR-025): one documented endpoint, strict validation, no SDK retry semantics
 * to audit. The client never logs the API key or full result bodies.
 *
 * Error mapping (SerpAPI overloads 429; billing is only-successful-searches):
 * - 429 "out of searches"       -> non-retryable PROVIDER_ERROR (operator tops up)
 * - 429 throughput              -> RateLimitError(retryAfter) — not a spent attempt
 * - 400/401/402/403             -> non-retryable PROVIDER_ERROR (config/quota)
 * - 5xx / network before send   -> RetryableProviderError{charged:false} (not billed)
 * - timeout / malformed 200     -> AmbiguousOutcomeError (may be billed; unconfirmed)
 * - 200 (incl. empty results)   -> parsed response (empty is a charged success)
 */

const gpsSchema = z.object({ latitude: z.number(), longitude: z.number() }).partial();

export const serpApiLocalResultSchema = z
  .object({
    position: z.number().optional(),
    title: z.string(),
    place_id: z.string().optional(),
    data_id: z.string().optional(),
    data_cid: z.string().optional(),
    type: z.string().optional(),
    types: z.array(z.string()).optional(),
    address: z.string().optional(),
    phone: z.string().optional(),
    website: z.string().optional(),
    rating: z.number().optional(),
    reviews: z.number().optional(),
    gps_coordinates: gpsSchema.optional(),
  })
  .passthrough();
export type SerpApiLocalResult = z.infer<typeof serpApiLocalResultSchema>;

// Listings are validated PER ITEM by the adapter (serpApiLocalResultSchema):
// one malformed listing must not fail the whole — already charged — response.
export const serpApiMapsResponseSchema = z
  .object({
    search_metadata: z.object({ id: z.string().optional(), status: z.string().optional() }).passthrough().optional(),
    search_information: z.record(z.string(), z.unknown()).optional(),
    local_results: z.array(z.unknown()).optional(),
    /** Single-place answer shape (very specific queries) — same fields, not an array. */
    place_results: z.record(z.string(), z.unknown()).optional(),
    serpapi_pagination: z.object({ next: z.string().optional() }).passthrough().optional(),
    error: z.string().optional(),
  })
  .passthrough();
export type SerpApiMapsResponse = z.infer<typeof serpApiMapsResponseSchema>;

const serpApiAccountSchema = z
  .object({
    plan_searches_left: z.number().optional(),
    total_searches_left: z.number().optional(),
    this_month_usage: z.number().optional(),
  })
  .passthrough();

export interface SerpApiClientOptions {
  apiKey: string;
  baseUrl?: string;
  maxRequestsPerMinute: number;
  requestTimeoutMs?: number;
  /** Fallback when a 429 carries no Retry-After header (SerpAPI does not send one). */
  defaultRetryAfterSeconds?: number;
  /** Provisional cost booked for an unconfirmable (ambiguous) outcome. */
  costPerSearch?: number;
  fetchImpl?: typeof fetch;
}

export interface SerpApiMapsQuery {
  q: string;
  ll?: string;
  start?: number;
  hl?: string;
  gl?: string;
}

export class SerpApiClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly minIntervalMs: number;
  private readonly timeoutMs: number;
  private readonly defaultRetryAfter: number;
  private readonly costPerSearch: number;
  private readonly fetchImpl: typeof fetch;
  private lastRequestAt = 0;

  constructor(opts: SerpApiClientOptions) {
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl ?? "https://serpapi.com";
    this.minIntervalMs = Math.ceil(60_000 / Math.max(1, opts.maxRequestsPerMinute));
    this.timeoutMs = opts.requestTimeoutMs ?? 30_000;
    this.defaultRetryAfter = opts.defaultRetryAfterSeconds ?? 60;
    this.costPerSearch = opts.costPerSearch ?? 1;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async searchMaps(query: SerpApiMapsQuery): Promise<SerpApiMapsResponse> {
    const url = new URL("/search", this.baseUrl);
    url.searchParams.set("engine", "google_maps");
    url.searchParams.set("type", "search");
    url.searchParams.set("q", query.q);
    if (query.ll) url.searchParams.set("ll", query.ll);
    if (query.start !== undefined) url.searchParams.set("start", String(query.start));
    url.searchParams.set("hl", query.hl ?? "en");
    url.searchParams.set("gl", query.gl ?? "us");
    url.searchParams.set("api_key", this.apiKey);

    const { status, text, retryAfter } = await this.request(url);

    if (status === 429) {
      if (/out of searches|run out of searches/i.test(text)) {
        throw new AppError("PROVIDER_ERROR", "SerpAPI account is out of searches; top up the plan before retrying.", {
          provider: "serpapi",
          status,
        });
      }
      throw new RateLimitError("SerpAPI hourly throughput exceeded.", retryAfter ?? this.defaultRetryAfter, {
        provider: "serpapi",
        status,
      });
    }
    if (status === 400 || status === 401 || status === 402 || status === 403) {
      throw new AppError("PROVIDER_ERROR", `SerpAPI rejected the request (${status}): ${errorMessage(text)}`, {
        provider: "serpapi",
        status,
      });
    }
    if (status >= 500 || status !== 200) {
      throw new RetryableProviderError(`SerpAPI server error (${status}).`, { charged: false, status });
    }

    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new AmbiguousOutcomeError("SerpAPI returned non-JSON on 200; outcome unconfirmed.", this.costPerSearch, {
        provider: "serpapi",
      });
    }
    const parsed = serpApiMapsResponseSchema.safeParse(json);
    if (!parsed.success) {
      throw new AmbiguousOutcomeError("SerpAPI response failed schema validation; outcome unconfirmed.", this.costPerSearch, {
        provider: "serpapi",
      });
    }
    return parsed.data;
  }

  /** Zero-search connection/credit check for the provider-setup UI. */
  async creditUsage(): Promise<{ totalSearchesLeft: number | null }> {
    const url = new URL("/account", this.baseUrl);
    url.searchParams.set("api_key", this.apiKey);
    const { status, text } = await this.request(url);
    if (status !== 200) {
      throw new AppError("PROVIDER_ERROR", `SerpAPI account check failed (${status}).`, { provider: "serpapi", status });
    }
    const parsed = serpApiAccountSchema.safeParse(safeJson(text));
    const left = parsed.success ? parsed.data.total_searches_left ?? parsed.data.plan_searches_left ?? null : null;
    return { totalSearchesLeft: left };
  }

  private async request(url: URL): Promise<{ status: number; text: string; retryAfter: number | null }> {
    const wait = this.lastRequestAt + this.minIntervalMs - Date.now();
    if (wait > 0) await sleep(wait);
    this.lastRequestAt = Date.now();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      // The timeout covers the WHOLE exchange including the body read: a
      // stalled body would otherwise hang the run holding its lease.
      const res = await this.fetchImpl(url.toString(), {
        method: "GET",
        signal: controller.signal,
        headers: { accept: "application/json" },
      });
      const text = await res.text();
      const header = res.headers.get("retry-after");
      const retryAfter = header && /^\d+$/.test(header.trim()) ? Number(header.trim()) : null;
      return { status: res.status, text, retryAfter };
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        // Timed out on our side; SerpAPI may have processed (and billed) it.
        throw new AmbiguousOutcomeError("SerpAPI request timed out; outcome unconfirmed.", this.costPerSearch, {
          provider: "serpapi",
        });
      }
      throw new RetryableProviderError(
        `SerpAPI network error: ${err instanceof Error ? err.message : String(err)}`,
        { charged: false },
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
  const err = (safeJson(text) as { error?: unknown } | null)?.error;
  return typeof err === "string" ? err.slice(0, 200) : text.slice(0, 120);
}
