import { setTimeout as sleep } from "node:timers/promises";

import { z } from "zod";

import { AmbiguousOutcomeError, AppError, RateLimitError, RetryableProviderError } from "../../shared/errors.js";

/**
 * Minimal typed client for Firecrawl's v2 scrape endpoint (ADR-025). Used only
 * for bounded business-website research (ADR-027) — Firecrawl's actual strength,
 * NOT for Google Maps discovery (that is SerpAPI, ADR-024). Plain fetch + Zod;
 * never logs the API key.
 */

const scrapeMetadataSchema = z
  .object({
    title: z.string().optional(),
    description: z.string().optional(),
    sourceURL: z.string().optional(),
    statusCode: z.number().optional(),
  })
  .passthrough();

const scrapeResponseSchema = z
  .object({
    success: z.boolean().optional(),
    error: z.string().optional(),
    data: z
      .object({ markdown: z.string().optional(), metadata: scrapeMetadataSchema.optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();

const creditUsageSchema = z
  .object({ data: z.object({ remainingCredits: z.number().optional() }).passthrough().optional() })
  .passthrough();

export interface FirecrawlClientOptions {
  apiKey: string;
  baseUrl?: string;
  maxRequestsPerMinute: number;
  requestTimeoutMs?: number;
  defaultRetryAfterSeconds?: number;
  costPerScrape?: number;
  fetchImpl?: typeof fetch;
}

export interface FirecrawlScrapeResult {
  markdown: string | null;
  title: string | null;
  description: string | null;
  sourceUrl: string | null;
  /** The TARGET SITE's HTTP status for the scraped page (404 pages scrape "successfully"). */
  statusCode: number | null;
}

export class FirecrawlClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly minIntervalMs: number;
  private readonly timeoutMs: number;
  private readonly defaultRetryAfter: number;
  private readonly costPerScrape: number;
  private readonly fetchImpl: typeof fetch;
  private lastRequestAt = 0;

  constructor(opts: FirecrawlClientOptions) {
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl ?? "https://api.firecrawl.dev";
    this.minIntervalMs = Math.ceil(60_000 / Math.max(1, opts.maxRequestsPerMinute));
    this.timeoutMs = opts.requestTimeoutMs ?? 60_000;
    this.defaultRetryAfter = opts.defaultRetryAfterSeconds ?? 30;
    this.costPerScrape = opts.costPerScrape ?? 1;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async scrape(args: { url: string }): Promise<FirecrawlScrapeResult> {
    const { status, text, retryAfter } = await this.request("/v2/scrape", "POST", {
      url: args.url,
      formats: ["markdown"],
      onlyMainContent: true,
    });
    this.mapStatus(status, text, retryAfter);

    const parsed = scrapeResponseSchema.safeParse(safeJson(text));
    if (!parsed.success) {
      throw new AmbiguousOutcomeError("Firecrawl returned an unreadable 200; outcome unconfirmed.", this.costPerScrape, {
        provider: "firecrawl",
      });
    }
    if (parsed.data.success === false || !parsed.data.data) {
      throw new AppError("PROVIDER_ERROR", `Firecrawl could not scrape the site: ${parsed.data.error ?? "unknown"}`, {
        provider: "firecrawl",
      });
    }
    const data = parsed.data.data;
    return {
      markdown: data.markdown ?? null,
      title: data.metadata?.title ?? null,
      description: data.metadata?.description ?? null,
      sourceUrl: data.metadata?.sourceURL ?? args.url,
      statusCode: data.metadata?.statusCode ?? null,
    };
  }

  /** Zero-scrape connection/credit check for the provider-setup UI. */
  async creditUsage(): Promise<{ remainingCredits: number | null }> {
    const { status, text } = await this.request("/v2/team/credit-usage", "GET");
    if (status !== 200) {
      throw new AppError("PROVIDER_ERROR", `Firecrawl credit check failed (${status}).`, { provider: "firecrawl", status });
    }
    const parsed = creditUsageSchema.safeParse(safeJson(text));
    return { remainingCredits: parsed.success ? parsed.data.data?.remainingCredits ?? null : null };
  }

  private mapStatus(status: number, text: string, retryAfter: number | null): void {
    if (status === 200) return;
    if (status === 429) {
      throw new RateLimitError("Firecrawl rate limit exceeded.", retryAfter ?? this.defaultRetryAfter, {
        provider: "firecrawl",
        status,
      });
    }
    if (status === 402) {
      throw new AppError("PROVIDER_ERROR", "Firecrawl account is out of credits.", { provider: "firecrawl", status });
    }
    if (status === 401 || status === 403) {
      throw new AppError("PROVIDER_ERROR", `Firecrawl rejected the request (${status}).`, { provider: "firecrawl", status });
    }
    if (status >= 500) {
      throw new RetryableProviderError(`Firecrawl server error (${status}).`, { charged: false, status });
    }
    // 4xx site errors (400/404/etc.) — surface as a provider error the caller maps to unavailable.
    throw new AppError("PROVIDER_ERROR", `Firecrawl scrape failed (${status}): ${errorMessage(text)}`, {
      provider: "firecrawl",
      status,
    });
  }

  private async request(
    urlPath: string,
    method: "GET" | "POST",
    body?: Record<string, unknown>,
  ): Promise<{ status: number; text: string; retryAfter: number | null }> {
    const wait = this.lastRequestAt + this.minIntervalMs - Date.now();
    if (wait > 0) await sleep(wait);
    this.lastRequestAt = Date.now();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      // The timeout covers the WHOLE exchange including the body read: a
      // stalled body would otherwise hang the run holding its lease.
      const res = await this.fetchImpl(`${this.baseUrl}${urlPath}`, {
        method,
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          accept: "application/json",
          ...(body ? { "content-type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const text = await res.text();
      const header = res.headers.get("retry-after");
      const retryAfter = header && /^\d+$/.test(header.trim()) ? Number(header.trim()) : null;
      return { status: res.status, text, retryAfter };
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new AmbiguousOutcomeError("Firecrawl request timed out; outcome unconfirmed.", this.costPerScrape, {
          provider: "firecrawl",
        });
      }
      throw new RetryableProviderError(
        `Firecrawl network error: ${err instanceof Error ? err.message : String(err)}`,
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
