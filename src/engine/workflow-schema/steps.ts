import { z } from "zod";

import { ruleGroupSchema } from "./rules.js";

/** The approved step-type allowlist. Unknown types fail the discriminated union. */
export const STEP_TYPES = [
  "source",
  "normalize",
  "dedupe",
  "enrich",
  "filter",
  "research",
  "score",
  "generate",
  "review_gate",
  "export",
] as const;
export type StepType = (typeof STEP_TYPES)[number];

export const profileSchema = z.enum(["quick_list", "call_ready", "full"]);
export type Profile = z.infer<typeof profileSchema>;

const stepId = z
  .string()
  .regex(/^[a-z][a-z0-9-]{0,63}$/, "step id must be kebab-case")
  .describe("unique step id");
const profiles = z.array(profileSchema).min(1).optional();

/** M5 contact-capability step values. Cross-field rules live in the workflow superRefine. */
export const contactCapabilitySchema = z.enum([
  "phone_discovery",
  "phone_validation",
  "email_discovery",
  "email_verification",
]);
export type StepContactCapability = z.infer<typeof contactCapabilitySchema>;

export const phoneSignalSchema = z.enum(["line_type", "line_status", "identity_match"]);

const sourceStep = z.object({ id: stepId, type: z.literal("source"), provider: z.string().min(1) }).strict();
const normalizeStep = z.object({ id: stepId, type: z.literal("normalize") }).strict();
const dedupeStep = z.object({ id: stepId, type: z.literal("dedupe") }).strict();
const enrichStep = z
  .object({
    id: stepId,
    type: z.literal("enrich"),
    /**
     * Named provider (classic enrich) OR a pin for a capability step. A
     * capability step without a provider resolves from the registry; a
     * non-capability enrich step REQUIRES a provider (workflow superRefine).
     */
    provider: z.string().min(1).optional(),
    /** M5: which contact capability this step performs (visible typed step). */
    capability: contactCapabilitySchema.optional(),
    /** phone_validation only: paid signal packages to request (default line_type + line_status). */
    signals: z.array(phoneSignalSchema).min(1).optional(),
    optional: z.boolean().optional(),
    profiles,
  })
  .strict();
const filterStep = z.object({ id: stepId, type: z.literal("filter"), conditions: ruleGroupSchema }).strict();
const researchStep = z
  .object({ id: stepId, type: z.literal("research"), provider: z.string().min(1), profiles })
  .strict();
const scoreStep = z.object({ id: stepId, type: z.literal("score"), template: z.string().min(1), profiles }).strict();
const generateStep = z
  .object({
    id: stepId,
    type: z.literal("generate"),
    template: z.string().min(1),
    /** Optional model-provider pin; default resolves from GENERATE_MODEL_PROVIDER (M5). */
    provider: z.string().min(1).optional(),
    profiles,
  })
  .strict();
const reviewGateStep = z.object({ id: stepId, type: z.literal("review_gate") }).strict();
const exportStep = z.object({ id: stepId, type: z.literal("export"), format: z.literal("csv") }).strict();

export const stepSchema = z.discriminatedUnion("type", [
  sourceStep,
  normalizeStep,
  dedupeStep,
  enrichStep,
  filterStep,
  researchStep,
  scoreStep,
  generateStep,
  reviewGateStep,
  exportStep,
]);

export type WorkflowStep = z.infer<typeof stepSchema>;
export type SourceStep = z.infer<typeof sourceStep>;
export type EnrichStep = z.infer<typeof enrichStep>;
export type FilterStep = z.infer<typeof filterStep>;
export type ResearchStep = z.infer<typeof researchStep>;
export type ScoreStep = z.infer<typeof scoreStep>;
export type GenerateStep = z.infer<typeof generateStep>;
