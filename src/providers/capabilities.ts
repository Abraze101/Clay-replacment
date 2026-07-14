/**
 * Provider-neutral contact-enrichment capability interfaces (M5).
 *
 * Three interface families back the four workflow-step capabilities:
 * - phone_validation  → PhoneValidationProvider
 * - email_verification → EmailVerificationProvider
 * - phone_discovery + email_discovery → ContactDiscoveryProvider (one vendor
 *   serves both; the request's `wanted` kinds keep the two step capabilities
 *   independently overridable).
 *
 * Signal vocabularies are the contact_points CHECK vocabularies
 * (storage/database-types.ts) — adapters map vendor payloads INTO them and
 * never invent values. There is deliberately no single `verified` boolean
 * anywhere in these shapes: every signal is reported separately with its own
 * provider/confidence, per the contact-data-honesty rules in CLAUDE.md.
 *
 * Async vendors (submit-then-poll, ADR-029): `discover()` may return
 * `{kind:"pending"}`; the engine persists the vendor job id and calls `poll()`
 * on later attempts. Poll is read-only and free — poll failures are always
 * retryable, never ambiguous. A submit that dies before the job id is
 * captured falls back to `findJobByRequestKey` when the vendor echoes a
 * client reference, else the engine books it ambiguous (needs_review).
 */
import type {
  EmailRole,
  EmailStatus,
  IdentityMatch,
  LineStatus,
  LineType,
  PhoneRole,
} from "../storage/database-types.js";

export type PhoneSignal = "line_type" | "line_status" | "identity_match";

/** A provider result the engine never returns: absence of a check is engine-side 'not_checked'. */
export type EmailVerificationStatus = Exclude<EmailStatus, "not_checked">;

export interface SignalResult<V extends string> {
  value: V;
  /** Normalized 0..1 when the vendor supplies one; omitted otherwise. */
  confidence?: number;
  /** Sanitized vendor payload → contact_point_checks.detail (jsonb). Never contains secrets. */
  raw?: Record<string, unknown>;
}

export interface PhoneIdentityHint {
  kind: "business" | "person";
  name?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  addressLine?: string | null;
  locality?: string | null;
  region?: string | null;
  countryCode?: string | null;
}

export interface PhoneValidationRequest {
  /** Engine idempotency key; no phone vendor honors one — recorded as the fallback request id. */
  requestKey: string;
  phoneE164: string;
  /** Paid signal packages requested; format checking is always included for free. */
  signals: PhoneSignal[];
  identityHint?: PhoneIdentityHint;
}

export interface PhoneValidationResult {
  /** Vendor-side parse/format validity — never implies reachability or association. */
  formatValid: boolean;
  normalizedE164?: string;
  lineType?: SignalResult<LineType>;
  lineStatus?: SignalResult<LineStatus>;
  identityMatch?: SignalResult<IdentityMatch>;
  cost: number;
  providerRequestId: string;
}

export interface PhoneValidationProvider {
  readonly name: string;
  readonly supportedSignals: readonly PhoneSignal[];
  /** Units per requested signal package — the plan resolver's per-record estimate. */
  readonly costPerSignal: Readonly<Partial<Record<PhoneSignal, number>>>;
  /** Cost when the number is invalid/not found (usually 0). */
  readonly costOnNoResult: number;
  readonly idempotentReplay?: boolean;
  validate(request: PhoneValidationRequest): Promise<PhoneValidationResult>;
}

export interface EmailVerificationRequest {
  requestKey: string;
  email: string;
}

export interface EmailVerificationResult {
  status: EmailVerificationStatus;
  /** Vendor sub-status verbatim ('mailbox_not_found', 'disposable', …) — kept as data. */
  subStatus?: string;
  confidence?: number;
  raw?: Record<string, unknown>;
  /** 0 when the vendor refunds 'unknown' results. */
  cost: number;
  providerRequestId: string;
}

export interface EmailVerificationProvider {
  readonly name: string;
  readonly costPerRecord: number;
  /** Both benchmark candidates refund unknowns — modeled explicitly. */
  readonly costOnUnknown: number;
  readonly idempotentReplay?: boolean;
  verify(request: EmailVerificationRequest): Promise<EmailVerificationResult>;
}

export type ContactKind = "work_email" | "direct_phone" | "mobile_phone";

export interface ContactDiscoveryRequest {
  requestKey: string;
  /** A phone_discovery step asks only for phones; email_discovery only for the email — per-capability overrides hold. */
  wanted: readonly ContactKind[];
  person: {
    firstName?: string | null;
    lastName?: string | null;
    fullName?: string | null;
    title?: string | null;
    linkedinUrl?: string | null;
  };
  company: {
    name?: string | null;
    domain?: string | null;
    websiteUrl?: string | null;
  };
}

export interface DiscoveredContact {
  type: "phone" | "email";
  /** contact_points role vocabulary; the engine persists it as-is. */
  role: PhoneRole | EmailRole;
  /** Raw as returned; the engine normalizes and persists. */
  value: string;
  /**
   * The vendor's OWN validity claim — stored as source metadata, never as our
   * verification judgment (the engine keeps email_status='not_checked' until
   * a real email_verification step runs).
   */
  vendorStatusClaim?: string;
  confidence?: number;
  raw?: Record<string, unknown>;
}

export type ContactDiscoveryOutcome =
  | { kind: "found"; contacts: DiscoveredContact[]; cost: number; providerRequestId: string }
  | { kind: "no_result"; cost: number; providerRequestId: string }
  /** Async vendor accepted a job; cost is booked at the final result, not here. */
  | { kind: "pending"; jobId: string; pollAfterSeconds: number; providerRequestId: string };

export interface ContactDiscoveryProvider {
  readonly name: string;
  /** Worst-case units per record per contact kind (plan estimate + ambiguous possibleCost). */
  readonly costPerKind: Readonly<Record<ContactKind, number>>;
  readonly costOnNoResult: number;
  /** True when discover() may return 'pending'; sync vendors never do. */
  readonly asyncDelivery: boolean;
  readonly idempotentReplay?: boolean;
  /** Poll budget in seconds before an unresolved job books ambiguous → needs_review (default 600). */
  readonly maxPollSeconds?: number;
  discover(request: ContactDiscoveryRequest): Promise<ContactDiscoveryOutcome>;
  /** Read-only and free; ALWAYS safe to retry. Required when asyncDelivery. */
  poll?(jobId: string, request: ContactDiscoveryRequest): Promise<ContactDiscoveryOutcome>;
  /** Optional submit-crash reconciliation: find the vendor job by the echoed client reference. */
  findJobByRequestKey?(requestKey: string): Promise<{ jobId: string } | null>;
}

/**
 * Worst-case per-record cost of a discovery call for the given wanted kinds.
 * Vendors bill email and phone enrichment separately, but wanting BOTH direct
 * and mobile is one phone enrichment — phone cost counts once (the max).
 */
export function discoveryCostPerRecord(provider: ContactDiscoveryProvider, wanted: readonly ContactKind[]): number {
  const email = wanted.includes("work_email") ? provider.costPerKind.work_email : 0;
  const wantsPhone = wanted.includes("direct_phone") || wanted.includes("mobile_phone");
  const phone = wantsPhone ? Math.max(provider.costPerKind.direct_phone, provider.costPerKind.mobile_phone) : 0;
  return email + phone;
}

/** Per-record cost of a validation call for the given requested signals. */
export function validationCostPerRecord(provider: PhoneValidationProvider, signals: readonly PhoneSignal[]): number {
  return signals.reduce((sum, signal) => sum + (provider.costPerSignal[signal] ?? 0), 0);
}
