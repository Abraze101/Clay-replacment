import { z } from "zod";

import { AppError } from "../../shared/errors.js";
import { importRowSchema } from "../import/csv-import.js";
import { profileSchema, stepSchema } from "./steps.js";

/**
 * A workflow is a versioned JSON configuration assembled from approved typed
 * steps. Linear order with simple conditions and bounded retries; no arbitrary
 * code, no unknown step types, no unregistered providers.
 */
export const workflowInputsSchema = z
  .object({
    businessType: z.string().min(1).optional(),
    locations: z.array(z.string().min(1)).max(20).optional(),
    limit: z.number().int().min(1).max(500).default(25),
    enrichmentProfile: profileSchema.default("quick_list"),
    /** Professional-contact searches (M4): job titles to match. */
    personTitles: z.array(z.string().min(1)).max(10).optional(),
    /**
     * Imported-list runs (M4): validated rows, normally produced by
     * parseImportCsv from RunOptions.importCsv. Bound into the plan hash, so
     * changing the list invalidates an approval. Per-run input — never stored
     * in a workflow template.
     */
    importRows: z.array(importRowSchema).max(500).optional(),
    /**
     * Selected-lead continuation (M5): continue the prior run's approved rows
     * into deeper enrichment. The lead-id set is resolved from durable review
     * state at preview and bound into the plan hash (the importRows pattern) —
     * a review flip between preview and start invalidates the approval.
     * Per-run inputs — never stored in a workflow template.
     */
    continueFromRunId: z.uuid().optional(),
    continuationLeadIds: z.array(z.uuid()).max(500).optional(),
  })
  .strict();

export type WorkflowInputs = z.infer<typeof workflowInputsSchema>;

export const workflowDefinitionSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/, "workflow id must be kebab-case"),
    version: z.number().int().min(1).default(1),
    name: z.string().min(1),
    description: z.string().optional(),
    inputs: workflowInputsSchema,
    steps: z.array(stepSchema).min(1).max(20),
  })
  .strict()
  .superRefine((def, ctx) => {
    const ids = def.steps.map((s) => s.id);
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({ code: "custom", message: "step ids must be unique", path: ["steps"] });
    }
    const types = def.steps.map((s) => s.type);
    if (types[0] !== "source") {
      ctx.addIssue({ code: "custom", message: "the first step must be a source step", path: ["steps", 0] });
    }
    if (types.filter((t) => t === "source").length > 1) {
      ctx.addIssue({ code: "custom", message: "only one source step is supported in M0", path: ["steps"] });
    }
    const reviewIdx = types.indexOf("review_gate");
    const exportIdx = types.indexOf("export");
    if (exportIdx >= 0 && reviewIdx < 0) {
      ctx.addIssue({ code: "custom", message: "an export step requires a preceding review_gate", path: ["steps"] });
    }
    if (exportIdx >= 0 && reviewIdx > exportIdx) {
      ctx.addIssue({ code: "custom", message: "review_gate must precede export", path: ["steps"] });
    }
    if (exportIdx >= 0 && exportIdx !== types.length - 1) {
      ctx.addIssue({ code: "custom", message: "export must be the last step", path: ["steps"] });
    }
    // M5 contact-capability rules: enrich steps need a provider OR a
    // capability; signals belong to phone_validation only; at most one step
    // per capability; discovery precedes its validation/verification channel.
    const capabilityIdx = new Map<string, number>();
    def.steps.forEach((step, idx) => {
      if (step.type !== "enrich") return;
      if (!step.provider && !step.capability) {
        ctx.addIssue({
          code: "custom",
          message: "an enrich step needs a provider, a capability, or both",
          path: ["steps", idx],
        });
      }
      if (step.signals && step.capability !== "phone_validation") {
        ctx.addIssue({
          code: "custom",
          message: "signals apply only to capability 'phone_validation'",
          path: ["steps", idx],
        });
      }
      if (step.capability) {
        if (capabilityIdx.has(step.capability)) {
          ctx.addIssue({
            code: "custom",
            message: `duplicate capability '${step.capability}' — one step per capability`,
            path: ["steps", idx],
          });
        } else {
          capabilityIdx.set(step.capability, idx);
        }
      }
    });
    for (const [discovery, check] of [
      ["phone_discovery", "phone_validation"],
      ["email_discovery", "email_verification"],
    ] as const) {
      const d = capabilityIdx.get(discovery);
      const c = capabilityIdx.get(check);
      if (d !== undefined && c !== undefined && d > c) {
        ctx.addIssue({
          code: "custom",
          message: `'${discovery}' must precede '${check}'`,
          path: ["steps", d],
        });
      }
    }
  });

export type WorkflowDefinition = z.infer<typeof workflowDefinitionSchema>;

export function parseWorkflowDefinition(raw: unknown): WorkflowDefinition {
  const result = workflowDefinitionSchema.safeParse(raw);
  if (!result.success) {
    throw new AppError("VALIDATION_FAILED", "Workflow definition is invalid.", {
      issues: result.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }
  return result.data;
}
