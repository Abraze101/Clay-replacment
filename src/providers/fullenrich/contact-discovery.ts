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
 * FullEnrich → ContactDiscoveryProvider (ADR-008 candidate; ADR-029/030).
 * Async bulk submit-then-poll: POST /api/v1/contact/enrich/bulk (Bearer auth)
 * accepts a bulk of one; GET /api/v1/contact/enrich/bulk/{enrichment_id}
 * polls it — no webhook needed. The bulk `name` carries our requestKey for
 * dashboard reconciliation; the vendor has no lookup-by-reference endpoint,
 * so a crash before the enrichment_id commits is booked ambiguous.
 *
 * Paid-call contract: credits only on found data (phones ≈ 10× emails) →
 * costOnNoResult 0. Submit timeout / malformed 200 → AmbiguousOutcomeError
 * (worst case). Poll failures → RetryableProviderError (free, read-only);
 * poll 404 on a known id → AmbiguousOutcomeError. 429 → RateLimitError;
 * 402 (credits exhausted) → PROVIDER_ERROR.
 */
const submitResponseSchema = z.object({ enrichment_id: z.string().optional() }).passthrough();

const pollResponseSchema = z
  .object({
    status: z.string().optional(),
    datas: z
      .array(
        z
          .object({
            contact: z
              .object({
                emails: z.array(z.object({ email: z.string().optional(), status: z.string().nullable().optional() }).passthrough()).optional(),
                phones: z.array(z.object({ number: z.string().optional(), type: z.string().nullable().optional() }).passthrough()).optional(),
              })
              .passthrough()
              .nullable()
              .optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

const DONE_STATUSES = new Set(["finished", "done", "completed", "terminated"]);

export interface FullEnrichOptions {
  apiKey: string;
  baseUrl?: string;
  maxRequestsPerMinute?: number;
  requestTimeoutMs?: number;
  defaultRetryAfterSeconds?: number;
  pollIntervalSeconds?: number;
  fetchImpl?: typeof fetch;
}

export class FullEnrichDiscovery implements ContactDiscoveryProvider {
  readonly name = "fullenrich";
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

  constructor(opts: FullEnrichOptions) {
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl ?? "https://app.fullenrich.com";
    this.defaultRetryAfter = opts.defaultRetryAfterSeconds ?? 60;
    this.pollIntervalSeconds = opts.pollIntervalSeconds ?? 15;
    this.http = new VendorHttp({ vendor: "fullenrich", ...opts });
  }

  async discover(request: ContactDiscoveryRequest): Promise<ContactDiscoveryOutcome> {
    const worstCase = discoveryCostPerRecord(this, request.wanted);
    const enrichFields: string[] = [];
    if (request.wanted.includes("work_email")) enrichFields.push("contact.emails");
    if (request.wanted.includes("direct_phone") || request.wanted.includes("mobile_phone")) enrichFields.push("contact.phones");

    let res;
    try {
      res = await this.http.request(`${this.baseUrl}/api/v1/contact/enrich/bulk`, {
        method: "POST",
        headers: { authorization: `Bearer ${this.apiKey}` },
        body: {
          name: `leadgen-${request.requestKey}`,
          datas: [
            {
              firstname: request.person.firstName ?? undefined,
              lastname: request.person.lastName ?? undefined,
              domain: request.company.domain ?? undefined,
              company_name: request.company.name ?? undefined,
              linkedin_url: request.person.linkedinUrl ?? undefined,
              enrich_fields: enrichFields,
              custom: { request_key: request.requestKey },
            },
          ],
        },
      });
    } catch (err) {
      if (err instanceof VendorTransportError && err.kind === "timeout") {
        throw new AmbiguousOutcomeError(
          "FullEnrich submit timed out; the enrichment may exist. Reconcile via the dashboard using the bulk name.",
          worstCase,
          { provider: this.name, requestKey: request.requestKey },
        );
      }
      throw new RetryableProviderError("FullEnrich submit failed to send.", { charged: false });
    }
    if (res.status === 429) {
      throw new RateLimitError("FullEnrich rate limited.", res.retryAfter ?? this.defaultRetryAfter, { provider: this.name });
    }
    if (res.status === 402) {
      throw new AppError("PROVIDER_ERROR", "FullEnrich credits exhausted; top up before retrying.", { provider: this.name });
    }
    if (res.status >= 500) {
      throw new RetryableProviderError(`FullEnrich server error (${res.status}).`, { charged: false, status: res.status });
    }
    if (res.status !== 200 && res.status !== 201 && res.status !== 202) {
      throw new AppError("PROVIDER_ERROR", `FullEnrich rejected the submit (${res.status}).`, {
        provider: this.name,
        status: res.status,
      });
    }
    const parsed = submitResponseSchema.safeParse(safeJsonParse(res.text));
    if (!parsed.success || !parsed.data.enrichment_id) {
      throw new AmbiguousOutcomeError(
        "FullEnrich accepted the submit but returned no enrichment id; the job may exist and charge.",
        worstCase,
        { provider: this.name, requestKey: request.requestKey },
      );
    }
    return {
      kind: "pending",
      jobId: parsed.data.enrichment_id,
      pollAfterSeconds: this.pollIntervalSeconds,
      providerRequestId: parsed.data.enrichment_id,
    };
  }

  async poll(jobId: string, request: ContactDiscoveryRequest): Promise<ContactDiscoveryOutcome> {
    let res;
    try {
      res = await this.http.request(`${this.baseUrl}/api/v1/contact/enrich/bulk/${encodeURIComponent(jobId)}`, {
        headers: { authorization: `Bearer ${this.apiKey}` },
      });
    } catch {
      throw new RetryableProviderError("FullEnrich poll failed; safe to retry.", { charged: false });
    }
    if (res.status === 429) {
      throw new RateLimitError("FullEnrich rate limited the poll.", res.retryAfter ?? this.defaultRetryAfter, {
        provider: this.name,
      });
    }
    if (res.status === 404) {
      throw new AmbiguousOutcomeError(
        `FullEnrich no longer knows enrichment '${jobId}'; delivery/charging unconfirmed — reconcile via the dashboard.`,
        discoveryCostPerRecord(this, request.wanted),
        { provider: this.name, jobId },
      );
    }
    if (res.status !== 200) {
      throw new RetryableProviderError(`FullEnrich poll error (${res.status}); safe to retry.`, {
        charged: false,
        status: res.status,
      });
    }
    const parsed = pollResponseSchema.safeParse(safeJsonParse(res.text));
    if (!parsed.success) {
      throw new RetryableProviderError("FullEnrich poll returned an unrecognized body; safe to retry.", { charged: false });
    }
    if (!DONE_STATUSES.has((parsed.data.status ?? "").toLowerCase())) {
      return { kind: "pending", jobId, pollAfterSeconds: this.pollIntervalSeconds, providerRequestId: jobId };
    }

    const contacts: DiscoveredContact[] = [];
    for (const row of parsed.data.datas ?? []) {
      const contact = row.contact;
      if (!contact) continue;
      if (request.wanted.includes("work_email")) {
        for (const email of contact.emails ?? []) {
          if (!email.email) continue;
          contacts.push({
            type: "email",
            role: "work",
            value: email.email,
            ...(email.status ? { vendorStatusClaim: email.status } : {}),
          });
        }
      }
      if (request.wanted.includes("direct_phone") || request.wanted.includes("mobile_phone")) {
        for (const phone of contact.phones ?? []) {
          if (!phone.number) continue;
          contacts.push({
            type: "phone",
            role: (phone.type ?? "").toLowerCase() === "mobile" ? "mobile" : "direct",
            value: phone.number,
          });
        }
      }
    }
    if (contacts.length === 0) return { kind: "no_result", cost: this.costOnNoResult, providerRequestId: jobId };
    const cost =
      (contacts.some((c) => c.type === "email") ? this.costPerKind.work_email : 0) +
      (contacts.some((c) => c.type === "phone") ? this.costPerKind.direct_phone : 0);
    return { kind: "found", contacts, cost, providerRequestId: jobId };
  }
}
