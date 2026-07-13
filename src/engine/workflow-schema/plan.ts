import { checksumOf } from "../../shared/checksum.js";
import { AppError } from "../../shared/errors.js";
import { SCORE_TEMPLATES } from "../scoring/templates.js";
import type { EstimatedPaidAction } from "../../storage/database-types.js";
import type { ProviderRegistry } from "../../providers/types.js";
import { isPagedPaidSource } from "../../providers/types.js";
import type { CapabilityOverrides } from "./overrides.js";
import { M5_ONLY_OVERRIDES } from "./overrides.js";
import type { Profile, WorkflowStep } from "./steps.js";
import type { WorkflowDefinition, WorkflowInputs } from "./workflow.js";
import { workflowInputsSchema } from "./workflow.js";

/** Initial hard cap: at most 100 paid records per run (product requirement). */
export const MAX_PAID_RECORDS = 100;

export interface PlannedStep {
  id: string;
  type: WorkflowStep["type"];
  provider?: string;
  paid: boolean;
  costPerRecord: number;
  willRun: boolean;
  excludedBy?: "profile" | "override";
}

export interface ResolvedPlan {
  workflowChecksum: string;
  profile: Profile;
  inputs: WorkflowInputs;
  overrides: CapabilityOverrides;
  steps: PlannedStep[];
  sourceLimit: number;
  paidRecordCap: number;
  creditLimit: number;
  estimatedPaidActions: EstimatedPaidAction[];
  estimatedCost: number;
  warnings: string[];
  planHash: string;
}

/**
 * Resolve exactly which steps a run will execute for a profile + overrides,
 * with cost estimates. The plan hash binds workflow-version checksum, inputs,
 * profile, overrides, record cap, budget and estimated actions — changing any
 * of them yields a different hash and therefore invalidates the approval.
 */
export function resolvePlan(args: {
  definition: WorkflowDefinition;
  workflowChecksum: string;
  inputs: Record<string, unknown>;
  profile?: Profile;
  overrides: CapabilityOverrides;
  requestedCap?: number;
  requestedBudget?: number;
  providers: ProviderRegistry;
}): ResolvedPlan {
  const mergedInputs = workflowInputsSchema.safeParse({ ...args.definition.inputs, ...args.inputs });
  if (!mergedInputs.success) {
    throw new AppError("VALIDATION_FAILED", "Run inputs are invalid.", {
      issues: mergedInputs.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }
  const inputs = mergedInputs.data;
  const profile = args.profile ?? inputs.enrichmentProfile;
  inputs.enrichmentProfile = profile;
  const warnings: string[] = [];

  // Per-source planned request counts (paged paid sources only), used to price
  // the source step by search volume rather than by the per-record cap.
  const sourceRequestCounts = new Map<string, number>();

  const steps: PlannedStep[] = args.definition.steps.map((step) => {
    const provider = "provider" in step ? step.provider : undefined;

    // Profile/override exclusion FIRST: an excluded step's provider need not
    // be configured (a shipped template referencing an unconfigured live
    // enricher must not block the free quick_list path).
    let willRun = true;
    let excludedBy: PlannedStep["excludedBy"];
    const profiles = "profiles" in step ? step.profiles : undefined;
    if (profiles && !profiles.includes(profile)) {
      willRun = false;
      excludedBy = "profile";
    }
    if (willRun && step.type === "generate" && args.overrides.skipPersonalization) {
      willRun = false;
      excludedBy = "override";
    }
    if (willRun && step.type === "enrich" && step.optional && args.overrides.findOwner === false) {
      willRun = false;
      excludedBy = "override";
    }

    let paid = step.type === "enrich";
    let costPerRecord = 0;
    if (step.type === "enrich") {
      const enricher = args.providers.enrichers.get(step.provider);
      if (!enricher) {
        if (willRun) {
          throw new AppError(
            "VALIDATION_FAILED",
            `Enrich step '${step.id}' needs provider '${step.provider}', which is not configured — connect it (see provider status) or choose a profile that excludes the step.`,
            { stepId: step.id, provider: step.provider },
          );
        }
        warnings.push(
          `Step '${step.id}' references unconfigured provider '${step.provider}'; it is excluded by ${excludedBy ?? "the profile"} and would need configuration to run.`,
        );
      } else {
        costPerRecord = enricher.costPerRecord;
      }
    }
    if (step.type === "source") {
      const src = args.providers.sources.get(step.provider);
      if (!src) {
        // The source always runs; unconfigured means the run cannot start.
        throw new AppError(
          "VALIDATION_FAILED",
          `Source step '${step.id}' needs provider '${step.provider}', which is not configured — connect it (see provider status).`,
          { stepId: step.id, provider: step.provider },
        );
      }
      // Pre-run input validation (e.g. imported-list requires rows).
      src.validateQuery?.({
        businessType: inputs.businessType,
        locations: inputs.locations,
        limit: inputs.limit,
        personTitles: inputs.personTitles,
        importRows: inputs.importRows,
      });
      // A paged paid source (e.g. SerpAPI Maps) is billed per search request;
      // the preview cost derives from the planned request volume. A zero-cost
      // paged source (Apollo people search) still plans through the ledger for
      // crash replay and rate-limit pausing.
      if (isPagedPaidSource(src)) {
        const est = src.estimateSearchCost({
          businessType: inputs.businessType,
          locations: inputs.locations,
          limit: inputs.limit,
          personTitles: inputs.personTitles,
        });
        paid = true;
        costPerRecord = est.creditsPerRequest;
        sourceRequestCounts.set(step.id, est.requests);
      }
    }
    if (step.type === "research") {
      const rp = args.providers.researchers.get(step.provider);
      if (!rp) {
        if (willRun) {
          throw new AppError(
            "VALIDATION_FAILED",
            `Research step '${step.id}' needs provider '${step.provider}', which is not configured — connect it (see provider status) or choose a profile that excludes the step.`,
            { stepId: step.id, provider: step.provider },
          );
        }
        warnings.push(
          `Step '${step.id}' references unconfigured provider '${step.provider}'; it is excluded by ${excludedBy ?? "the profile"} and would need configuration to run.`,
        );
      } else if (rp.costPerRecord && rp.costPerRecord > 0) {
        // A live research provider (Firecrawl) makes research a paid item step.
        paid = true;
        costPerRecord = rp.costPerRecord;
      }
    }
    if (step.type === "score" && !SCORE_TEMPLATES.has(step.template)) {
      // Belt-and-braces: create-time validation covers this, but a stored
      // workflow must still fail at PREVIEW (not mid-run) if the code-owned
      // template registry ever drops a name.
      throw new AppError("VALIDATION_FAILED", `Score step '${step.id}' references unknown template '${step.template}'.`, {
        stepId: step.id,
        template: step.template,
      });
    }
    return { id: step.id, type: step.type, provider, paid, costPerRecord, willRun, ...(excludedBy ? { excludedBy } : {}) };
  });

  for (const key of M5_ONLY_OVERRIDES) {
    if (args.overrides[key] !== undefined) {
      warnings.push(`Override '${key}' is recorded and bound to the approval, but its contact-capability steps arrive at Milestone 5; it changes no M0 step.`);
    }
  }

  // The per-record cap governs item-level paid work (enrichment) only. A paid
  // source books per-search cost against its own ledger and never consumes the
  // record cap, so it is excluded from this computation.
  const itemPaidSteps = steps.filter((s) => s.paid && s.willRun && s.type !== "source");
  const paidSourceSteps = steps.filter((s) => s.paid && s.willRun && s.type === "source");
  const anyPaidStep = itemPaidSteps.length > 0 || paidSourceSteps.length > 0;
  const paidRecordCap =
    itemPaidSteps.length === 0 ? 0 : Math.min(inputs.limit, MAX_PAID_RECORDS, args.requestedCap ?? MAX_PAID_RECORDS);
  const estimatedPaidActions: EstimatedPaidAction[] = steps
    .filter((s) => s.paid && s.willRun)
    .map((s) => ({
      stepId: s.id,
      provider: s.provider ?? "unknown",
      // Source steps are counted by planned search requests; item steps by cap.
      count: s.type === "source" ? (sourceRequestCounts.get(s.id) ?? 0) : paidRecordCap,
      costPerRecord: s.costPerRecord,
    }));
  const estimatedCost = round4(estimatedPaidActions.reduce((acc, a) => acc + a.count * a.costPerRecord, 0));
  const creditLimit = args.requestedBudget ?? estimatedCost;
  if (creditLimit < 0) throw new AppError("VALIDATION_FAILED", "Budget must be >= 0.", {});
  if (anyPaidStep && creditLimit < estimatedCost) {
    warnings.push(`Budget (${creditLimit}) is below the estimated cost (${estimatedCost}); the run will pause at the credit cap and keep partial results.`);
  }
  // The quick_list "no paid steps" caution is about person/contact enrichment,
  // not the source itself — a Quick List legitimately pays for discovery.
  if (profile === "quick_list" && itemPaidSteps.length > 0) {
    warnings.push("quick_list normally enables no paid contact/enrichment steps; check the workflow's profile tags.");
  }
  for (const s of paidSourceSteps) {
    const count = sourceRequestCounts.get(s.id) ?? 0;
    warnings.push(
      s.costPerRecord > 0
        ? `Source '${s.id}' (${s.provider ?? "unknown"}) will issue ${count} paid search request(s) at ${s.costPerRecord} credit(s) each.`
        : `Source '${s.id}' (${s.provider ?? "unknown"}) will issue ${count} search request(s) (0 credits — this provider's search is free but rate-limited).`,
    );
  }

  const planHash = checksumOf({
    workflowChecksum: args.workflowChecksum,
    inputs,
    profile,
    overrides: args.overrides,
    paidRecordCap,
    creditLimit,
    estimatedPaidActions,
  });

  return {
    workflowChecksum: args.workflowChecksum,
    profile,
    inputs,
    overrides: args.overrides,
    steps,
    sourceLimit: inputs.limit,
    paidRecordCap,
    creditLimit,
    estimatedPaidActions,
    estimatedCost,
    warnings,
    planHash,
  };
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}
