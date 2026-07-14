import { checksumOf } from "../../shared/checksum.js";
import { AppError } from "../../shared/errors.js";
import { GENERATION_TEMPLATES } from "../generation/templates.js";
import { SCORE_TEMPLATES } from "../scoring/templates.js";
import type { EstimatedPaidAction } from "../../storage/database-types.js";
import type {
  ContactDiscoveryProvider,
  EmailVerificationProvider,
  PhoneSignal,
  PhoneValidationProvider,
  ProviderRegistry,
} from "../../providers/types.js";
import { discoveryCostPerRecord, isPagedPaidSource, validationCostPerRecord } from "../../providers/types.js";
import type { CapabilityOverrides, ContactCapabilityName } from "./overrides.js";
import { CAPABILITY_OVERRIDES } from "./overrides.js";
import type { EnrichStep, Profile, WorkflowStep } from "./steps.js";
import type { WorkflowDefinition, WorkflowInputs } from "./workflow.js";
import { workflowInputsSchema } from "./workflow.js";

/** Initial hard cap: at most 100 paid records per run (product requirement). */
export const MAX_PAID_RECORDS = 100;

/** Default paid signal packages for a phone_validation step without explicit `signals`. */
export const DEFAULT_PHONE_SIGNALS: readonly PhoneSignal[] = ["line_type", "line_status"];

/** Sources whose records are known to carry phone numbers (validation without discovery is sensible). */
const PHONE_BEARING_SOURCES = new Set(["local-business", "imported-list", "fake-places", "run-continuation"]);
/** Sources whose records may carry emails (imported rows and continuation snapshots only). */
const EMAIL_BEARING_SOURCES = new Set(["imported-list", "run-continuation"]);

/**
 * skipPersonalization turns off personalization templates only: a Call-Ready
 * run may skip openers but still wants grounded call notes. The template
 * registry (generation/templates.ts) says which is which.
 */
function isPersonalizationTemplate(name: string): boolean {
  return GENERATION_TEMPLATES.get(name)?.isPersonalization ?? true;
}

export interface PlannedStep {
  id: string;
  type: WorkflowStep["type"];
  provider?: string;
  /** M5 contact-capability steps carry which capability they perform. */
  capability?: ContactCapabilityName;
  paid: boolean;
  costPerRecord: number;
  willRun: boolean;
  excludedBy?: "profile" | "override";
  /** Preview honesty: this step runs ONLY because an override forced it in. */
  includedBy?: "override";
}

/**
 * Deterministic policy parameters derived from overrides + planned steps and
 * persisted with the plan so the runner and call-readiness policy never
 * re-derive them. Covered by the plan hash via `overrides` + `profile`.
 */
export interface PlanPolicy {
  requireDirectPhone: boolean;
  acceptBusinessMainPhone: boolean;
  acceptCatchAllEmail: boolean;
  /** True when a phone_validation step will run (drives 'unchecked' vs NULL readiness). */
  phoneValidationRequested: boolean;
  emailVerificationRequested: boolean;
}

export interface ResolvedPlan {
  workflowChecksum: string;
  profile: Profile;
  inputs: WorkflowInputs;
  overrides: CapabilityOverrides;
  steps: PlannedStep[];
  policy: PlanPolicy;
  sourceLimit: number;
  paidRecordCap: number;
  creditLimit: number;
  estimatedPaidActions: EstimatedPaidAction[];
  estimatedCost: number;
  warnings: string[];
  planHash: string;
}

export type ResolvedCapabilityProvider =
  | { kind: "phone_validation"; provider: PhoneValidationProvider }
  | { kind: "email_verification"; provider: EmailVerificationProvider }
  | { kind: "discovery"; provider: ContactDiscoveryProvider };

/**
 * Resolve the provider serving a capability step: the pinned name when the
 * step names one, else the sole configured provider for that capability.
 * Returns undefined when nothing is configured (ADR-031: selection without a
 * key leaves the capability empty so this surfaces at plan time).
 */
export function resolveCapabilityProvider(
  registry: ProviderRegistry,
  capability: ContactCapabilityName,
  pinned?: string,
): ResolvedCapabilityProvider | undefined {
  const pick = <T>(map: Map<string, T>): T | undefined => {
    if (pinned) return map.get(pinned);
    return map.values().next().value;
  };
  if (capability === "phone_validation") {
    const provider = pick(registry.phoneValidation);
    return provider ? { kind: "phone_validation", provider } : undefined;
  }
  if (capability === "email_verification") {
    const provider = pick(registry.emailVerification);
    return provider ? { kind: "email_verification", provider } : undefined;
  }
  const provider = pick(registry.contactDiscovery);
  return provider ? { kind: "discovery", provider } : undefined;
}

/** Wanted contact kinds for a discovery-capability step. */
export function discoveryWantedKinds(capability: "phone_discovery" | "email_discovery"): readonly ("work_email" | "direct_phone" | "mobile_phone")[] {
  return capability === "phone_discovery" ? ["direct_phone", "mobile_phone"] : ["work_email"];
}

function capabilityStepCost(step: EnrichStep, resolved: ResolvedCapabilityProvider): number {
  switch (resolved.kind) {
    case "phone_validation":
      return validationCostPerRecord(resolved.provider, step.signals ?? DEFAULT_PHONE_SIGNALS);
    case "email_verification":
      return resolved.provider.costPerRecord;
    case "discovery":
      return discoveryCostPerRecord(
        resolved.provider,
        discoveryWantedKinds(step.capability as "phone_discovery" | "email_discovery"),
      );
  }
}

const OVERRIDE_KEY_BY_CAPABILITY = Object.fromEntries(
  Object.entries(CAPABILITY_OVERRIDES).map(([key, capability]) => [capability, key]),
) as Record<ContactCapabilityName, keyof typeof CAPABILITY_OVERRIDES>;

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

  const continuation =
    inputs.continueFromRunId && inputs.continuationLeadIds
      ? { runId: inputs.continueFromRunId, leadIds: inputs.continuationLeadIds }
      : undefined;

  // Per-source planned request counts (paged paid sources only), used to price
  // the source step by search volume rather than by the per-record cap.
  const sourceRequestCounts = new Map<string, number>();

  const steps: PlannedStep[] = args.definition.steps.map((step) => {
    let provider = "provider" in step ? step.provider : undefined;
    const capability = step.type === "enrich" ? step.capability : undefined;

    // Profile/override exclusion FIRST: an excluded step's provider need not
    // be configured (a shipped template referencing an unconfigured live
    // enricher must not block the free quick_list path).
    let willRun = true;
    let excludedBy: PlannedStep["excludedBy"];
    let includedBy: PlannedStep["includedBy"];
    const profiles = "profiles" in step ? step.profiles : undefined;
    if (profiles && !profiles.includes(profile)) {
      willRun = false;
      excludedBy = "profile";
    }
    if (willRun && step.type === "generate" && args.overrides.skipPersonalization && isPersonalizationTemplate(step.template)) {
      willRun = false;
      excludedBy = "override";
    }
    if (willRun && step.type === "enrich" && !step.capability && step.optional && args.overrides.findOwner === false) {
      willRun = false;
      excludedBy = "override";
    }
    // M5 capability overrides gate their step both ways: `false` excludes a
    // profile-enabled step; `true` force-includes a profile-excluded one —
    // except under quick_list, which never runs paid contact steps.
    if (step.type === "enrich" && step.capability) {
      const overrideKey = OVERRIDE_KEY_BY_CAPABILITY[step.capability];
      const overrideValue = args.overrides[overrideKey];
      if (overrideValue === false && willRun) {
        willRun = false;
        excludedBy = "override";
      } else if (overrideValue === true && !willRun && excludedBy === "profile") {
        if (profile === "quick_list") {
          warnings.push(
            `quick_list enables no paid contact steps; switch to call_ready or full to enable '${overrideKey}'.`,
          );
        } else {
          willRun = true;
          excludedBy = undefined;
          includedBy = "override";
        }
      }
    }

    let paid = step.type === "enrich";
    let costPerRecord = 0;
    if (step.type === "enrich" && step.capability) {
      const resolved = resolveCapabilityProvider(args.providers, step.capability, step.provider);
      if (!resolved) {
        if (willRun) {
          throw new AppError(
            "VALIDATION_FAILED",
            `Step '${step.id}' needs a configured '${step.capability}' provider${step.provider ? ` ('${step.provider}')` : ""} — set the capability's provider selection and key (see provider status) or disable the capability.`,
            { stepId: step.id, capability: step.capability, ...(step.provider ? { provider: step.provider } : {}) },
          );
        }
        warnings.push(
          `Step '${step.id}' needs an unconfigured '${step.capability}' provider; it is excluded by ${excludedBy ?? "the profile"} and would need configuration to run.`,
        );
      } else {
        provider = resolved.provider.name;
        costPerRecord = capabilityStepCost(step, resolved);
      }
    } else if (step.type === "enrich") {
      // superRefine guarantees a provider on non-capability enrich steps.
      const providerName = step.provider ?? "";
      const enricher = args.providers.enrichers.get(providerName);
      if (!enricher) {
        if (willRun) {
          throw new AppError(
            "VALIDATION_FAILED",
            `Enrich step '${step.id}' needs provider '${providerName}', which is not configured — connect it (see provider status) or choose a profile that excludes the step.`,
            { stepId: step.id, provider: providerName },
          );
        }
        warnings.push(
          `Step '${step.id}' references unconfigured provider '${providerName}'; it is excluded by ${excludedBy ?? "the profile"} and would need configuration to run.`,
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
        continuation,
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
          continuation,
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
    if (step.type === "generate") {
      if (!GENERATION_TEMPLATES.has(step.template)) {
        throw new AppError(
          "VALIDATION_FAILED",
          `Generate step '${step.id}' references unknown template '${step.template}'.`,
          { stepId: step.id, template: step.template },
        );
      }
      if (willRun && args.providers.models.size === 0) {
        warnings.push(
          `Generate step '${step.id}' will be SKIPPED: no model provider is configured (generation is optional — sourcing, scoring, and export run without it).`,
        );
      }
    }
    return {
      id: step.id,
      type: step.type,
      provider,
      ...(capability ? { capability } : {}),
      paid,
      costPerRecord,
      willRun,
      ...(excludedBy ? { excludedBy } : {}),
      ...(includedBy ? { includedBy } : {}),
    };
  });

  const willRunCapability = (capability: ContactCapabilityName): boolean =>
    steps.some((s) => s.capability === capability && s.willRun);
  const hasCapabilityStep = (capability: ContactCapabilityName): boolean =>
    steps.some((s) => s.capability === capability);

  const requireDirectPhone = args.overrides.requireDirectPhone ?? false;
  const policy: PlanPolicy = {
    requireDirectPhone,
    // A direct/mobile requirement makes a business main line unacceptable by definition.
    acceptBusinessMainPhone: requireDirectPhone ? false : (args.overrides.acceptBusinessMainPhone ?? true),
    acceptCatchAllEmail: args.overrides.acceptCatchAllEmail ?? false,
    phoneValidationRequested: willRunCapability("phone_validation"),
    emailVerificationRequested: willRunCapability("email_verification"),
  };

  // Override/step coherence warnings (never silent no-ops).
  for (const [key, capability] of Object.entries(CAPABILITY_OVERRIDES) as [
    keyof typeof CAPABILITY_OVERRIDES,
    ContactCapabilityName,
  ][]) {
    if (args.overrides[key] !== undefined && !hasCapabilityStep(capability)) {
      warnings.push(`Override '${key}' has no ${capability} step in this workflow; it changes nothing.`);
    }
  }
  if (args.overrides.requireDirectPhone === true && args.overrides.acceptBusinessMainPhone === true) {
    warnings.push(
      "requireDirectPhone conflicts with acceptBusinessMainPhone; the direct/mobile requirement wins and business main lines will not satisfy call-readiness.",
    );
  }
  const sourceStep = args.definition.steps.find((s) => s.type === "source");
  const sourceProviderName = sourceStep && "provider" in sourceStep ? sourceStep.provider : "";
  if (
    willRunCapability("phone_validation") &&
    !willRunCapability("phone_discovery") &&
    !PHONE_BEARING_SOURCES.has(sourceProviderName)
  ) {
    warnings.push(
      "phone_validation may find nothing to validate: no phone discovery runs before it and the source may not return phone numbers.",
    );
  }
  if (policy.requireDirectPhone && hasCapabilityStep("phone_discovery") && !willRunCapability("phone_discovery")) {
    warnings.push(
      "requireDirectPhone is set but phone discovery is excluded; only source- or import-provided direct/mobile numbers can satisfy it.",
    );
  }
  if (
    willRunCapability("email_verification") &&
    !willRunCapability("email_discovery") &&
    !steps.some((s) => s.type === "enrich" && !s.capability && s.willRun) &&
    !EMAIL_BEARING_SOURCES.has(sourceProviderName)
  ) {
    warnings.push(
      "email_verification may find nothing to verify: no email discovery or person enrichment runs before it and the source does not return emails.",
    );
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
    policy,
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
