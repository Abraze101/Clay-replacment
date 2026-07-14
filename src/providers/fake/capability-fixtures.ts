/**
 * Deterministic rules for the fake contact-capability providers. Keyed to the
 * FIXTURE_BUSINESSES dataset (phones +1512555xxxx, owner emails/domains) so
 * the whole Call-Ready flow runs offline with predictable signals.
 *
 * Phone validation — by the LAST TWO digits of the E.164 number:
 *   61–69        mobile / active / person_match   (fixture owners' direct numbers)
 *   71           voip / active / unknown identity
 *   72           toll_free / unknown status
 *   73           landline / inactive              (disqualifies call-readiness)
 *   74           mobile / active / MISMATCH       (wrong-person number)
 *   75           RateLimitError once, then landline/active/business_match
 *   76           AmbiguousOutcomeError (charged)
 *   77           RetryableProviderError{charged:false} once, then success
 *   78           landline / status UNKNOWN        (checked-but-unknown → 'uncertain')
 *   otherwise    landline / active / business_match (fixture business mains 01–15)
 *
 * Email verification — by local part:
 *   bounce@      invalid (mailbox_not_found)
 *   catchall@    catch_all
 *   info@ sales@ admin@ support@   role_based
 *   unknown@     unknown, COST 0 (vendors refund unknowns)
 *   ratelimit@   RateLimitError
 *   ambiguous@   AmbiguousOutcomeError (charged)
 *   flaky@       RetryableProviderError once, then valid
 *   otherwise    valid (confidence 0.98)
 *
 * Contact discovery — by company domain:
 *   contains 'slow'       async: pending → pending → found (submit-then-poll path)
 *   contains 'ambiguous'  AmbiguousOutcomeError (submit may have completed)
 *   contains 'ratelimit'  RateLimitError once, then found
 *   contains 'flaky'      RetryableProviderError once, then found
 *   contains 'nowhere'    no_result (cost 0)
 *   no domain             no_result (cost 0)
 *   fixture domain with a person   found: the person's real workEmail/directPhone
 *   otherwise              found: owner@<domain> + deterministic direct/mobile number
 */
import type { DiscoveredContact, EmailVerificationStatus } from "../capabilities.js";
import type { IdentityMatch, LineStatus, LineType } from "../../storage/database-types.js";
import { FIXTURE_BUSINESSES } from "./fixtures.js";

export interface FakePhoneSignals {
  lineType: LineType;
  lineStatus: LineStatus;
  identityMatch: IdentityMatch;
}

export type FakePhoneBehavior =
  | { kind: "signals"; signals: FakePhoneSignals }
  | { kind: "rate_limit_once"; then: FakePhoneSignals }
  | { kind: "ambiguous" }
  | { kind: "flaky_once"; then: FakePhoneSignals };

const LANDLINE_OK: FakePhoneSignals = { lineType: "landline", lineStatus: "active", identityMatch: "business_match" };
const MOBILE_OK: FakePhoneSignals = { lineType: "mobile", lineStatus: "active", identityMatch: "person_match" };

export function fakePhoneBehavior(phoneE164: string): FakePhoneBehavior {
  const suffix = Number(phoneE164.slice(-2));
  if (suffix >= 61 && suffix <= 69) return { kind: "signals", signals: MOBILE_OK };
  switch (suffix) {
    case 71:
      return { kind: "signals", signals: { lineType: "voip", lineStatus: "active", identityMatch: "unknown" } };
    case 72:
      return { kind: "signals", signals: { lineType: "toll_free", lineStatus: "unknown", identityMatch: "unknown" } };
    case 73:
      return { kind: "signals", signals: { lineType: "landline", lineStatus: "inactive", identityMatch: "business_match" } };
    case 74:
      return { kind: "signals", signals: { lineType: "mobile", lineStatus: "active", identityMatch: "mismatch" } };
    case 75:
      return { kind: "rate_limit_once", then: LANDLINE_OK };
    case 76:
      return { kind: "ambiguous" };
    case 77:
      return { kind: "flaky_once", then: LANDLINE_OK };
    case 78:
      return { kind: "signals", signals: { lineType: "landline", lineStatus: "unknown", identityMatch: "unknown" } };
    default:
      return { kind: "signals", signals: LANDLINE_OK };
  }
}

export type FakeEmailBehavior =
  | { kind: "status"; status: EmailVerificationStatus; subStatus?: string; confidence?: number; cost: number }
  | { kind: "rate_limit" }
  | { kind: "ambiguous" }
  | { kind: "flaky_once"; then: { status: EmailVerificationStatus; confidence?: number; cost: number } };

export function fakeEmailBehavior(email: string): FakeEmailBehavior {
  const local = email.toLowerCase().split("@")[0] ?? "";
  if (local === "bounce") return { kind: "status", status: "invalid", subStatus: "mailbox_not_found", cost: 1 };
  if (local === "catchall") return { kind: "status", status: "catch_all", cost: 1 };
  if (["info", "sales", "admin", "support"].includes(local)) {
    return { kind: "status", status: "role_based", subStatus: "role_based", cost: 1 };
  }
  if (local === "unknown") return { kind: "status", status: "unknown", subStatus: "timeout", cost: 0 };
  if (local === "ratelimit") return { kind: "rate_limit" };
  if (local === "ambiguous") return { kind: "ambiguous" };
  if (local === "flaky") return { kind: "flaky_once", then: { status: "valid", confidence: 0.98, cost: 1 } };
  return { kind: "status", status: "valid", confidence: 0.98, cost: 1 };
}

export type FakeDiscoveryBehavior =
  | { kind: "found"; contacts: { email?: string; directPhone?: string; mobilePhone?: string } }
  | { kind: "no_result" }
  | { kind: "async_found"; contacts: { email?: string; directPhone?: string; mobilePhone?: string } }
  | { kind: "rate_limit_once"; then: { email?: string; directPhone?: string; mobilePhone?: string } }
  | { kind: "flaky_once"; then: { email?: string; directPhone?: string; mobilePhone?: string } }
  | { kind: "ambiguous" };

/** Deterministic direct-dial for a domain: +1512555 01 6X where X = stable hash 1..9. */
function deterministicDirect(domain: string): string {
  let hash = 0;
  for (const ch of domain) hash = (hash * 31 + ch.charCodeAt(0)) % 997;
  return `+151255501${61 + (hash % 9)}`;
}

export function fakeDiscoveryBehavior(domain: string | null | undefined): FakeDiscoveryBehavior {
  if (!domain) return { kind: "no_result" };
  const d = domain.toLowerCase();
  const fixture = FIXTURE_BUSINESSES.find(
    (f) => f.person && f.website && f.website.toLowerCase().includes(d.replace(/^www\./, "")),
  );
  const defaults = fixture?.person
    ? { email: fixture.person.workEmail, directPhone: fixture.person.directPhone }
    : { email: `owner@${d}`, directPhone: deterministicDirect(d), mobilePhone: deterministicDirect(d) };
  if (d.includes("slow")) return { kind: "async_found", contacts: defaults };
  if (d.includes("ambiguous")) return { kind: "ambiguous" };
  if (d.includes("ratelimit")) return { kind: "rate_limit_once", then: defaults };
  if (d.includes("flaky")) return { kind: "flaky_once", then: defaults };
  if (d.includes("nowhere")) return { kind: "no_result" };
  return { kind: "found", contacts: defaults };
}

/** Map a found-contacts fixture entry into DiscoveredContact rows for the wanted kinds. */
export function discoveredContacts(
  contacts: { email?: string; directPhone?: string; mobilePhone?: string },
  wanted: readonly ("work_email" | "direct_phone" | "mobile_phone")[],
): DiscoveredContact[] {
  const out: DiscoveredContact[] = [];
  if (wanted.includes("work_email") && contacts.email) {
    out.push({ type: "email", role: "work", value: contacts.email, vendorStatusClaim: "likely_valid", confidence: 0.9 });
  }
  if (wanted.includes("direct_phone") && contacts.directPhone) {
    out.push({ type: "phone", role: "direct", value: contacts.directPhone, confidence: 0.85 });
  }
  if (wanted.includes("mobile_phone") && contacts.mobilePhone) {
    out.push({ type: "phone", role: "mobile", value: contacts.mobilePhone, confidence: 0.8 });
  }
  return out;
}
