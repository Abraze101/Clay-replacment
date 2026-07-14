import { z } from "zod";

import { AmbiguousOutcomeError, AppError, RateLimitError, RetryableProviderError } from "../../shared/errors.js";
import type {
  PhoneSignal,
  PhoneValidationProvider,
  PhoneValidationRequest,
  PhoneValidationResult,
  SignalResult,
} from "../capabilities.js";
import type { IdentityMatch, LineStatus, LineType } from "../../storage/database-types.js";
import { safeJsonParse, VendorHttp, VendorTransportError } from "../vendor-http.js";

/**
 * Twilio Lookup v2 → PhoneValidationProvider (ADR-009 first candidate;
 * ADR-030). One documented endpoint: GET /v2/PhoneNumbers/{E164}?Fields=…
 * with per-signal data packages. Never a single 'verified' boolean: each
 * signal maps into the contact_points vocabulary separately.
 *
 * Paid-call contract (docs/architecture.md questionnaire):
 * - Idempotency key: none accepted. Stable request id: none documented →
 *   the engine's requestKey is the recorded fallback; idempotentReplay:false.
 * - Charging: per successful signal package per lookup. An invalid/not-found
 *   number (404 or valid:false) is a definitive FREE result. A package-level
 *   internal error yields signal 'unknown' (raw error kept).
 * - 429 → RateLimitError (Retry-After honored). 5xx / network-before-send →
 *   RetryableProviderError{charged:false}. 400/401/403 → PROVIDER_ERROR.
 * - Timeout / malformed 200 → AmbiguousOutcomeError(possibleCost=requested
 *   packages) → needs_review; reconcile manually against Twilio usage records.
 * - Identity Match is an approval-gated Twilio package: requested only when
 *   identityMatchEnabled AND the hint is a person; business identity uses the
 *   CNAM caller_name package with a deterministic name-similarity mapping.
 */
const lookupResponseSchema = z
  .object({
    valid: z.boolean().optional(),
    phone_number: z.string().optional(),
    validation_errors: z.array(z.string()).optional(),
    line_type_intelligence: z
      .object({ type: z.string().nullable().optional(), error_code: z.number().nullable().optional() })
      .passthrough()
      .nullable()
      .optional(),
    line_status: z
      .object({ status: z.string().nullable().optional(), error_code: z.number().nullable().optional() })
      .passthrough()
      .nullable()
      .optional(),
    caller_name: z
      .object({
        caller_name: z.string().nullable().optional(),
        caller_type: z.string().nullable().optional(),
        error_code: z.number().nullable().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
    identity_match: z
      .object({
        summary_score: z.number().nullable().optional(),
        error_code: z.number().nullable().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();

const LINE_TYPE_MAP: Record<string, LineType> = {
  mobile: "mobile",
  landline: "landline",
  fixedVoip: "voip",
  nonFixedVoip: "voip",
  tollFree: "toll_free",
  voip: "voip",
};

export interface TwilioPhoneValidationOptions {
  accountSid: string;
  authToken: string;
  baseUrl?: string;
  maxRequestsPerMinute?: number;
  requestTimeoutMs?: number;
  defaultRetryAfterSeconds?: number;
  identityMatchEnabled?: boolean;
  fetchImpl?: typeof fetch;
}

export class TwilioPhoneValidation implements PhoneValidationProvider {
  readonly name = "twilio-lookup";
  readonly supportedSignals: readonly PhoneSignal[] = ["line_type", "line_status", "identity_match"];
  readonly costPerSignal = { line_type: 1, line_status: 1, identity_match: 2 } as const;
  readonly costOnNoResult = 0;
  readonly idempotentReplay = false;

  private readonly http: VendorHttp;
  private readonly baseUrl: string;
  private readonly authHeader: string;
  private readonly defaultRetryAfter: number;
  private readonly identityMatchEnabled: boolean;

  constructor(opts: TwilioPhoneValidationOptions) {
    this.baseUrl = opts.baseUrl ?? "https://lookups.twilio.com";
    this.authHeader = `Basic ${Buffer.from(`${opts.accountSid}:${opts.authToken}`).toString("base64")}`;
    this.defaultRetryAfter = opts.defaultRetryAfterSeconds ?? 30;
    this.identityMatchEnabled = opts.identityMatchEnabled ?? false;
    this.http = new VendorHttp({ vendor: "twilio-lookup", ...opts });
  }

  async validate(request: PhoneValidationRequest): Promise<PhoneValidationResult> {
    const requestedCost = request.signals.reduce((sum, s) => sum + this.costPerSignal[s], 0);
    const fields: string[] = [];
    if (request.signals.includes("line_type")) fields.push("line_type_intelligence");
    if (request.signals.includes("line_status")) fields.push("line_status");
    if (request.signals.includes("identity_match")) {
      if (request.identityHint?.kind === "person" && this.identityMatchEnabled) fields.push("identity_match");
      else fields.push("caller_name");
    }
    const url = new URL(`/v2/PhoneNumbers/${encodeURIComponent(request.phoneE164)}`, this.baseUrl);
    if (fields.length > 0) url.searchParams.set("Fields", fields.join(","));
    if (fields.includes("identity_match") && request.identityHint) {
      if (request.identityHint.firstName) url.searchParams.set("FirstName", request.identityHint.firstName);
      if (request.identityHint.lastName) url.searchParams.set("LastName", request.identityHint.lastName);
    }

    let res;
    try {
      res = await this.http.request(url.toString(), { headers: { authorization: this.authHeader } });
    } catch (err) {
      if (err instanceof VendorTransportError && err.kind === "timeout") {
        // Twilio may have processed (and charged) the packages.
        throw new AmbiguousOutcomeError("Twilio Lookup timed out; outcome unconfirmed.", requestedCost, {
          provider: this.name,
        });
      }
      throw new RetryableProviderError("Twilio Lookup request failed to send.", { charged: false });
    }

    if (res.status === 404) {
      // Not a phone number: definitive, free.
      return { formatValid: false, cost: this.costOnNoResult, providerRequestId: request.requestKey };
    }
    if (res.status === 429) {
      throw new RateLimitError("Twilio Lookup rate limited.", res.retryAfter ?? this.defaultRetryAfter, {
        provider: this.name,
      });
    }
    if (res.status === 400 || res.status === 401 || res.status === 403) {
      throw new AppError("PROVIDER_ERROR", `Twilio Lookup rejected the request (${res.status}).`, {
        provider: this.name,
        status: res.status,
      });
    }
    if (res.status >= 500 || res.status !== 200) {
      throw new RetryableProviderError(`Twilio Lookup server error (${res.status}).`, { charged: false, status: res.status });
    }
    const parsed = lookupResponseSchema.safeParse(safeJsonParse(res.text));
    if (!parsed.success) {
      throw new AmbiguousOutcomeError("Twilio Lookup returned an unrecognized 200 body; outcome unconfirmed.", requestedCost, {
        provider: this.name,
      });
    }
    const data = parsed.data;
    if (data.valid === false) {
      return { formatValid: false, cost: this.costOnNoResult, providerRequestId: request.requestKey };
    }

    const lineType: SignalResult<LineType> | undefined = (() => {
      const pkg = data.line_type_intelligence;
      if (!request.signals.includes("line_type") || !pkg) return undefined;
      if (pkg.error_code) return { value: "unknown", raw: { errorCode: pkg.error_code } };
      return { value: LINE_TYPE_MAP[pkg.type ?? ""] ?? "unknown", raw: { type: pkg.type ?? null } };
    })();
    const lineStatus: SignalResult<LineStatus> | undefined = (() => {
      const pkg = data.line_status;
      if (!request.signals.includes("line_status") || !pkg) return undefined;
      if (pkg.error_code) return { value: "unknown", raw: { errorCode: pkg.error_code } };
      const status = pkg.status === "active" ? "active" : pkg.status === "inactive" ? "inactive" : "unknown";
      return { value: status, raw: { status: pkg.status ?? null } };
    })();
    const identityMatch = this.mapIdentity(request, data);

    return {
      formatValid: true,
      normalizedE164: data.phone_number ?? request.phoneE164,
      ...(lineType ? { lineType } : {}),
      ...(lineStatus ? { lineStatus } : {}),
      ...(identityMatch ? { identityMatch } : {}),
      cost: requestedCost,
      providerRequestId: request.requestKey,
    };
  }

  private mapIdentity(
    request: PhoneValidationRequest,
    data: z.infer<typeof lookupResponseSchema>,
  ): SignalResult<IdentityMatch> | undefined {
    if (!request.signals.includes("identity_match")) return undefined;
    if (data.identity_match && !data.identity_match.error_code) {
      const score = data.identity_match.summary_score ?? null;
      if (score === null) return { value: "unknown", raw: {} };
      return {
        value: score >= 60 ? "person_match" : score <= 20 ? "mismatch" : "unknown",
        confidence: Math.max(0, Math.min(1, score / 100)),
        raw: { summaryScore: score },
      };
    }
    const cnam = data.caller_name;
    if (!cnam || cnam.error_code) return { value: "unknown", raw: cnam?.error_code ? { errorCode: cnam.error_code } : {} };
    const returned = normalizeName(cnam.caller_name ?? "");
    const expected = normalizeName(request.identityHint?.name ?? "");
    if (!returned || !expected) return { value: "unknown", raw: { callerName: cnam.caller_name ?? null } };
    if (returned === expected) return { value: "business_match", confidence: 0.9, raw: { callerName: cnam.caller_name } };
    const overlap = tokenOverlap(returned, expected);
    if (overlap >= 0.5) return { value: "business_match", confidence: 0.7, raw: { callerName: cnam.caller_name } };
    return { value: "mismatch", confidence: 0.6, raw: { callerName: cnam.caller_name } };
  }
}

function normalizeName(value: string): string {
  return value
    .toLowerCase()
    .replace(/\b(llc|inc|co|corp|ltd|company)\b/g, "")
    .replace(/[^a-z0-9 ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenOverlap(a: string, b: string): number {
  const ta = new Set(a.split(" ").filter(Boolean));
  const tb = new Set(b.split(" ").filter(Boolean));
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const token of ta) if (tb.has(token)) shared += 1;
  return shared / Math.min(ta.size, tb.size);
}
