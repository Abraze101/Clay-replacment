import type { Kysely } from "kysely";

import { AmbiguousOutcomeError, AppError, PendingProviderJobError } from "../../shared/errors.js";
import type { Database } from "../../storage/database-types.js";
import type { ContactPointRow } from "../../storage/repositories/lead-repo.js";
import {
  appendContactPointCheck,
  getLead,
  insertContactPoint,
  listContactPoints,
  setVerifiedEmail,
  updateContactPointSignals,
  upsertLeadSource,
} from "../../storage/repositories/lead-repo.js";
import type { CapabilityJobState, RunItemRow, RunItemStepRow } from "../../storage/repositories/run-repo.js";
import { updateRunItem } from "../../storage/repositories/run-repo.js";
import type {
  ContactDiscoveryOutcome,
  ContactDiscoveryProvider,
  ContactDiscoveryRequest,
  EmailVerificationProvider,
  PhoneValidationProvider,
} from "../../providers/types.js";
import { discoveryCostPerRecord } from "../../providers/types.js";
import {
  VALIDATION_FRESHNESS_DAYS,
  readinessPhoneFromRow,
  recomputeCallReadiness,
  selectAcceptancePhones,
  type ReadinessPhone,
} from "../policy/call-readiness.js";
import {
  DEFAULT_PHONE_SIGNALS,
  discoveryWantedKinds,
  resolveCapabilityProvider,
  type PlanPolicy,
  type ResolvedPlan,
} from "../workflow-schema/plan.js";
import type { EnrichStep } from "../workflow-schema/steps.js";
import type { ExecCtx, ExecOutcome, ItemSnapshot, NormalizedFields } from "./executors.js";
import { normalizePhone } from "../records/normalize.js";

const EMAIL_FORMAT_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Pre-M5 stored plans carry no policy block; fall back to the default policy. */
export const DEFAULT_PLAN_POLICY: PlanPolicy = {
  requireDirectPhone: false,
  acceptBusinessMainPhone: true,
  acceptCatchAllEmail: false,
  phoneValidationRequested: false,
  emailVerificationRequested: false,
};

export interface CapabilityExecOpts {
  db: Kysely<Database>;
  stepRow: RunItemStepRow;
  plan: ResolvedPlan;
}

function freshEnough(checkedAt: Date | string | null): boolean {
  if (checkedAt === null) return false;
  const ageMs = Date.now() - new Date(checkedAt).getTime();
  return ageMs <= VALIDATION_FRESHNESS_DAYS * 24 * 3600 * 1000;
}

/** Preference order for the verification target: work > personal > unknown, format-valid first, oldest first. */
function orderedEmails(contactPoints: ContactPointRow[]): ContactPointRow[] {
  const rolePref: Record<string, number> = { work: 0, personal: 1, unknown: 2 };
  return contactPoints
    .filter((cp) => cp.type === "email" && cp.normalized_value !== null)
    .sort((a, b) => {
      const role = (rolePref[a.role] ?? 9) - (rolePref[b.role] ?? 9);
      if (role !== 0) return role;
      const format = Number(b.format_valid === true) - Number(a.format_valid === true);
      if (format !== 0) return format;
      return a.id.localeCompare(b.id);
    });
}

/**
 * Waterfall stop / duplicate-paid-check protection, evaluated BEFORE a cap
 * slot is booked (mirrors the review-rejected skip): when the lead already
 * satisfies the step's goal, the step skips free with this note. Returns null
 * when the step should run.
 */
export async function alreadySatisfiedNote(
  db: Kysely<Database>,
  item: RunItemRow,
  step: EnrichStep,
  policy: PlanPolicy | undefined,
  runInputs: Record<string, unknown>,
): Promise<string | null> {
  if (!item.lead_id) return null;
  const effective = policy ?? DEFAULT_PLAN_POLICY;

  if (!step.capability) {
    // Classic optional person/owner enrich: only in a continuation run (the
    // prior run may already have paid for this lead's contact data) does an
    // existing work email or verified email stop the waterfall.
    if (!step.optional || runInputs["continueFromRunId"] === undefined) return null;
    const lead = await getLead(db, item.lead_id);
    if (lead?.verified_email) return "already_satisfied";
    const contactPoints = await listContactPoints(db, item.lead_id);
    const hasWorkEmail = contactPoints.some((cp) => cp.type === "email" && cp.role === "work");
    return hasWorkEmail ? "already_satisfied" : null;
  }

  const contactPoints = await listContactPoints(db, item.lead_id);
  const phones = contactPoints.map(readinessPhoneFromRow).filter((p): p is ReadinessPhone => p !== null);
  const candidates = selectAcceptancePhones(phones, effective);

  switch (step.capability) {
    case "phone_discovery":
      // An acceptable, format-valid number already exists: no paid discovery.
      return candidates.some((p) => p.formatValid === true) ? "already_satisfied" : null;
    case "phone_validation": {
      if (candidates.length === 0) return null; // nothing to validate — the executor reports no_target
      const target = candidates.find((p) => !freshEnough(p.lineStatusCheckedAt));
      return target ? null : "already_satisfied";
    }
    case "email_discovery": {
      const lead = await getLead(db, item.lead_id);
      if (lead?.verified_email) return "already_satisfied";
      const hasEmail = contactPoints.some((cp) => cp.type === "email" && cp.role === "work");
      return hasEmail ? "already_satisfied" : null;
    }
    case "email_verification": {
      const lead = await getLead(db, item.lead_id);
      if (lead?.verified_email) return "already_satisfied";
      const emails = orderedEmails(contactPoints);
      if (emails.length === 0) return null;
      if (
        effective.acceptCatchAllEmail &&
        emails.some((cp) => cp.email_status === "catch_all")
      ) {
        return "already_satisfied";
      }
      const target = emails.find(
        (cp) => cp.email_status === "not_checked" || !freshEnough(cp.email_status_checked_at),
      );
      return target ? null : "already_satisfied";
    }
  }
}

/** Dispatch a contact-capability enrich step to its provider family. */
export async function executeContactCapability(ctx: ExecCtx, opts: CapabilityExecOpts): Promise<ExecOutcome> {
  const step = ctx.step as EnrichStep;
  const capability = step.capability;
  if (!capability) throw new AppError("INTERNAL", `Step '${step.id}' has no capability.`, {});
  const resolved = resolveCapabilityProvider(ctx.providers, capability, step.provider);
  if (!resolved) {
    throw new AppError("INTERNAL", `No provider configured for capability '${capability}'.`, { stepId: step.id });
  }
  if (!ctx.item.lead_id) {
    return { cost: 0, classification: "completed", providerRequestId: null, note: "no_lead", result: {} };
  }
  const policy = opts.plan.policy ?? DEFAULT_PLAN_POLICY;

  if (resolved.kind === "phone_validation") {
    return await executePhoneValidation(ctx, opts, resolved.provider, policy);
  }
  if (resolved.kind === "email_verification") {
    return await executeEmailVerification(ctx, opts, resolved.provider, policy);
  }
  return await executeDiscovery(ctx, opts, resolved.provider, policy, capability as "phone_discovery" | "email_discovery");
}

function snapshotOf(item: RunItemRow): ItemSnapshot {
  return item.snapshot as unknown as ItemSnapshot;
}

function normalizedOf(item: RunItemRow): NormalizedFields {
  const normalized = snapshotOf(item).normalized;
  if (!normalized) {
    throw new AppError("INTERNAL", `Item ${item.id} reached a contact step before normalization.`, { itemId: item.id });
  }
  return normalized;
}

/** Ambiguity guard for sync paid vendors (no job id to reconcile with). */
function guardSyncCrashReplay(ctx: ExecCtx, providerName: string, idempotentReplay: boolean | undefined, possibleCost: number): void {
  if (ctx.crashReplay && possibleCost > 0 && idempotentReplay !== true) {
    throw new AmbiguousOutcomeError(
      `Step '${ctx.step.id}' was interrupted after a paid call may have completed; provider '${providerName}' cannot confirm or dedupe it.`,
      possibleCost,
    );
  }
}

async function executePhoneValidation(
  ctx: ExecCtx,
  opts: CapabilityExecOpts,
  provider: PhoneValidationProvider,
  policy: PlanPolicy,
): Promise<ExecOutcome> {
  const step = ctx.step as EnrichStep;
  const leadId = ctx.item.lead_id as string;
  const signals = step.signals ?? [...DEFAULT_PHONE_SIGNALS];
  const contactPoints = await listContactPoints(opts.db, leadId);
  const phones = contactPoints.map(readinessPhoneFromRow).filter((p): p is ReadinessPhone => p !== null);
  const candidates = selectAcceptancePhones(phones, policy);
  const target = candidates.find((p) => !freshEnough(p.lineStatusCheckedAt));
  if (!target) {
    return {
      cost: 0,
      classification: "completed",
      providerRequestId: null,
      note: candidates.length === 0 ? "no_target" : "already_satisfied",
      result: { validated: false },
      commit: async (trx) => {
        await recomputeCallReadiness(trx, { runItemId: ctx.item.id, leadId, agencyId: ctx.agencyId, policy });
      },
    };
  }

  const estimatedCost = signals.reduce((sum, s) => sum + (provider.costPerSignal[s] ?? 0), 0);
  guardSyncCrashReplay(ctx, provider.name, provider.idempotentReplay, estimatedCost);

  const normalized = normalizedOf(ctx.item);
  const result = await provider.validate({
    requestKey: ctx.requestKey,
    phoneE164: target.e164,
    signals,
    identityHint:
      normalized.kind === "person"
        ? { kind: "person", firstName: normalized.firstName, lastName: normalized.lastName }
        : { kind: "business", name: normalized.displayName, locality: normalized.locality, region: normalized.region },
  });

  const checkedAt = new Date();
  return {
    cost: result.cost,
    classification: "completed",
    providerRequestId: result.providerRequestId,
    note: result.formatValid ? "validated" : "format_invalid",
    result: {
      phone: target.e164,
      formatValid: result.formatValid,
      lineType: result.lineType?.value ?? null,
      lineStatus: result.lineStatus?.value ?? null,
      identityMatch: result.identityMatch?.value ?? null,
    },
    commit: async (trx, stepRowId) => {
      if (!result.formatValid) {
        await updateContactPointSignals(trx, target.id, { provider: provider.name, checkedAt, formatValid: false });
        await appendContactPointCheck(trx, {
          contactPointId: target.id,
          method: "format",
          provider: provider.name,
          result: "invalid",
          requestId: result.providerRequestId,
          runItemStepId: stepRowId,
          costUnits: result.cost,
        });
      } else {
        await updateContactPointSignals(trx, target.id, {
          provider: provider.name,
          checkedAt,
          ...(result.lineType ? { lineType: result.lineType.value } : {}),
          ...(result.lineStatus ? { lineStatus: result.lineStatus.value } : {}),
          ...(result.identityMatch ? { identityMatch: result.identityMatch.value } : {}),
        });
        // One check row per signal actually returned; the call's cost is
        // booked once (on the first row), never per signal.
        let costBooked = false;
        for (const [method, signal] of [
          ["line_type", result.lineType],
          ["line_status", result.lineStatus],
          ["identity_match", result.identityMatch],
        ] as const) {
          if (!signal) continue;
          await appendContactPointCheck(trx, {
            contactPointId: target.id,
            method,
            provider: provider.name,
            result: signal.value,
            detail: signal.raw ?? {},
            confidence: signal.confidence ?? null,
            requestId: result.providerRequestId,
            runItemStepId: stepRowId,
            costUnits: costBooked ? 0 : result.cost,
          });
          costBooked = true;
        }
      }
      await recomputeCallReadiness(trx, { runItemId: ctx.item.id, leadId, agencyId: ctx.agencyId, policy });
    },
  };
}

async function executeEmailVerification(
  ctx: ExecCtx,
  opts: CapabilityExecOpts,
  provider: EmailVerificationProvider,
  policy: PlanPolicy,
): Promise<ExecOutcome> {
  const leadId = ctx.item.lead_id as string;
  const contactPoints = await listContactPoints(opts.db, leadId);
  const emails = orderedEmails(contactPoints);
  const target = emails.find((cp) => cp.email_status === "not_checked" || !freshEnough(cp.email_status_checked_at));
  if (!target?.normalized_value) {
    return {
      cost: 0,
      classification: "completed",
      providerRequestId: null,
      note: emails.length === 0 ? "no_target" : "already_satisfied",
      result: { verified: false },
      commit: async (trx) => {
        await recomputeCallReadiness(trx, { runItemId: ctx.item.id, leadId, agencyId: ctx.agencyId, policy });
      },
    };
  }
  const email = target.normalized_value;

  guardSyncCrashReplay(ctx, provider.name, provider.idempotentReplay, provider.costPerRecord);

  const result = await provider.verify({ requestKey: ctx.requestKey, email });
  const checkedAt = new Date();
  return {
    cost: result.cost,
    classification: "completed",
    providerRequestId: result.providerRequestId,
    note: `email_${result.status}`,
    result: { email, status: result.status, ...(result.subStatus ? { subStatus: result.subStatus } : {}) },
    commit: async (trx, stepRowId) => {
      await updateContactPointSignals(trx, target.id, {
        provider: provider.name,
        checkedAt,
        emailStatus: result.status,
        ...(result.confidence !== undefined ? { confidence: result.confidence } : {}),
      });
      await appendContactPointCheck(trx, {
        contactPointId: target.id,
        method: "email_deliverability",
        provider: provider.name,
        result: result.status,
        detail: { ...(result.subStatus ? { subStatus: result.subStatus } : {}), ...(result.raw ?? {}) },
        confidence: result.confidence ?? null,
        requestId: result.providerRequestId,
        runItemStepId: stepRowId,
        costUnits: result.cost,
      });
      const snapshot = snapshotOf(ctx.item);
      if (result.status === "valid") {
        // The FIRST writer of leads.verified_email; a holder conflict flags
        // instead of merging and leaves the column NULL.
        await setVerifiedEmail(trx, { leadId, agencyId: ctx.agencyId, runId: ctx.run.id, email });
        await updateRunItem(trx, ctx.item.id, {
          snapshot: {
            ...snapshot,
            contacts: { ...snapshot.contacts, workEmail: snapshot.contacts?.workEmail ?? email, verifiedEmail: email },
          },
        });
      }
      await recomputeCallReadiness(trx, { runItemId: ctx.item.id, leadId, agencyId: ctx.agencyId, policy });
    },
  };
}

async function executeDiscovery(
  ctx: ExecCtx,
  opts: CapabilityExecOpts,
  provider: ContactDiscoveryProvider,
  policy: PlanPolicy,
  capability: "phone_discovery" | "email_discovery",
): Promise<ExecOutcome> {
  const leadId = ctx.item.lead_id as string;
  const normalized = normalizedOf(ctx.item);
  const snapshot = snapshotOf(ctx.item);
  const wanted = discoveryWantedKinds(capability);
  const worstCaseCost = discoveryCostPerRecord(provider, wanted);
  const jobState = (opts.stepRow.result as { capabilityJob?: CapabilityJobState }).capabilityJob;

  const request: ContactDiscoveryRequest = {
    requestKey: jobState?.requestKey ?? ctx.requestKey,
    wanted,
    person: {
      firstName: normalized.firstName,
      lastName: normalized.lastName,
      fullName: normalized.kind === "person" ? normalized.displayName : normalized.contactName,
      title: normalized.title,
      linkedinUrl: normalized.normalizedLinkedinUrl,
    },
    company: {
      name: normalized.kind === "business" ? normalized.displayName : normalized.employerName,
      domain: normalized.normalizedDomain ?? normalized.employerDomain,
      websiteUrl: normalized.websiteUrl ?? normalized.employerWebsiteUrl,
    },
  };

  let outcome: ContactDiscoveryOutcome;
  let effectiveJob = jobState;
  if (effectiveJob) {
    if (!provider.poll) {
      throw new AppError("INTERNAL", `Provider '${provider.name}' has a pending job but no poll().`, {});
    }
    const budgetMs = (provider.maxPollSeconds ?? 600) * 1000;
    if (Date.now() - new Date(effectiveJob.submittedAt).getTime() > budgetMs) {
      throw new AmbiguousOutcomeError(
        `Discovery job '${effectiveJob.jobId}' exceeded its poll budget; the vendor may still deliver and charge. Reconcile against the ${provider.name} dashboard.`,
        worstCaseCost,
        { jobId: effectiveJob.jobId, provider: provider.name },
      );
    }
    outcome = await provider.poll(effectiveJob.jobId, request);
  } else if (ctx.crashReplay && worstCaseCost > 0 && provider.idempotentReplay !== true) {
    // Submit may have completed before the crash. A vendor that echoes our
    // client reference lets us reconcile by finding the job; otherwise the
    // interrupted paid submit is booked ambiguous (never re-executed).
    const found = provider.findJobByRequestKey ? await provider.findJobByRequestKey(ctx.requestKey) : null;
    if (!found || !provider.poll) {
      throw new AmbiguousOutcomeError(
        `Step '${ctx.step.id}' was interrupted after a paid submit may have completed; provider '${provider.name}' cannot confirm it.`,
        worstCaseCost,
      );
    }
    effectiveJob = {
      jobId: found.jobId,
      provider: provider.name,
      requestKey: ctx.requestKey,
      submittedAt: new Date().toISOString(),
      polls: 0,
    };
    outcome = await provider.poll(found.jobId, request);
  } else {
    outcome = await provider.discover(request);
  }

  if (outcome.kind === "pending") {
    throw new PendingProviderJobError(
      `Discovery job '${outcome.jobId}' is pending at ${provider.name}; polling again in ${outcome.pollAfterSeconds}s.`,
      outcome.jobId,
      outcome.pollAfterSeconds,
      {
        jobState: {
          jobId: outcome.jobId,
          provider: provider.name,
          requestKey: request.requestKey,
          submittedAt: effectiveJob?.submittedAt ?? new Date().toISOString(),
          polls: (effectiveJob?.polls ?? 0) + (effectiveJob ? 1 : 0),
        } satisfies CapabilityJobState,
      },
    );
  }

  if (outcome.kind === "no_result") {
    return {
      cost: outcome.cost,
      classification: "completed",
      providerRequestId: outcome.providerRequestId,
      note: "no_result",
      result: { found: 0 },
      commit: async (trx) => {
        await recomputeCallReadiness(trx, { runItemId: ctx.item.id, leadId, agencyId: ctx.agencyId, policy });
      },
    };
  }

  const contacts = outcome.contacts;
  const phonesFound = contacts.filter((c) => c.type === "phone").length;
  const emailsFound = contacts.filter((c) => c.type === "email").length;
  return {
    cost: outcome.cost,
    classification: "completed",
    providerRequestId: outcome.providerRequestId,
    note: `found ${contacts.length} contact(s)`,
    result: { found: contacts.length, phones: phonesFound, emails: emailsFound },
    commit: async (trx, stepRowId) => {
      await upsertLeadSource(trx, {
        leadId,
        runId: ctx.run.id,
        runItemId: ctx.item.id,
        provider: provider.name,
        providerRecordId: `${snapshot.source.sourceKey}:${capability}`,
        requestId: outcome.providerRequestId,
        snapshot: {
          contacts: contacts.map((c) => ({ type: c.type, role: c.role, claim: c.vendorStatusClaim ?? null })),
        },
      });

      let firstDirectPhone: string | null = null;
      let firstWorkEmail: string | null = null;
      for (const contact of contacts) {
        if (contact.type === "phone") {
          const parsed = normalizePhone(contact.value);
          const cp = await insertContactPoint(trx, {
            leadId,
            type: "phone",
            role: contact.role,
            rawValue: contact.value,
            normalizedValue: parsed?.e164 ?? null,
            sourceProvider: provider.name,
            sourceRunItemId: ctx.item.id,
            sourceMetadata: contact.vendorStatusClaim ? { providerClaimedStatus: contact.vendorStatusClaim } : {},
            confidence: contact.confidence ?? null,
            formatValid: parsed ? parsed.formatValid : false,
            formatCheckedAt: new Date(),
          });
          await appendContactPointCheck(trx, {
            contactPointId: cp.id,
            method: "format",
            provider: "engine",
            result: parsed?.formatValid ? "valid" : "invalid",
            detail: { e164: parsed?.e164 ?? null },
            runItemStepId: stepRowId,
          });
          if (!firstDirectPhone && parsed?.formatValid && (contact.role === "direct" || contact.role === "mobile")) {
            firstDirectPhone = parsed.e164;
          }
        } else {
          const email = contact.value.trim().toLowerCase();
          const cp = await insertContactPoint(trx, {
            leadId,
            type: "email",
            role: contact.role,
            rawValue: contact.value,
            normalizedValue: email,
            sourceProvider: provider.name,
            sourceRunItemId: ctx.item.id,
            // Discovery is never verification: the vendor's own claim stays
            // data; the address enters as not_checked.
            sourceMetadata: contact.vendorStatusClaim ? { providerClaimedStatus: contact.vendorStatusClaim } : {},
            confidence: contact.confidence ?? null,
            formatValid: EMAIL_FORMAT_RE.test(email),
            formatCheckedAt: new Date(),
            emailStatus: "not_checked",
          });
          await appendContactPointCheck(trx, {
            contactPointId: cp.id,
            method: "format",
            provider: "engine",
            result: EMAIL_FORMAT_RE.test(email) ? "valid" : "invalid",
            runItemStepId: stepRowId,
          });
          if (!firstWorkEmail && contact.role === "work") firstWorkEmail = email;
        }
      }

      await updateRunItem(trx, ctx.item.id, {
        snapshot: {
          ...snapshot,
          contacts: {
            ...snapshot.contacts,
            ...(firstDirectPhone ? { directPhoneE164: firstDirectPhone } : {}),
            ...(firstWorkEmail ? { workEmail: firstWorkEmail } : {}),
            phonesFound: (snapshot.contacts?.phonesFound ?? 0) + phonesFound,
            emailsFound: (snapshot.contacts?.emailsFound ?? 0) + emailsFound,
          },
        },
      });
      await recomputeCallReadiness(trx, { runItemId: ctx.item.id, leadId, agencyId: ctx.agencyId, policy });
    },
  };
}
