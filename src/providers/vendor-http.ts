import { setTimeout as sleep } from "node:timers/promises";

/**
 * Transport plumbing shared by the M5 capability vendor clients (ADR-025/030):
 * plain fetch, serial min-interval limiter (ADR-026), whole-exchange timeout.
 * It deliberately maps NOTHING to the error taxonomy — charged/uncharged/
 * ambiguous classification is per-vendor, per-endpoint (a poll timeout is
 * retryable while a paid-submit timeout is ambiguous), so callers translate
 * `VendorTransportError` and status codes under their own documented contract.
 *
 * Secret hygiene: neither URLs nor bodies ever appear in thrown errors —
 * several vendors (ZeroBounce, MillionVerifier, BetterContact) carry the API
 * key in the query string.
 */
export class VendorTransportError extends Error {
  readonly kind: "timeout" | "network";

  constructor(vendor: string, kind: "timeout" | "network") {
    super(`${vendor} request ${kind === "timeout" ? "timed out" : "failed to send"}.`);
    this.name = "VendorTransportError";
    this.kind = kind;
  }
}

export interface VendorHttpOptions {
  vendor: string;
  maxRequestsPerMinute?: number;
  requestTimeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface VendorResponse {
  status: number;
  text: string;
  retryAfter: number | null;
}

export class VendorHttp {
  readonly vendor: string;
  private readonly minIntervalMs: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private lastRequestAt = 0;

  constructor(opts: VendorHttpOptions) {
    this.vendor = opts.vendor;
    this.minIntervalMs = Math.ceil(60_000 / Math.max(1, opts.maxRequestsPerMinute ?? 30));
    this.timeoutMs = opts.requestTimeoutMs ?? 30_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async request(
    url: string,
    init: { method?: "GET" | "POST"; headers?: Record<string, string>; body?: unknown } = {},
  ): Promise<VendorResponse> {
    const wait = this.lastRequestAt + this.minIntervalMs - Date.now();
    if (wait > 0) await sleep(wait);
    this.lastRequestAt = Date.now();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(url, {
        method: init.method ?? "GET",
        signal: controller.signal,
        headers: {
          accept: "application/json",
          ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
          ...init.headers,
        },
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      });
      const text = await res.text();
      const header = res.headers.get("retry-after");
      const retryAfter = header && /^\d+$/.test(header.trim()) ? Number(header.trim()) : null;
      return { status: res.status, text, retryAfter };
    } catch (err) {
      throw new VendorTransportError(this.vendor, err instanceof Error && err.name === "AbortError" ? "timeout" : "network");
    } finally {
      clearTimeout(timer);
    }
  }
}

export function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
