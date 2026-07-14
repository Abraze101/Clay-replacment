import { z } from "zod";

import { AmbiguousOutcomeError, AppError, RateLimitError, RetryableProviderError } from "../../shared/errors.js";
import type {
  ContactDiscoveryOutcome,
  ContactDiscoveryProvider,
  ContactDiscoveryRequest,
  ContactKind,
  DiscoveredContact,
} from "../capabilities.js";
import { safeJsonParse, VendorHttp, VendorTransportError } from "../vendor-http.js";

/**
 * LeadMagic → ContactDiscoveryProvider (ADR-008 candidate; ADR-030).
 * SYNCHRONOUS: POST /email-finder and POST /mobile-finder per wanted kinds
 * (X-API-Key auth); never returns 'pending'. Zero-cost key check POST /credits.
 *
 * Paid-call contract — this is the Apollo-person-match analogue (ADR-028/029
 * contrast case): no job id, no idempotency key, so a timeout or malformed
 * 200 on a paid sub-call is AmbiguousOutcomeError(possibleCost of that
 * sub-call) → needs_review with manual dashboard reconciliation, and
 * idempotentReplay:false books crash replays ambiguous. Charged on FOUND
 * only → costOnNoResult 0 (a clean not-found is free and definitive).
 * 429 → RateLimitError; 5xx/network → RetryableProviderError{charged:false};
 * 401/403 → PROVIDER_ERROR.
 */
const emailFinderSchema = z
  .object({
    email: z.string().nullable().optional(),
    status: z.string().nullable().optional(),
    message: z.string().optional(),
    credits_consumed: z.number().optional(),
  })
  .passthrough();

const mobileFinderSchema = z
  .object({
    mobile_number: z.string().nullable().optional(),
    message: z.string().optional(),
    credits_consumed: z.number().optional(),
  })
  .passthrough();

export interface LeadMagicOptions {
  apiKey: string;
  baseUrl?: string;
  maxRequestsPerMinute?: number;
  requestTimeoutMs?: number;
  defaultRetryAfterSeconds?: number;
  fetchImpl?: typeof fetch;
}

export class LeadMagicDiscovery implements ContactDiscoveryProvider {
  readonly name = "leadmagic";
  readonly costPerKind: Readonly<Record<ContactKind, number>> = { work_email: 1, direct_phone: 5, mobile_phone: 5 };
  readonly costOnNoResult = 0;
  readonly asyncDelivery = false;
  readonly idempotentReplay = false;

  private readonly http: VendorHttp;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly defaultRetryAfter: number;

  constructor(opts: LeadMagicOptions) {
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl ?? "https://api.leadmagic.io";
    this.defaultRetryAfter = opts.defaultRetryAfterSeconds ?? 60;
    this.http = new VendorHttp({ vendor: "leadmagic", ...opts });
  }

  async discover(request: ContactDiscoveryRequest): Promise<ContactDiscoveryOutcome> {
    const contacts: DiscoveredContact[] = [];
    let cost = 0;

    if (request.wanted.includes("work_email")) {
      const found = await this.call<{ email?: string | null; status?: string | null; credits_consumed?: number }>(
        "/email-finder",
        {
          first_name: request.person.firstName ?? undefined,
          last_name: request.person.lastName ?? undefined,
          domain: request.company.domain ?? undefined,
          company_name: request.company.name ?? undefined,
        },
        emailFinderSchema,
        this.costPerKind.work_email,
      );
      if (found?.email) {
        contacts.push({
          type: "email",
          role: "work",
          value: found.email,
          ...(found.status ? { vendorStatusClaim: found.status } : {}),
        });
        cost += found.credits_consumed ?? this.costPerKind.work_email;
      }
    }

    if (request.wanted.includes("direct_phone") || request.wanted.includes("mobile_phone")) {
      const found = await this.call<{ mobile_number?: string | null; credits_consumed?: number }>(
        "/mobile-finder",
        {
          ...(request.person.linkedinUrl ? { profile_url: request.person.linkedinUrl } : {}),
          first_name: request.person.firstName ?? undefined,
          last_name: request.person.lastName ?? undefined,
          domain: request.company.domain ?? undefined,
        },
        mobileFinderSchema,
        this.costPerKind.mobile_phone,
      );
      if (found?.mobile_number) {
        contacts.push({ type: "phone", role: "mobile", value: found.mobile_number });
        cost += found.credits_consumed ?? this.costPerKind.mobile_phone;
      }
    }

    if (contacts.length === 0) return { kind: "no_result", cost: this.costOnNoResult, providerRequestId: request.requestKey };
    return { kind: "found", contacts, cost, providerRequestId: request.requestKey };
  }

  private async call<T>(
    path: string,
    body: Record<string, unknown>,
    schema: z.ZodType<T>,
    possibleCost: number,
  ): Promise<T | null> {
    let res;
    try {
      res = await this.http.request(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: { "x-api-key": this.apiKey },
        body,
      });
    } catch (err) {
      if (err instanceof VendorTransportError && err.kind === "timeout") {
        // No job id exists to reconcile with — the paid call may have completed.
        throw new AmbiguousOutcomeError(`LeadMagic ${path} timed out; outcome unconfirmed.`, possibleCost, {
          provider: this.name,
        });
      }
      throw new RetryableProviderError(`LeadMagic ${path} failed to send.`, { charged: false });
    }
    if (res.status === 404) return null; // clean not-found: free, definitive
    if (res.status === 429) {
      throw new RateLimitError("LeadMagic rate limited.", res.retryAfter ?? this.defaultRetryAfter, { provider: this.name });
    }
    if (res.status === 401 || res.status === 403 || res.status === 402) {
      throw new AppError("PROVIDER_ERROR", `LeadMagic rejected the request (${res.status}).`, {
        provider: this.name,
        status: res.status,
      });
    }
    if (res.status >= 500 || res.status !== 200) {
      throw new RetryableProviderError(`LeadMagic server error (${res.status}).`, { charged: false, status: res.status });
    }
    const parsed = schema.safeParse(safeJsonParse(res.text));
    if (!parsed.success) {
      throw new AmbiguousOutcomeError(`LeadMagic ${path} returned an unrecognized 200 body; outcome unconfirmed.`, possibleCost, {
        provider: this.name,
      });
    }
    return parsed.data;
  }
}
