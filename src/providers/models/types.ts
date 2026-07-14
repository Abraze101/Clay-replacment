import type { z } from "zod";

/**
 * The ONE shared model-provider interface (ADR-012/ADR-032). MiniMax, OpenAI,
 * Anthropic, and the fake provider all implement it; the engine owns prompt
 * building and evidence grounding — adapters are dumb transports that return
 * schema-validated output or an honest `invalid_output`.
 *
 * Model calls bill the OWNER's model-provider account, never engine credits:
 * generate steps book cost 0 and record token usage informationally. Transport
 * errors keep the shared taxonomy (429 → RateLimitError pauses the run;
 * 5xx/network/timeout → RetryableProviderError) — never AmbiguousOutcomeError,
 * because no engine credits are at risk.
 */
export type GenerationKind = "fit_rationale" | "call_notes" | "opener";

export interface ModelPrompt {
  system: string;
  user: string;
}

export interface ModelConstraints {
  maxOutputTokens: number;
  temperature?: number;
}

export interface ModelUsage {
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface ModelGenerateRequest<T> {
  kind: GenerationKind;
  /** Written to generated_outputs.prompt_version (e.g. 'call-notes/v1'). */
  promptVersion: string;
  prompt: ModelPrompt;
  /** Engine-side source of truth; every adapter validates against it. */
  outputSchema: z.ZodType<T>;
  /** Pre-derived strict JSON Schema for vendors with native structured output. */
  wireSchema: Record<string, unknown>;
  constraints: ModelConstraints;
  /** Engine idempotency/trace key (generation is free; used for tracing only). */
  requestKey: string;
}

export type ModelGenerateOutcome<T> =
  | {
      kind: "ok";
      output: T;
      model: string;
      usage: ModelUsage;
      providerRequestId: string | null;
      /** True when the output only validated after an in-adapter repair round-trip. */
      repaired: boolean;
    }
  | {
      kind: "invalid_output";
      reason: string;
      model: string;
      usage: ModelUsage;
      providerRequestId: string | null;
    };

export interface ModelProvider {
  readonly name: string;
  readonly model: string;
  generate<T>(request: ModelGenerateRequest<T>): Promise<ModelGenerateOutcome<T>>;
}
