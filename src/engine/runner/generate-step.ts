import type { Kysely } from "kysely";

import { AppError } from "../../shared/errors.js";
import type { Database } from "../../storage/database-types.js";
import { getLead, listContactPoints } from "../../storage/repositories/lead-repo.js";
import { appendGeneratedOutput } from "../../storage/repositories/output-repo.js";
import { updateRunItem } from "../../storage/repositories/run-repo.js";
import type { ModelProvider } from "../../providers/models/types.js";
import { toStrictJsonSchema } from "../../providers/models/shared.js";
import { buildEvidenceBundle } from "../generation/evidence.js";
import { validateGrounding } from "../generation/grounding.js";
import { GENERATION_TEMPLATES } from "../generation/templates.js";
import type { GenerateStep } from "../workflow-schema/steps.js";
import type { ExecCtx, ExecOutcome } from "./executors.js";

/** Preference order when no provider is pinned and several are configured (ADR-012; OpenRouter is the owner's MiniMax route). */
const MODEL_PREFERENCE = ["openrouter", "minimax", "openai", "anthropic", "fake-model"];

export function resolveModelProvider(
  models: Map<string, ModelProvider>,
  pinned?: string,
): ModelProvider | undefined {
  if (pinned) return models.get(pinned);
  for (const name of MODEL_PREFERENCE) {
    const provider = models.get(name);
    if (provider) return provider;
  }
  return models.values().next().value;
}

export interface GenerateExecOpts {
  db: Kysely<Database>;
  maxOutputTokens: number;
}

/**
 * Execute a generate step: build the evidence bundle from PERSISTED rows,
 * call the shared model interface, enforce grounding, retry ONCE on invalid
 * output, then either persist the generated output or complete the step with
 * `generation_invalid_output` — the lead stays usable without copy, never
 * failed (workflows.md failure table). Generation books cost 0: model calls
 * bill the owner's model account, not engine credits; token usage is recorded
 * in the step result.
 */
export async function executeGenerate(ctx: ExecCtx, opts: GenerateExecOpts): Promise<ExecOutcome> {
  const step = ctx.step as GenerateStep;
  const template = GENERATION_TEMPLATES.get(step.template);
  if (!template) {
    throw new AppError("INTERNAL", `Unknown generation template '${step.template}'.`, { stepId: step.id });
  }
  const provider = resolveModelProvider(ctx.providers.models, step.provider);
  if (!provider) {
    throw new AppError("INTERNAL", `No model provider available for generate step '${step.id}'.`, { stepId: step.id });
  }
  if (!ctx.item.lead_id) {
    return { cost: 0, classification: "completed", providerRequestId: null, note: "no_lead", result: {} };
  }
  const leadId = ctx.item.lead_id;
  const lead = await getLead(opts.db, leadId);
  if (!lead) {
    return { cost: 0, classification: "completed", providerRequestId: null, note: "no_lead", result: {} };
  }
  const contactPoints = await listContactPoints(opts.db, leadId);
  const bundle = buildEvidenceBundle({ item: ctx.item, lead, contactPoints });
  const prompt = template.buildPrompt(bundle);
  const wireSchema = toStrictJsonSchema(template.outputSchema);

  let usage = { inputTokens: null as number | null, outputTokens: null as number | null };
  let model = provider.model;
  let providerRequestId: string | null = null;
  let failureReason = "";

  // Retry ONCE on schema-invalid or ungrounded output, then leave the lead
  // usable without generated copy. Transport errors (429/5xx) throw and take
  // the runner's standard pause/retry paths instead.
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const outcome = await provider.generate({
      kind: template.kind,
      promptVersion: template.promptVersion,
      prompt,
      outputSchema: template.outputSchema,
      wireSchema,
      constraints: { maxOutputTokens: opts.maxOutputTokens },
      requestKey: `${ctx.requestKey}:g${attempt}`,
    });
    usage = outcome.usage;
    model = outcome.model;
    providerRequestId = outcome.providerRequestId;
    if (outcome.kind === "invalid_output") {
      failureReason = outcome.reason;
      continue;
    }
    const grounded = validateGrounding(outcome.output, template, bundle);
    if (!grounded.ok) {
      failureReason = grounded.reason;
      continue;
    }
    const wasRegenerate = ctx.item.review_status === "regenerate";
    return {
      cost: 0,
      classification: "completed",
      providerRequestId,
      note: wasRegenerate ? "regenerated" : "generated",
      result: {
        provider: provider.name,
        model,
        kind: template.outputKind,
        promptVersion: template.promptVersion,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        repaired: outcome.repaired,
        strippedClaims: grounded.strippedClaims,
      },
      commit: async (trx) => {
        await appendGeneratedOutput(trx, {
          leadId,
          runId: ctx.run.id,
          runItemId: ctx.item.id,
          kind: template.outputKind,
          promptVersion: template.promptVersion,
          modelProvider: provider.name,
          model,
          content: grounded.content,
          evidence: grounded.evidence,
        });
        // A re-generated item returns to the review queue for a fresh decision.
        if (wasRegenerate) {
          await updateRunItem(trx, ctx.item.id, { reviewStatus: "unreviewed" });
        }
      },
    };
  }

  // Twice invalid: the step COMPLETES (never fails the item) with an honest note.
  return {
    cost: 0,
    classification: "completed",
    providerRequestId,
    note: "generation_invalid_output",
    result: {
      provider: provider.name,
      model,
      reason: failureReason,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
    },
  };
}
