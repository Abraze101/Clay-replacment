import { z } from "zod";

import { AmbiguousOutcomeError, AppError, RateLimitError, RetryableProviderError } from "../../shared/errors.js";
import type {
  ContactDiscoveryOutcome,
  ContactDiscoveryProvider,
  ContactDiscoveryRequest,
  ContactKind,
  DiscoveredContact,
} from "../capabilities.js";
import { discoveryCostPerRecord } from "../capabilities.js";
import { safeJsonParse, VendorHttp, VendorTransportError } from "../vendor-http.js";

/**
 * BetterContact → ContactDiscoveryProvider (ADR-008 candidate; ADR-029/030).
 * Async submit-then-poll: POST /api/v2/async accepts a job; GET /api/v2/async/{id}
 * polls it — no webhook needed. Our requestKey is echoed back via
 * custom_fields for dashboard reconciliation (the vendor has no
 * lookup-by-reference endpoint, so findJobByRequestKey is NOT implemented:
 * a crash before the job id commits is booked ambiguous).
 *
 * Paid-call contract: charged only for DELIVERED data (email and phone billed
 * separately; phone ≈ 10× email) → costOnNoResult 0; actual cost prefers the
 * response's credits_consumed. Submit timeout / malformed 200 (job may exist
 * and charge) → AmbiguousOutcomeError(worst case). Poll is read-only and free:
 * poll timeout / 5xx / malformed → RetryableProviderError; poll 404 on a known
 * job id → AmbiguousOutcomeError → needs_review. 429 → RateLimitError.
 * The key travels in the query string → URLs never appear in errors.
 */
const submitResponseSchema = z.object({ success: z.boolean().optional(), id: z.string().optional() }).passthrough();

const pollResponseSchema = z
  .object({
    id: z.string().optional(),
    status: z.string().optional(),
    credits_consumed: z.number().optional(),
    data: z
      .array(
        z
          .object({
            enriched: z.boolean().optional(),
            contact_email_address: z.string().nullable().optional(),
            contact_email_address_status: z.string().nullable().optional(),
            contact_phone_number: z.string().nullable().optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

export interface BetterContactOptions {
  apiKey: string;
  baseUrl?: string;
  maxRequestsPerMinute?: number;
  requestTimeoutMs?: number;
  defaultRetryAfterSeconds?: number;
  pollIntervalSeconds?: number;
  fetchImpl?: typeof fetch;
}

export class BetterContactDiscovery implements ContactDiscoveryProvider {
  readonly name = "bettercontact";
  readonly costPerKind: Readonly<Record<ContactKind, number>> = { work_email: 1, direct_phone: 10, mobile_phone: 10 };
  readonly costOnNoResult = 0;
  readonly asyncDelivery = true;
  readonly idempotentReplay = false;
  readonly maxPollSeconds = 600;

  private readonly http: VendorHttp;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly defaultRetryAfter: number;
  private readonly pollIntervalSeconds: number;

  constructor(opts: BetterContactOptions) {
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl ?? "https://app.bettercontact.rocks";
    this.defaultRetryAfter = opts.defaultRetryAfterSeconds ?? 60;
    this.pollIntervalSeconds = opts.pollIntervalSeconds ?? 10;
    this.http = new VendorHttp({ vendor: "bettercontact", ...opts });
  }

  async discover(request: ContactDiscoveryRequest): Promise<ContactDiscoveryOutcome> {
    const worstCase = discoveryCostPerRecord(this, request.wanted);
    const url = new URL("/api/v2/async", this.baseUrl);
    url.searchParams.set("api_key", this.apiKey);
    const body = {
      data: [
        {
          first_name: request.person.firstName ?? undefined,
          last_name: request.person.lastName ?? undefined,
          company: request.company.name ?? undefined,
          company_domain: request.company.domain ?? undefined,
          linkedin_url: request.person.linkedinUrl ?? undefined,
          custom_fields: { request_key: request.requestKey },
        },
      ],
      enrich_email_address: request.wanted.includes("work_email"),
      enrich_phone_number: request.wanted.includes("direct_phone") || request.wanted.includes("mobile_phone"),
    };

    let res;
    try {
      res = await this.http.request(url.toString(), { method: "POST", body });
    } catch (err) {
      if (err instanceof VendorTransportError && err.kind === "timeout") {
        // The job may have been accepted and will charge on delivery.
        throw new AmbiguousOutcomeError(
          "BetterContact submit timed out; the job may exist. Reconcile via the dashboard using the echoed request key.",
          worstCase,
          { provider: this.name, requestKey: request.requestKey },
        );
      }
      throw new RetryableProviderError("BetterContact submit failed to send.", { charged: false });
    }
    if (res.status === 429) {
      throw new RateLimitError("BetterContact rate limited.", res.retryAfter ?? this.defaultRetryAfter, { provider: this.name });
    }
    if (res.status >= 500) {
      throw new RetryableProviderError(`BetterContact server error (${res.status}).`, { charged: false, status: res.status });
    }
    if (res.status !== 200 && res.status !== 201 && res.status !== 202) {
      throw new AppError("PROVIDER_ERROR", `BetterContact rejected the submit (${res.status}).`, {
        provider: this.name,
        status: res.status,
      });
    }
    const parsed = submitResponseSchema.safeParse(safeJsonParse(res.text));
    if (!parsed.success || !parsed.data.id) {
      throw new AmbiguousOutcomeError(
        "BetterContact accepted the submit but returned no job id; the job may exist and charge.",
        worstCase,
        { provider: this.name, requestKey: request.requestKey },
      );
    }
    return { kind: "pending", jobId: parsed.data.id, pollAfterSeconds: this.pollIntervalSeconds, providerRequestId: parsed.data.id };
  }

  async poll(jobId: string, request: ContactDiscoveryRequest): Promise<ContactDiscoveryOutcome> {
    const url = new URL(`/api/v2/async/${encodeURIComponent(jobId)}`, this.baseUrl);
    url.searchParams.set("api_key", this.apiKey);
    let res;
    try {
      res = await this.http.request(url.toString());
    } catch {
      // Poll is read-only and free: every transport failure is retryable.
      throw new RetryableProviderError("BetterContact poll failed; safe to retry.", { charged: false });
    }
    if (res.status === 429) {
      throw new RateLimitError("BetterContact rate limited the poll.", res.retryAfter ?? this.defaultRetryAfter, {
        provider: this.name,
      });
    }
    if (res.status === 404) {
      throw new AmbiguousOutcomeError(
        `BetterContact no longer knows job '${jobId}'; delivery/charging unconfirmed — reconcile via the dashboard.`,
        discoveryCostPerRecord(this, request.wanted),
        { provider: this.name, jobId },
      );
    }
    if (res.status !== 200) {
      throw new RetryableProviderError(`BetterContact poll error (${res.status}); safe to retry.`, {
        charged: false,
        status: res.status,
      });
    }
    const parsed = pollResponseSchema.safeParse(safeJsonParse(res.text));
    if (!parsed.success) {
      throw new RetryableProviderError("BetterContact poll returned an unrecognized body; safe to retry.", { charged: false });
    }
    if ((parsed.data.status ?? "").toLowerCase() !== "terminated") {
      return { kind: "pending", jobId, pollAfterSeconds: this.pollIntervalSeconds, providerRequestId: jobId };
    }

    const contacts: DiscoveredContact[] = [];
    for (const row of parsed.data.data ?? []) {
      if (request.wanted.includes("work_email") && row.contact_email_address) {
        contacts.push({
          type: "email",
          role: "work",
          value: row.contact_email_address,
          ...(row.contact_email_address_status ? { vendorStatusClaim: row.contact_email_address_status } : {}),
        });
      }
      if ((request.wanted.includes("direct_phone") || request.wanted.includes("mobile_phone")) && row.contact_phone_number) {
        contacts.push({ type: "phone", role: "direct", value: row.contact_phone_number });
      }
    }
    if (contacts.length === 0) return { kind: "no_result", cost: this.costOnNoResult, providerRequestId: jobId };
    const computed =
      (contacts.some((c) => c.type === "email") ? this.costPerKind.work_email : 0) +
      (contacts.some((c) => c.type === "phone") ? this.costPerKind.direct_phone : 0);
    return {
      kind: "found",
      contacts,
      cost: parsed.data.credits_consumed ?? computed,
      providerRequestId: jobId,
    };
  }
}
