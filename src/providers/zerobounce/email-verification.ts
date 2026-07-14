import { z } from "zod";

import { AmbiguousOutcomeError, AppError, RateLimitError, RetryableProviderError } from "../../shared/errors.js";
import type {
  EmailVerificationProvider,
  EmailVerificationRequest,
  EmailVerificationResult,
  EmailVerificationStatus,
} from "../capabilities.js";
import { safeJsonParse, VendorHttp, VendorTransportError } from "../vendor-http.js";

/**
 * ZeroBounce v2 → EmailVerificationProvider (ADR-010 candidate; ADR-030).
 * GET /v2/validate; zero-cost key check GET /v2/getcredits.
 *
 * Paid-call contract: no idempotency key, no stable request id (requestKey is
 * the recorded fallback; idempotentReplay:false). 1 credit per verification;
 * 'unknown' results are NOT charged (vendor refund policy) → costOnUnknown 0.
 * In-body {"error": …} (invalid key / out of credits) → PROVIDER_ERROR.
 * 429 → RateLimitError; 5xx/network → RetryableProviderError{charged:false};
 * timeout / malformed 200 → AmbiguousOutcomeError(1) → needs_review
 * (reconcile against the dashboard / getcredits delta).
 *
 * The API key travels in the query string: URLs never appear in errors.
 */
const validateResponseSchema = z
  .object({
    address: z.string().optional(),
    status: z.string().optional(),
    sub_status: z.string().nullable().optional(),
    error: z.string().optional(),
  })
  .passthrough();

export interface ZeroBounceOptions {
  apiKey: string;
  baseUrl?: string;
  maxRequestsPerMinute?: number;
  requestTimeoutMs?: number;
  defaultRetryAfterSeconds?: number;
  fetchImpl?: typeof fetch;
}

export class ZeroBounceEmailVerification implements EmailVerificationProvider {
  readonly name = "zerobounce";
  readonly costPerRecord = 1;
  readonly costOnUnknown = 0;
  readonly idempotentReplay = false;

  private readonly http: VendorHttp;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly defaultRetryAfter: number;

  constructor(opts: ZeroBounceOptions) {
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl ?? "https://api.zerobounce.net";
    this.defaultRetryAfter = opts.defaultRetryAfterSeconds ?? 30;
    this.http = new VendorHttp({ vendor: "zerobounce", ...opts });
  }

  async verify(request: EmailVerificationRequest): Promise<EmailVerificationResult> {
    const url = new URL("/v2/validate", this.baseUrl);
    url.searchParams.set("api_key", this.apiKey);
    url.searchParams.set("email", request.email);
    url.searchParams.set("ip_address", "");

    let res;
    try {
      res = await this.http.request(url.toString());
    } catch (err) {
      if (err instanceof VendorTransportError && err.kind === "timeout") {
        throw new AmbiguousOutcomeError("ZeroBounce verification timed out; outcome unconfirmed.", this.costPerRecord, {
          provider: this.name,
        });
      }
      throw new RetryableProviderError("ZeroBounce request failed to send.", { charged: false });
    }
    if (res.status === 429) {
      throw new RateLimitError("ZeroBounce rate limited.", res.retryAfter ?? this.defaultRetryAfter, { provider: this.name });
    }
    if (res.status >= 500) {
      throw new RetryableProviderError(`ZeroBounce server error (${res.status}).`, { charged: false, status: res.status });
    }
    if (res.status !== 200) {
      throw new AppError("PROVIDER_ERROR", `ZeroBounce rejected the request (${res.status}).`, {
        provider: this.name,
        status: res.status,
      });
    }
    const parsed = validateResponseSchema.safeParse(safeJsonParse(res.text));
    if (!parsed.success) {
      throw new AmbiguousOutcomeError("ZeroBounce returned an unrecognized 200 body; outcome unconfirmed.", this.costPerRecord, {
        provider: this.name,
      });
    }
    if (parsed.data.error) {
      // Invalid key / out of credits arrive in-body; the message is vendor
      // prose and safe (never the key).
      throw new AppError("PROVIDER_ERROR", `ZeroBounce error: ${parsed.data.error}`, { provider: this.name });
    }

    const { status, subStatus } = mapStatus(parsed.data.status ?? "", parsed.data.sub_status ?? null);
    return {
      status,
      ...(subStatus ? { subStatus } : {}),
      raw: { status: parsed.data.status ?? null, subStatus: parsed.data.sub_status ?? null },
      cost: status === "unknown" ? this.costOnUnknown : this.costPerRecord,
      providerRequestId: request.requestKey,
    };
  }

  /** Zero-cost key/credit check for the provider-setup screen. */
  async creditUsage(): Promise<{ creditsLeft: number | null }> {
    const url = new URL("/v2/getcredits", this.baseUrl);
    url.searchParams.set("api_key", this.apiKey);
    const res = await this.http.request(url.toString());
    if (res.status !== 200) {
      throw new AppError("PROVIDER_ERROR", `ZeroBounce credit check failed (${res.status}).`, { provider: this.name });
    }
    const json = safeJsonParse(res.text) as { Credits?: string | number } | undefined;
    const credits = json?.Credits !== undefined ? Number(json.Credits) : null;
    return { creditsLeft: credits !== null && Number.isFinite(credits) ? credits : null };
  }
}

function mapStatus(status: string, subStatus: string | null): { status: EmailVerificationStatus; subStatus?: string } {
  switch (status) {
    case "valid":
      return { status: "valid" };
    case "invalid":
      return { status: "invalid", ...(subStatus ? { subStatus } : {}) };
    case "catch-all":
      return { status: "catch_all" };
    case "unknown":
      return { status: "unknown", ...(subStatus ? { subStatus } : {}) };
    case "spamtrap":
    case "abuse":
      return { status: "invalid", subStatus: status };
    case "do_not_mail":
      return subStatus === "role_based" || subStatus === "role_based_catch_all"
        ? { status: "role_based", subStatus }
        : { status: "invalid", subStatus: subStatus ?? "do_not_mail" };
    default:
      return { status: "unknown", subStatus: status || "unrecognized" };
  }
}
