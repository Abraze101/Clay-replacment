import type { Kysely } from "kysely";

import { AmbiguousOutcomeError, AppError } from "../../shared/errors.js";
import type { AttemptClassification, Database, JsonObject } from "../../storage/database-types.js";
import type { RunItemRow, RunRow } from "../../storage/repositories/run-repo.js";
import { attachLead, updateRunItem } from "../../storage/repositories/run-repo.js";
import type { NewLead } from "../../storage/repositories/lead-repo.js";
import {
  appendContactPointCheck,
  findLeadByApolloOrgId,
  findLeadsByDomain,
  insertContactPoint,
  insertLead,
  setLeadIdentityKeys,
  upsertLeadSource,
} from "../../storage/repositories/lead-repo.js";
import { insertIdentityConflict } from "../../storage/repositories/identity-conflict-repo.js";
import { appendGeneratedOutput } from "../../storage/repositories/output-repo.js";
import type { EnrichProvider, ProviderRegistry, SourceRecord } from "../../providers/types.js";
import { resolveIdentity } from "../dedupe/identity.js";
import { nameKey, normalizeLinkedinUrl, normalizePhone, normalizeSourceRecord } from "../records/normalize.js";
import { usStateTimezone } from "../records/timezone.js";
import { SCORE_TEMPLATES, evaluateTemplate } from "../scoring/templates.js";
import type { FieldContext } from "../workflow-schema/rules.js";
import { evaluateRuleGroup } from "../workflow-schema/rules.js";
import type { FilterStep, ResearchStep, ScoreStep, WorkflowStep } from "../workflow-schema/steps.js";

/** Bounded per-item working data (run_items.snapshot). Never raw provider payloads. */
export interface ItemSnapshot {
  source: SourceRecord;
  sourceRequestId?: string;
  sourceRetrievedAt?: string;
  normalized?: NormalizedFields;
  sourceLeadSourceId?: string;
  conflict?: { identifier: string; value: string; existingLeadId: string };
  duplicateOfLeadId?: string;
  enrichment?: {
    personName: string;
    title: string;
    directPhoneE164: string | null;
    workEmail: string | null;
    providerRequestId: string;
    /** Canonical LinkedIn URL the match revealed (approved source), if any. */
    linkedinUrl?: string | null;
    /** NEVER set in M4 — only a 'valid' deliverability check (M5) writes it. */
    verifiedEmail?: string | null;
  };
  research?: { incomplete: boolean; summary?: string; leadSourceId?: string; reason?: string };
}

export interface NormalizedFields {
  kind: "business" | "person";
  displayName: string;
  firstName: string | null;
  lastName: string | null;
  title: string | null;
  contactName: string | null;
  category: string | null;
  websiteUrl: string | null;
  normalizedDomain: string | null;
  addressLine: string | null;
  locality: string | null;
  region: string | null;
  country: string | null;
  phoneRaw: string | null;
  phoneE164: string | null;
  phoneFormatValid: boolean | null;
  email: string | null;
  normalizedLinkedinUrl: string | null;
  apolloPersonId: string | null;
  employerName: string | null;
  employerWebsiteUrl: string | null;
  employerDomain: string | null;
  apolloOrganizationId: string | null;
  rating: number | null;
  reviewCount: number | null;
}

/**
 * Deterministic rule-field context from the persisted snapshot. Person fields
 * are null/false before enrichment (a filter placed before enrich simply sees
 * exists → false). Enriched values win over source values; has_verified_email
 * stays false until a real deliverability check writes it (M5) — an email a
 * provider merely found NEVER sets it.
 */
export function buildFieldContext(snapshot: ItemSnapshot, normalized: NormalizedFields): FieldContext {
  const enrichment = snapshot.enrichment;
  return {
    name: normalized.displayName,
    category: normalized.category,
    locality: normalized.locality,
    region: normalized.region,
    country: normalized.country,
    // For a person lead the "has a website" signal is the employer's domain.
    has_website:
      normalized.kind === "person"
        ? normalized.employerDomain !== null || normalized.employerWebsiteUrl !== null
        : normalized.websiteUrl !== null,
    rating: normalized.rating,
    review_count: normalized.reviewCount,
    phone_format_valid: normalized.phoneFormatValid,
    title: enrichment?.title ?? normalized.title,
    employer_name: normalized.employerName,
    has_linkedin: Boolean(enrichment?.linkedinUrl ?? normalized.normalizedLinkedinUrl),
    has_email: Boolean(enrichment?.workEmail ?? normalized.email),
    has_verified_email: Boolean(enrichment?.verifiedEmail),
    has_direct_phone: (enrichment?.directPhoneE164 ?? null) !== null,
  };
}

export interface ExecOutcome {
  cost: number;
  classification: AttemptClassification;
  providerRequestId: string | null;
  note: string;
  result: JsonObject;
  /** Domain effects committed in the SAME transaction as the ledger finalize. */
  commit?: (trx: Kysely<Database>, stepRowId: string) => Promise<void>;
}

export interface ExecCtx {
  providers: ProviderRegistry;
  run: RunRow;
  item: RunItemRow;
  step: WorkflowStep;
  requestKey: string;
  /** True when this execution replays a step left `running` by a crash. */
  crashReplay: boolean;
  agencyId: string;
}

function snapshotOf(item: RunItemRow): ItemSnapshot {
  return item.snapshot as unknown as ItemSnapshot;
}

function requireNormalized(item: RunItemRow): NormalizedFields {
  const normalized = snapshotOf(item).normalized;
  if (!normalized) {
    throw new AppError("INTERNAL", `Item ${item.id} reached a step that requires normalization first.`, {
      itemId: item.id,
    });
  }
  return normalized;
}

const EMAIL_FORMAT_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ---------------------------------------------------------------------------

export function executeNormalize(ctx: ExecCtx): ExecOutcome {
  const snapshot = snapshotOf(ctx.item);
  const n = normalizeSourceRecord(snapshot.source);
  const normalized: NormalizedFields = {
    kind: n.kind,
    displayName: n.displayName,
    firstName: n.firstName,
    lastName: n.lastName,
    title: n.title,
    contactName: n.contactName,
    category: n.category,
    websiteUrl: n.websiteUrl,
    normalizedDomain: n.normalizedDomain,
    addressLine: n.addressLine,
    locality: n.locality,
    region: n.region,
    country: n.country,
    phoneRaw: n.phone?.raw ?? null,
    phoneE164: n.phone?.e164 ?? null,
    phoneFormatValid: n.phone ? n.phone.formatValid : null,
    email: n.email,
    normalizedLinkedinUrl: n.normalizedLinkedinUrl,
    apolloPersonId: n.apolloPersonId,
    employerName: n.employerName,
    employerWebsiteUrl: n.employerWebsiteUrl,
    employerDomain: n.employerDomain,
    apolloOrganizationId: n.apolloOrganizationId,
    rating: n.rating,
    reviewCount: n.reviewCount,
  };
  return {
    cost: 0,
    classification: "completed",
    providerRequestId: null,
    note: "normalized",
    result: { domain: normalized.normalizedDomain, phoneFormatValid: normalized.phoneFormatValid },
    commit: async (trx) => {
      await updateRunItem(trx, ctx.item.id, {
        snapshot: { ...snapshot, normalized },
      });
    },
  };
}

export function executeDedupe(ctx: ExecCtx): ExecOutcome {
  const snapshot = snapshotOf(ctx.item);
  const normalized = requireNormalized(ctx.item);
  const sourceProvider = ctx.item.snapshot["source"] ? snapshot.source : null;
  if (!sourceProvider) throw new AppError("INTERNAL", "Missing source snapshot.", { itemId: ctx.item.id });

  const providerName = providerNameFromRun(ctx.run);

  return {
    cost: 0,
    classification: "completed",
    providerRequestId: null,
    note: "dedupe",
    result: {},
    commit: async (trx, stepRowId) => {
      const resolution = await resolveIdentity(trx, {
        agencyId: ctx.agencyId,
        kind: normalized.kind,
        sourceProvider: providerName,
        sourceProviderId: snapshot.source.sourceKey,
        displayName: normalized.displayName,
        normalizedDomain: normalized.normalizedDomain,
        normalizedPhone: normalized.phoneE164,
        locality: normalized.locality,
        apolloPersonId: normalized.apolloPersonId,
        normalizedLinkedinUrl: normalized.normalizedLinkedinUrl,
      });

      const createLead = async (opts: { omitLinkedin?: boolean } = {}): Promise<string> => {
        const values: NewLead =
          normalized.kind === "person"
            ? {
                agencyId: ctx.agencyId,
                kind: "person",
                displayName: normalized.displayName,
                firstName: normalized.firstName,
                lastName: normalized.lastName,
                title: normalized.title,
                employerLeadId: await findOrCreateEmployerLead(trx, ctx, providerName, normalized),
                locality: normalized.locality,
                region: normalized.region,
                country: normalized.country,
                // A person lead never carries the employer's domain/phone as
                // its own identity — that lives on the employer lead.
                normalizedDomain: null,
                normalizedPhone: null,
                sourceProvider: providerName,
                sourceProviderId: snapshot.source.sourceKey,
                timezone: usStateTimezone(normalized.region, normalized.country),
                apolloPersonId: normalized.apolloPersonId,
                normalizedLinkedinUrl: opts.omitLinkedin ? null : normalized.normalizedLinkedinUrl,
              }
            : {
                agencyId: ctx.agencyId,
                kind: "business",
                displayName: normalized.displayName,
                category: normalized.category,
                websiteUrl: normalized.websiteUrl,
                addressLine: normalized.addressLine,
                locality: normalized.locality,
                region: normalized.region,
                country: normalized.country,
                normalizedDomain: normalized.normalizedDomain,
                normalizedPhone: normalized.phoneE164,
                sourceProvider: providerName,
                sourceProviderId: snapshot.source.sourceKey,
                // Cross-provider Google place_id from a `pid:` source key; numeric CID stays in the snapshot.
                placeId: snapshot.source.sourceKey.startsWith("pid:")
                  ? snapshot.source.sourceKey.slice("pid:".length)
                  : null,
                timezone: usStateTimezone(normalized.region, normalized.country),
                // An imported row's /in/ LinkedIn URL identifies the CONTACT
                // person, not the business — it stays out of the business
                // lead's identity and reaches enrichment via the snapshot.
              };
        return (await insertLead(trx, values)).id;
      };

      if (resolution.kind === "conflict") {
        // Uniform conflict persistence (M4): the new lead still exists — with
        // the conflicting STRONG identifier left NULL so the partial unique
        // cannot fire (weak identifiers like domain are non-unique and stay
        // populated) — the pair is durably flagged in identity_conflicts, and
        // the item stays out of paid steps and exports. Flag, never merge.
        const conflictLeadId = await createLead({
          omitLinkedin: resolution.identifier === "normalized_linkedin_url",
        });
        await attachLead(trx, ctx.item.id, ctx.run.id, conflictLeadId, "conflict");
        await insertIdentityConflict(trx, {
          leadIdA: resolution.leadId,
          leadIdB: conflictLeadId,
          identifierType: resolution.identifier,
          identifierValue: resolution.value,
          runId: ctx.run.id,
        });
        await upsertLeadSource(trx, {
          leadId: conflictLeadId,
          runId: ctx.run.id,
          runItemId: ctx.item.id,
          provider: providerName,
          providerRecordId: snapshot.source.sourceKey,
          requestId: snapshot.sourceRequestId ?? null,
          snapshot: snapshot.source,
        });
        await updateRunItem(trx, ctx.item.id, {
          status: "skipped",
          skipReason: "identity_conflict",
          dedupeStatus: "conflict",
          snapshot: {
            ...snapshot,
            conflict: {
              identifier: resolution.identifier,
              value: resolution.value,
              existingLeadId: resolution.leadId,
            },
          },
        });
        return;
      }

      const leadId = resolution.kind === "matched" ? resolution.leadId : await createLead();

      const attach = await attachLead(
        trx,
        ctx.item.id,
        ctx.run.id,
        leadId,
        resolution.kind === "matched" ? "matched" : "new",
      );
      if (!attach.attached) {
        // The same lead surfaced under a second source key WITHIN this run —
        // a conflicting-identifier situation: flag it, never attach twice
        // (UNIQUE (run_id, lead_id)), never merge.
        await updateRunItem(trx, ctx.item.id, {
          status: "skipped",
          skipReason: "identity_conflict",
          dedupeStatus: "matched",
          snapshot: { ...snapshot, duplicateOfLeadId: leadId },
        });
        return;
      }

      const leadSource = await upsertLeadSource(trx, {
        leadId,
        runId: ctx.run.id,
        runItemId: ctx.item.id,
        provider: providerName,
        providerRecordId: snapshot.source.sourceKey,
        requestId: snapshot.sourceRequestId ?? null,
        snapshot: snapshot.source,
      });

      if (normalized.phoneRaw !== null && normalized.phoneFormatValid !== null) {
        const cp = await insertContactPoint(trx, {
          leadId,
          type: "phone",
          role: "business_main",
          rawValue: normalized.phoneRaw,
          normalizedValue: normalized.phoneE164,
          sourceProvider: providerName,
          sourceRunItemId: ctx.item.id,
          formatValid: normalized.phoneFormatValid,
          formatCheckedAt: new Date(),
        });
        await appendContactPointCheck(trx, {
          contactPointId: cp.id,
          method: "format",
          provider: "engine",
          result: normalized.phoneFormatValid ? "valid" : "invalid",
          detail: { e164: normalized.phoneE164 },
          runItemStepId: stepRowId,
        });
      }

      if (normalized.email !== null) {
        // An imported email is discovery, not verification: it enters as
        // not_checked and only a real deliverability check (M5) upgrades it.
        const cp = await insertContactPoint(trx, {
          leadId,
          type: "email",
          role: "work",
          rawValue: normalized.email,
          normalizedValue: normalized.email,
          sourceProvider: providerName,
          sourceRunItemId: ctx.item.id,
          formatValid: EMAIL_FORMAT_RE.test(normalized.email),
          formatCheckedAt: new Date(),
          emailStatus: "not_checked",
        });
        await appendContactPointCheck(trx, {
          contactPointId: cp.id,
          method: "format",
          provider: "engine",
          result: EMAIL_FORMAT_RE.test(normalized.email) ? "valid" : "invalid",
          runItemStepId: stepRowId,
        });
      }

      await updateRunItem(trx, ctx.item.id, {
        snapshot: { ...snapshot, sourceLeadSourceId: leadSource.id },
        dedupeStatus: resolution.kind === "matched" ? "matched" : "new",
      });
    },
  };
}

/**
 * Find-or-create the employer business lead for a person hit (M4): match on
 * apollo_organization_id first, then weak domain + normalized name (with a
 * conflict-safe org-id backfill). No credible match creates a NEW employer
 * lead — same-domain/different-name stays a separate lead by design (domain is
 * deliberately non-unique), and employer ambiguity never blocks or flags the
 * person item. The org:<id> source identity keeps the create idempotent.
 */
async function findOrCreateEmployerLead(
  trx: Kysely<Database>,
  ctx: ExecCtx,
  providerName: string,
  normalized: NormalizedFields,
): Promise<string | null> {
  const { employerName, employerWebsiteUrl, employerDomain, apolloOrganizationId } = normalized;
  if (!employerName && !employerDomain && !apolloOrganizationId) return null;

  if (apolloOrganizationId) {
    const byOrg = await findLeadByApolloOrgId(trx, ctx.agencyId, apolloOrganizationId);
    if (byOrg) return byOrg.id;
  }
  if (employerDomain && employerName) {
    const byDomain = await findLeadsByDomain(trx, ctx.agencyId, employerDomain);
    const match = byDomain.find((l) => l.kind === "business" && nameKey(l.display_name) === nameKey(employerName));
    if (match) {
      if (apolloOrganizationId) {
        await setLeadIdentityKeys(trx, {
          leadId: match.id,
          agencyId: ctx.agencyId,
          runId: ctx.run.id,
          keys: { apolloOrganizationId },
        });
      }
      return match.id;
    }
  }

  const inserted = await insertLead(trx, {
    agencyId: ctx.agencyId,
    kind: "business",
    displayName: employerName ?? employerDomain ?? "Unknown employer",
    websiteUrl: employerWebsiteUrl,
    normalizedDomain: employerDomain,
    sourceProvider: providerName,
    sourceProviderId: `org:${apolloOrganizationId ?? employerDomain ?? nameKey(employerName ?? "")}`,
    apolloOrganizationId,
  });
  return inserted.id;
}

export function executeFilter(ctx: ExecCtx): ExecOutcome {
  const step = ctx.step as FilterStep;
  const normalized = requireNormalized(ctx.item);
  const passed = evaluateRuleGroup(step.conditions, buildFieldContext(snapshotOf(ctx.item), normalized));
  return {
    cost: 0,
    classification: "completed",
    providerRequestId: null,
    note: passed ? "passed" : "filtered",
    result: { passed },
    commit: passed
      ? undefined
      : async (trx) => {
          await updateRunItem(trx, ctx.item.id, { status: "skipped", skipReason: "filtered" });
        },
  };
}

export async function executeResearch(ctx: ExecCtx): Promise<ExecOutcome> {
  const step = ctx.step as ResearchStep;
  const provider = ctx.providers.researchers.get(step.provider);
  if (!provider) throw new AppError("INTERNAL", `Unregistered research provider '${step.provider}'.`, {});
  const cost = provider.costPerRecord ?? 0;
  // Crash replay of a PAID research call: unlike the fake enrich provider,
  // live research providers (Firecrawl) offer no request-key idempotency, so
  // re-executing could double-charge. The interrupted attempt may have
  // completed and been billed — book it as ambiguous for review instead.
  if (ctx.crashReplay && cost > 0) {
    throw new AmbiguousOutcomeError(
      `Research step '${step.id}' was interrupted after a paid call may have completed; provider '${provider.name}' cannot confirm or dedupe it.`,
      cost,
    );
  }
  const normalized = requireNormalized(ctx.item);
  const snapshot = snapshotOf(ctx.item);
  const outcome = await provider.research({
    websiteUrl: normalized.websiteUrl,
    normalizedDomain: normalized.normalizedDomain,
  });

  if (outcome.kind === "unavailable") {
    // Continue with source data; mark research incomplete (failure table rule).
    return {
      cost: 0,
      classification: "completed",
      providerRequestId: null,
      note: "research_unavailable",
      result: { incomplete: true, reason: outcome.reason },
      commit: async (trx) => {
        await updateRunItem(trx, ctx.item.id, {
          snapshot: { ...snapshot, research: { incomplete: true, reason: outcome.reason } },
        });
      },
    };
  }

  return {
    // A live research provider (Firecrawl) charges per successful scrape; the
    // fake provider is free (costPerRecord undefined).
    cost: provider.costPerRecord ?? 0,
    classification: "completed",
    providerRequestId: outcome.providerRequestId,
    note: "researched",
    result: { incomplete: false },
    commit: async (trx) => {
      if (!ctx.item.lead_id) return;
      const leadSource = await upsertLeadSource(trx, {
        leadId: ctx.item.lead_id,
        runId: ctx.run.id,
        runItemId: ctx.item.id,
        provider: provider.name,
        providerRecordId: normalized.normalizedDomain ?? snapshot.source.sourceKey,
        requestId: outcome.providerRequestId,
        snapshot: { summary: outcome.summary, facts: outcome.facts },
      });
      await updateRunItem(trx, ctx.item.id, {
        snapshot: {
          ...snapshot,
          research: { incomplete: false, summary: outcome.summary, leadSourceId: leadSource.id },
        },
      });
    },
  };
}

export async function executeEnrich(ctx: ExecCtx, provider: EnrichProvider): Promise<ExecOutcome> {
  const normalized = requireNormalized(ctx.item);
  const snapshot = snapshotOf(ctx.item);
  // Crash replay of a PAID enrichment: unless the provider proves request-key
  // idempotency (the fake provider's persisted ledger), re-executing could
  // double-charge — the interrupted attempt may have completed and been
  // billed. Book it as ambiguous for review instead (never auto-retry a
  // possibly-completed paid call).
  if (ctx.crashReplay && provider.costPerRecord > 0 && provider.idempotentReplay !== true) {
    throw new AmbiguousOutcomeError(
      `Enrich step '${ctx.step.id}' was interrupted after a paid call may have completed; provider '${provider.name}' cannot confirm or dedupe it.`,
      provider.costPerRecord,
    );
  }
  // May throw RetryableProviderError / AmbiguousOutcomeError — handled by the runner.
  const outcome = await provider.enrich({
    requestKey: ctx.requestKey,
    sourceKey: snapshot.source.sourceKey,
    name: normalized.displayName,
    normalizedDomain: normalized.normalizedDomain,
    normalizedPhone: normalized.phoneE164,
    locality: normalized.locality,
    kind: normalized.kind,
    firstName: normalized.firstName,
    lastName: normalized.lastName,
    title: normalized.title,
    apolloPersonId: normalized.apolloPersonId,
    normalizedLinkedinUrl: normalized.normalizedLinkedinUrl,
    employerName: normalized.employerName,
    employerDomain: normalized.employerDomain,
  });

  if (outcome.kind === "no_match") {
    // A business without an enrichment match remains a valid lead.
    return {
      cost: outcome.cost,
      classification: "completed",
      providerRequestId: outcome.providerRequestId,
      note: "no_match",
      result: { matched: false },
    };
  }

  const person = outcome.person;
  const directPhone = person.directPhone ? normalizePhone(person.directPhone) : null;
  const workEmail = person.workEmail?.trim().toLowerCase() ?? null;
  const revealedLinkedin = normalizeLinkedinUrl(person.linkedinUrl);

  return {
    cost: outcome.cost,
    classification: "completed",
    providerRequestId: outcome.providerRequestId,
    note: "match",
    result: { matched: true, hasDirectPhone: directPhone !== null, hasWorkEmail: workEmail !== null },
    commit: async (trx, stepRowId) => {
      if (!ctx.item.lead_id) return;
      const leadId = ctx.item.lead_id;

      await upsertLeadSource(trx, {
        leadId,
        runId: ctx.run.id,
        runItemId: ctx.item.id,
        provider: provider.name,
        providerRecordId: `${snapshot.source.sourceKey}:person`,
        requestId: outcome.providerRequestId,
        snapshot: {
          firstName: person.firstName,
          lastName: person.lastName,
          title: person.title,
        },
      });

      if (directPhone) {
        const cp = await insertContactPoint(trx, {
          leadId,
          type: "phone",
          role: "direct",
          rawValue: directPhone.raw,
          normalizedValue: directPhone.e164,
          sourceProvider: provider.name,
          sourceRunItemId: ctx.item.id,
          formatValid: directPhone.formatValid,
          formatCheckedAt: new Date(),
        });
        await appendContactPointCheck(trx, {
          contactPointId: cp.id,
          method: "format",
          provider: "engine",
          result: directPhone.formatValid ? "valid" : "invalid",
          detail: { e164: directPhone.e164 },
          runItemStepId: stepRowId,
        });
      }

      if (workEmail) {
        // Discovery is not verification: the address enters as not_checked.
        // The provider's OWN status claim (e.g. Apollo email_status) is kept
        // as data in source_metadata, never adopted as our judgment.
        const cp = await insertContactPoint(trx, {
          leadId,
          type: "email",
          role: "work",
          rawValue: person.workEmail as string,
          normalizedValue: workEmail,
          sourceProvider: provider.name,
          sourceRunItemId: ctx.item.id,
          sourceMetadata: person.emailStatusClaim ? { providerClaimedStatus: person.emailStatusClaim } : {},
          formatValid: EMAIL_FORMAT_RE.test(workEmail),
          formatCheckedAt: new Date(),
          emailStatus: "not_checked",
        });
        await appendContactPointCheck(trx, {
          contactPointId: cp.id,
          method: "format",
          provider: "engine",
          result: EMAIL_FORMAT_RE.test(workEmail) ? "valid" : "invalid",
          runItemStepId: stepRowId,
        });
      }

      // Conflict-safe identity backfill: stable ids the match revealed attach
      // to the lead unless another lead already holds them (then the pair is
      // flagged in identity_conflicts and the column stays NULL).
      if (person.apolloPersonId || person.apolloOrganizationId || revealedLinkedin) {
        await setLeadIdentityKeys(trx, {
          leadId,
          agencyId: ctx.agencyId,
          runId: ctx.run.id,
          keys: {
            apolloPersonId: person.apolloPersonId ?? null,
            apolloOrganizationId: person.apolloOrganizationId ?? null,
            normalizedLinkedinUrl: revealedLinkedin,
          },
        });
      }

      await updateRunItem(trx, ctx.item.id, {
        snapshot: {
          ...snapshot,
          enrichment: {
            personName: `${person.firstName} ${person.lastName}`,
            title: person.title,
            directPhoneE164: directPhone?.e164 ?? null,
            workEmail,
            providerRequestId: outcome.providerRequestId,
            linkedinUrl: revealedLinkedin,
          },
        },
      });
    },
  };
}

export function executeScore(ctx: ExecCtx): ExecOutcome {
  const step = ctx.step as ScoreStep;
  const template = SCORE_TEMPLATES.get(step.template);
  if (!template) throw new AppError("INTERNAL", `Unknown score template '${step.template}'.`, { stepId: step.id });
  const normalized = requireNormalized(ctx.item);
  const snapshot = snapshotOf(ctx.item);
  const score = evaluateTemplate(template, buildFieldContext(snapshot, normalized));
  return {
    cost: 0,
    classification: "completed",
    providerRequestId: null,
    note: `scored ${score.total}`,
    result: { total: score.total },
    commit: async (trx) => {
      await updateRunItem(trx, ctx.item.id, { score: score.total });
      if (ctx.item.lead_id) {
        await appendGeneratedOutput(trx, {
          leadId: ctx.item.lead_id,
          runId: ctx.run.id,
          runItemId: ctx.item.id,
          kind: "score_rationale",
          promptVersion: score.templateVersion,
          modelProvider: null,
          content: { total: score.total, results: score.results },
          // Grounding rule: evidence references persisted rows only.
          evidence: snapshot.sourceLeadSourceId ? [{ leadSourceId: snapshot.sourceLeadSourceId, field: "snapshot" }] : [],
        });
      }
    },
  };
}

function providerNameFromRun(run: RunRow): string {
  const plan = run.resolved_plan as { steps?: { type: string; provider?: string }[] };
  const source = plan.steps?.find((s) => s.type === "source");
  return source?.provider ?? "unknown";
}
