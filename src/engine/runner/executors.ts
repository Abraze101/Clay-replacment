import type { Kysely } from "kysely";

import { AppError } from "../../shared/errors.js";
import type { AttemptClassification, Database, JsonObject } from "../../storage/database-types.js";
import type { RunItemRow, RunRow } from "../../storage/repositories/run-repo.js";
import { attachLead, updateRunItem } from "../../storage/repositories/run-repo.js";
import {
  appendContactPointCheck,
  insertContactPoint,
  insertLead,
  upsertLeadSource,
} from "../../storage/repositories/lead-repo.js";
import { appendGeneratedOutput } from "../../storage/repositories/output-repo.js";
import type { EnrichProvider, ProviderRegistry, SourceRecord } from "../../providers/types.js";
import { resolveIdentity } from "../dedupe/identity.js";
import { normalizePhone, normalizeSourceRecord } from "../records/normalize.js";
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
  };
  research?: { incomplete: boolean; summary?: string; leadSourceId?: string; reason?: string };
}

export interface NormalizedFields {
  displayName: string;
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
  rating: number | null;
  reviewCount: number | null;
}

export function fieldContext(normalized: NormalizedFields): FieldContext {
  return {
    name: normalized.displayName,
    category: normalized.category,
    locality: normalized.locality,
    region: normalized.region,
    country: normalized.country,
    has_website: normalized.websiteUrl !== null,
    rating: normalized.rating,
    review_count: normalized.reviewCount,
    phone_format_valid: normalized.phoneFormatValid,
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
    displayName: n.displayName,
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
        sourceProvider: providerName,
        sourceProviderId: snapshot.source.sourceKey,
        displayName: normalized.displayName,
        normalizedDomain: normalized.normalizedDomain,
        normalizedPhone: normalized.phoneE164,
        locality: normalized.locality,
      });

      if (resolution.kind === "conflict") {
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

      const leadId =
        resolution.kind === "matched"
          ? resolution.leadId
          : (
              await insertLead(trx, {
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
              })
            ).id;

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

      await updateRunItem(trx, ctx.item.id, {
        snapshot: { ...snapshot, sourceLeadSourceId: leadSource.id },
        dedupeStatus: resolution.kind === "matched" ? "matched" : "new",
      });
    },
  };
}

export function executeFilter(ctx: ExecCtx): ExecOutcome {
  const step = ctx.step as FilterStep;
  const normalized = requireNormalized(ctx.item);
  const passed = evaluateRuleGroup(step.conditions, fieldContext(normalized));
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
    cost: 0,
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
  // May throw RetryableProviderError / AmbiguousOutcomeError — handled by the runner.
  const outcome = await provider.enrich({
    requestKey: ctx.requestKey,
    sourceKey: snapshot.source.sourceKey,
    name: normalized.displayName,
    normalizedDomain: normalized.normalizedDomain,
    normalizedPhone: normalized.phoneE164,
    locality: normalized.locality,
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
        const cp = await insertContactPoint(trx, {
          leadId,
          type: "email",
          role: "work",
          rawValue: person.workEmail as string,
          normalizedValue: workEmail,
          sourceProvider: provider.name,
          sourceRunItemId: ctx.item.id,
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

      await updateRunItem(trx, ctx.item.id, {
        snapshot: {
          ...snapshot,
          enrichment: {
            personName: `${person.firstName} ${person.lastName}`,
            title: person.title,
            directPhoneE164: directPhone?.e164 ?? null,
            workEmail,
            providerRequestId: outcome.providerRequestId,
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
  const score = evaluateTemplate(template, fieldContext(normalized));
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
