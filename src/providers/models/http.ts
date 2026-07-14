import { setTimeout as sleep } from "node:timers/promises";

import { AppError, RateLimitError, RetryableProviderError } from "../../shared/errors.js";

/**
 * Shared HTTP plumbing for the model adapters (ADR-025/ADR-032): plain fetch,
 * serial min-interval limiter, whole-exchange timeout, and the shared error
 * taxonomy. Generation is FREE for engine credits, so nothing here is ever
 * ambiguous: timeouts and network failures are plain retryable errors.
 */
export interface ModelHttpOptions {
  vendor: string;
  maxRequestsPerMinute?: number;
  requestTimeoutMs?: number;
  defaultRetryAfterSeconds?: number;
  fetchImpl?: typeof fetch;
}

export class ModelHttp {
  private readonly vendor: string;
  private readonly minIntervalMs: number;
  private readonly timeoutMs: number;
  private readonly defaultRetryAfter: number;
  private readonly fetchImpl: typeof fetch;
  private lastRequestAt = 0;

  constructor(opts: ModelHttpOptions) {
    this.vendor = opts.vendor;
    this.minIntervalMs = Math.ceil(60_000 / Math.max(1, opts.maxRequestsPerMinute ?? 30));
    this.timeoutMs = opts.requestTimeoutMs ?? 60_000;
    this.defaultRetryAfter = opts.defaultRetryAfterSeconds ?? 30;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /** POST JSON, map transport failures to the taxonomy, return the parsed 200 body. */
  async postJson(url: string, headers: Record<string, string>, body: unknown): Promise<unknown> {
    const wait = this.lastRequestAt + this.minIntervalMs - Date.now();
    if (wait > 0) await sleep(wait);
    this.lastRequestAt = Date.now();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let status: number;
    let text: string;
    let retryAfter: number | null;
    try {
      const res = await this.fetchImpl(url, {
        method: "POST",
        signal: controller.signal,
        headers: { "content-type": "application/json", accept: "application/json", ...headers },
        body: JSON.stringify(body),
      });
      text = await res.text();
      status = res.status;
      const header = res.headers.get("retry-after");
      retryAfter = header && /^\d+$/.test(header.trim()) ? Number(header.trim()) : null;
    } catch (err) {
      // Timeout or network failure: generation charges no engine credits, so
      // this is retryable, never ambiguous. The key never appears in errors.
      const kind = err instanceof Error && err.name === "AbortError" ? "timed out" : "failed to send";
      throw new RetryableProviderError(`${this.vendor} request ${kind}.`, { charged: false, vendor: this.vendor });
    } finally {
      clearTimeout(timer);
    }

    if (status === 429) {
      throw new RateLimitError(`${this.vendor} rate limited the request.`, retryAfter ?? this.defaultRetryAfter, {
        vendor: this.vendor,
        status,
      });
    }
    if (status >= 500) {
      throw new RetryableProviderError(`${this.vendor} server error (${status}).`, { charged: false, status });
    }
    if (status !== 200) {
      throw new AppError("PROVIDER_ERROR", `${this.vendor} rejected the request (${status}): ${truncate(text)}`, {
        vendor: this.vendor,
        status,
      });
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new RetryableProviderError(`${this.vendor} returned non-JSON on 200.`, { charged: false });
    }
  }
}

function truncate(text: string): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  return cleaned.length > 200 ? `${cleaned.slice(0, 200)}…` : cleaned;
}
