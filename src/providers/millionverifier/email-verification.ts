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
 * MillionVerifier v3 → EmailVerificationProvider (ADR-010 candidate; ADR-030).
 * GET /api/v3/?api=…&email=…&timeout=… — the VENDOR-side timeout is set below
 * our client timeout by design, so a slow SMTP conversation returns a
 * definitive, uncharged 'unknown' instead of an ambiguous socket timeout
 * (structurally lowers the ambiguity rate).
 *
 * Paid-call contract: no idempotency key / stable request id (requestKey
 * fallback; idempotentReplay:false). 1 credit per verification; unknowns
 * refunded → costOnUnknown 0. Non-empty in-body `error` → PROVIDER_ERROR.
 * 429 → RateLimitError; 5xx/network → RetryableProviderError{charged:false};
 * client timeout / malformed 200 → AmbiguousOutcomeError(1) (rare given the
 * vendor-timeout design). Key in query string → URLs never appear in errors.
 */
const verifyResponseSchema = z
  .object({
    email: z.string().optional(),
    result: z.string().optional(),
    subresult: z.string().nullable().optional(),
    role: z.boolean().optional(),
    error: z.string().optional(),
  })
  .passthrough();

export interface MillionVerifierOptions {
  apiKey: string;
  baseUrl?: string;
  maxRequestsPerMinute?: number;
  requestTimeoutMs?: number;
  defaultRetryAfterSeconds?: number;
  vendorTimeoutSeconds?: number;
  fetchImpl?: typeof fetch;
}

export class MillionVerifierEmailVerification implements EmailVerificationProvider {
  readonly name = "millionverifier";
  readonly costPerRecord = 1;
  readonly costOnUnknown = 0;
  readonly idempotentReplay = false;

  private readonly http: VendorHttp;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly defaultRetryAfter: number;
  private readonly vendorTimeoutSeconds: number;

  constructor(opts: MillionVerifierOptions) {
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl ?? "https://api.millionverifier.com";
    this.defaultRetryAfter = opts.defaultRetryAfterSeconds ?? 30;
    this.vendorTimeoutSeconds = opts.vendorTimeoutSeconds ?? 20;
    this.http = new VendorHttp({ vendor: "millionverifier", ...opts });
  }

  async verify(request: EmailVerificationRequest): Promise<EmailVerificationResult> {
    const url = new URL("/api/v3/", this.baseUrl);
    url.searchParams.set("api", this.apiKey);
    url.searchParams.set("email", request.email);
    url.searchParams.set("timeout", String(this.vendorTimeoutSeconds));

    let res;
    try {
      res = await this.http.request(url.toString());
    } catch (err) {
      if (err instanceof VendorTransportError && err.kind === "timeout") {
        throw new AmbiguousOutcomeError("MillionVerifier verification timed out; outcome unconfirmed.", this.costPerRecord, {
          provider: this.name,
        });
      }
      throw new RetryableProviderError("MillionVerifier request failed to send.", { charged: false });
    }
    if (res.status === 429) {
      throw new RateLimitError("MillionVerifier rate limited.", res.retryAfter ?? this.defaultRetryAfter, {
        provider: this.name,
      });
    }
    if (res.status >= 500) {
      throw new RetryableProviderError(`MillionVerifier server error (${res.status}).`, { charged: false, status: res.status });
    }
    if (res.status !== 200) {
      throw new AppError("PROVIDER_ERROR", `MillionVerifier rejected the request (${res.status}).`, {
        provider: this.name,
        status: res.status,
      });
    }
    const parsed = verifyResponseSchema.safeParse(safeJsonParse(res.text));
    if (!parsed.success) {
      throw new AmbiguousOutcomeError("MillionVerifier returned an unrecognized 200 body; outcome unconfirmed.", this.costPerRecord, {
        provider: this.name,
      });
    }
    if (parsed.data.error) {
      throw new AppError("PROVIDER_ERROR", `MillionVerifier error: ${parsed.data.error}`, { provider: this.name });
    }

    const { status, subStatus } = mapResult(parsed.data.result ?? "", parsed.data.subresult ?? null, parsed.data.role ?? false);
    return {
      status,
      ...(subStatus ? { subStatus } : {}),
      raw: { result: parsed.data.result ?? null, subresult: parsed.data.subresult ?? null, role: parsed.data.role ?? null },
      cost: status === "unknown" ? this.costOnUnknown : this.costPerRecord,
      providerRequestId: request.requestKey,
    };
  }
}

function mapResult(
  result: string,
  subresult: string | null,
  role: boolean,
): { status: EmailVerificationStatus; subStatus?: string } {
  switch (result) {
    case "ok":
      return role ? { status: "role_based", subStatus: "role" } : { status: "valid" };
    case "invalid":
      return { status: "invalid", ...(subresult ? { subStatus: subresult } : {}) };
    case "catch_all":
      return { status: "catch_all" };
    case "unknown":
      return { status: "unknown", ...(subresult ? { subStatus: subresult } : {}) };
    case "disposable":
      return { status: "invalid", subStatus: "disposable" };
    default:
      return { status: "unknown", subStatus: result || "unrecognized" };
  }
}
