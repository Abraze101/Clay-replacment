import type { Kysely, Selectable } from "kysely";

import type {
  CallReadinessStatus,
  ContactPointsTable,
  Database,
  IdentityMatch,
  LineStatus,
  PhoneRole,
} from "../../storage/database-types.js";
import { getLead, listContactPoints } from "../../storage/repositories/lead-repo.js";
import { findActiveSuppressions } from "../../storage/repositories/suppression-repo.js";
import { updateRunItem } from "../../storage/repositories/run-repo.js";
import type { PlanPolicy } from "../workflow-schema/plan.js";

/**
 * Deterministic call-readiness policy (M5). Turns stored per-signal contact
 * validation results + active suppressions into a transparent status:
 * ready / uncertain / invalid / suppressed / unchecked.
 *
 * Invariants encoded here (CLAUDE.md contact-data honesty):
 * - A format-only check is NEVER 'ready' — readiness demands line_status='active'.
 * - Unknown is never cleared: a checked-but-unknown line is 'uncertain';
 *   an unchecked one is 'unchecked'.
 * - Suppression always wins over a callable number.
 * - The policy is age-agnostic over stored signals; export columns carry
 *   last-checked timestamps so staleness stays visible. Freshness matters only
 *   to the already-satisfied gates that skip repeat paid checks.
 */
export const VALIDATION_FRESHNESS_DAYS = 30;

/** Narrow, test-friendly view of a phone contact point. */
export interface ReadinessPhone {
  id: string;
  role: PhoneRole;
  e164: string;
  formatValid: boolean | null;
  lineStatus: LineStatus | null;
  lineStatusCheckedAt: Date | string | null;
  lineStatusProvider: string | null;
  identityMatch: IdentityMatch | null;
}

export interface ReadinessInput {
  phones: ReadinessPhone[];
  /** Active suppression matches relevant to this lead. */
  suppressions: { scope: "phone" | "email" | "domain" | "lead"; normalizedValue: string }[];
  policy: PlanPolicy;
}

export interface ReadinessResult {
  status: CallReadinessStatus;
  reason: string;
}

/** Roles a campaign's policy accepts as callable, in preference order. */
export function acceptedPhoneRoles(policy: PlanPolicy): PhoneRole[] {
  return policy.requireDirectPhone || !policy.acceptBusinessMainPhone
    ? ["direct", "mobile"]
    : ["direct", "mobile", "business_main"];
}

const ROLE_PREFERENCE: Partial<Record<PhoneRole, number>> = { direct: 0, mobile: 1, business_main: 2 };

function isValidatedReady(p: ReadinessPhone): boolean {
  return p.formatValid === true && p.lineStatus === "active" && p.identityMatch !== "mismatch";
}

function isDisqualified(p: ReadinessPhone): boolean {
  return (
    p.formatValid === false ||
    p.lineStatus === "inactive" ||
    p.lineStatus === "unreachable" ||
    p.identityMatch === "mismatch"
  );
}

/**
 * Acceptance candidates in deterministic preference order: role preference
 * (direct > mobile > business_main), then validated-active first, format-valid
 * first, most recently status-checked first, id as the final tiebreak.
 * toll_free/unknown roles never qualify. Shared by the readiness policy, the
 * already-satisfied waterfall gates, and the export's per-role selection.
 */
export function selectAcceptancePhones(phones: ReadinessPhone[], policy: PlanPolicy): ReadinessPhone[] {
  const roles = acceptedPhoneRoles(policy);
  const ts = (v: Date | string | null): number => (v === null ? -1 : new Date(v).getTime());
  return phones
    .filter((p) => roles.includes(p.role) && p.e164.length > 0)
    .sort((a, b) => {
      const rolePref = (ROLE_PREFERENCE[a.role] ?? 9) - (ROLE_PREFERENCE[b.role] ?? 9);
      if (rolePref !== 0) return rolePref;
      const ready = Number(isValidatedReady(b)) - Number(isValidatedReady(a));
      if (ready !== 0) return ready;
      const format = Number(b.formatValid === true) - Number(a.formatValid === true);
      if (format !== 0) return format;
      const checked = ts(b.lineStatusCheckedAt) - ts(a.lineStatusCheckedAt);
      if (checked !== 0) return checked;
      return a.id.localeCompare(b.id);
    });
}

function dateOf(v: Date | string | null): string {
  if (v === null) return "unknown-date";
  return new Date(v).toISOString().slice(0, 10);
}

function describe(p: ReadinessPhone): string {
  const parts: string[] = [`${p.role} ${p.e164}`];
  if (p.formatValid === false) parts.push("format=invalid");
  if (p.lineStatus) parts.push(`line_status=${p.lineStatus}`);
  if (p.identityMatch && p.identityMatch !== "unknown") parts.push(`identity=${p.identityMatch}`);
  return parts.join(" ");
}

/** Pure policy evaluation — first matching rule wins. */
export function evaluateCallReadiness(input: ReadinessInput): ReadinessResult {
  const { policy } = input;

  // Rule 1: a lead- or domain-scope suppression covers every number.
  const leadScope = input.suppressions.find((s) => s.scope === "lead" || s.scope === "domain");
  if (leadScope) {
    return { status: "suppressed", reason: `lead suppressed (${leadScope.scope}:${leadScope.normalizedValue})` };
  }

  const candidates = selectAcceptancePhones(input.phones, policy);
  const suppressedValues = new Set(input.suppressions.filter((s) => s.scope === "phone").map((s) => s.normalizedValue));
  const isSuppressed = (p: ReadinessPhone): boolean => suppressedValues.has(p.e164);
  const open = candidates.filter((p) => !isSuppressed(p));

  // Rule 2: a callable, validated number that is not suppressed.
  const ready = open.find(isValidatedReady);
  if (ready) {
    const identity = ready.identityMatch && ready.identityMatch !== "unknown" ? `, identity=${ready.identityMatch}` : "";
    return {
      status: "ready",
      reason: `${ready.role} ${ready.e164} line_status=active${identity} (${ready.lineStatusProvider ?? "unknown"} ${dateOf(ready.lineStatusCheckedAt)})`,
    };
  }

  // Rule 3: nothing acceptable on file at all.
  if (candidates.length === 0) {
    const policyLabel = policy.acceptBusinessMainPhone ? "any business line" : "direct/mobile only";
    return { status: "invalid", reason: `no acceptable phone on file (policy: ${policyLabel})` };
  }

  // Rule 4: a validated number exists but every such number is suppressed —
  // or every candidate is suppressed regardless of validation state.
  const suppressedReady = candidates.filter((p) => isSuppressed(p) && isValidatedReady(p));
  if (suppressedReady.length > 0) {
    return {
      status: "suppressed",
      reason: `only callable number(s) suppressed: ${suppressedReady.map((p) => p.e164).join(", ")}`,
    };
  }
  if (open.length === 0) {
    return {
      status: "suppressed",
      reason: `all acceptable numbers are suppressed: ${candidates.map((p) => p.e164).join(", ")}`,
    };
  }

  // Rule 5: every remaining candidate is affirmatively disqualified.
  if (open.every(isDisqualified)) {
    return { status: "invalid", reason: open.map(describe).join("; ") };
  }

  // Rule 6: checked but the line status came back unknown.
  const checkedUnknown = open.find((p) => !isDisqualified(p) && p.lineStatusCheckedAt !== null);
  if (checkedUnknown) {
    return {
      status: "uncertain",
      reason: `${checkedUnknown.e164} checked but line status unknown (${checkedUnknown.lineStatusProvider ?? "unknown"} ${dateOf(checkedUnknown.lineStatusCheckedAt)})`,
    };
  }

  // Rule 7: candidates exist, none line-status-checked (cap-skipped,
  // override-disabled, rejected before validation, or checks still pending).
  return { status: "unchecked", reason: "phone validation not performed" };
}

export function readinessPhoneFromRow(row: Selectable<ContactPointsTable>): ReadinessPhone | null {
  if (row.type !== "phone" || row.normalized_value === null) return null;
  return {
    id: row.id,
    role: row.role as PhoneRole,
    e164: row.normalized_value,
    formatValid: row.format_valid,
    lineStatus: row.line_status,
    lineStatusCheckedAt: row.line_status_checked_at,
    lineStatusProvider: row.line_status_provider,
    identityMatch: row.identity_match,
  };
}

/**
 * Load signals + suppressions and persist the item's readiness. Runs inside
 * each contact-capability step's commit transaction (and on capability-step
 * skips) so the stored status always reflects the latest persisted signals.
 * Export-time suppression evaluation stays separate and is never stored.
 */
export async function recomputeCallReadiness(
  db: Kysely<Database>,
  args: { runItemId: string; leadId: string; agencyId: string; policy: PlanPolicy },
): Promise<ReadinessResult> {
  const [lead, contactPoints] = await Promise.all([
    getLead(db, args.leadId),
    listContactPoints(db, args.leadId),
  ]);
  const phones = contactPoints
    .map(readinessPhoneFromRow)
    .filter((p): p is ReadinessPhone => p !== null);
  const suppressionRows = await findActiveSuppressions(db, args.agencyId, {
    phones: phones.map((p) => p.e164),
    domains: lead?.normalized_domain ? [lead.normalized_domain] : [],
    leadIds: [args.leadId],
  });
  const result = evaluateCallReadiness({
    phones,
    suppressions: suppressionRows.map((s) => ({ scope: s.scope, normalizedValue: s.normalized_value })),
    policy: args.policy,
  });
  await updateRunItem(db, args.runItemId, {
    callReadinessStatus: result.status,
    callReadinessReason: result.reason,
  });
  return result;
}
