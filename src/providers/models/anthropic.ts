import { z } from "zod";

import type { ModelGenerateOutcome, ModelGenerateRequest, ModelProvider } from "./types.js";
import { ModelHttp, type ModelHttpOptions } from "./http.js";
import { parseModelOutput } from "./shared.js";

/**
 * Anthropic structured generation over the Messages API with an
 * output_config json_schema format (the current structured-output surface;
 * the legacy top-level output_format is deprecated). Plain fetch + Zod
 * (ADR-032); the engine schema re-validates every reply.
 */
const responseSchema = z
  .object({
    id: z.string().optional(),
    content: z.array(z.object({ type: z.string().optional(), text: z.string().optional() }).passthrough()).optional(),
    stop_reason: z.string().nullable().optional(),
    usage: z.object({ input_tokens: z.number().optional(), output_tokens: z.number().optional() }).passthrough().optional(),
  })
  .passthrough();

export interface AnthropicModelOptions extends Omit<ModelHttpOptions, "vendor"> {
  apiKey: string;
  baseUrl?: string;
  model: string;
}

export class AnthropicModelProvider implements ModelProvider {
  readonly name = "anthropic";
  readonly model: string;
  private readonly http: ModelHttp;
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(opts: AnthropicModelOptions) {
    this.model = opts.model;
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl ?? "https://api.anthropic.com";
    this.http = new ModelHttp({ vendor: "anthropic", ...opts });
  }

  async generate<T>(request: ModelGenerateRequest<T>): Promise<ModelGenerateOutcome<T>> {
    const json = await this.http.postJson(
      `${this.baseUrl}/v1/messages`,
      { "x-api-key": this.apiKey, "anthropic-version": "2023-06-01" },
      {
        model: this.model,
        max_tokens: request.constraints.maxOutputTokens,
        ...(request.constraints.temperature !== undefined ? { temperature: request.constraints.temperature } : {}),
        system: request.prompt.system,
        messages: [{ role: "user", content: request.prompt.user }],
        output_config: { format: { type: "json_schema", schema: request.wireSchema } },
      },
    );
    const parsed = responseSchema.safeParse(json);
    const usage = {
      inputTokens: parsed.success ? (parsed.data.usage?.input_tokens ?? null) : null,
      outputTokens: parsed.success ? (parsed.data.usage?.output_tokens ?? null) : null,
    };
    const providerRequestId = parsed.success ? (parsed.data.id ?? null) : null;
    if (!parsed.success) {
      return { kind: "invalid_output", reason: "unrecognized Messages API payload", model: this.model, usage, providerRequestId };
    }
    if (parsed.data.stop_reason && parsed.data.stop_reason !== "end_turn" && parsed.data.stop_reason !== "stop_sequence") {
      return {
        kind: "invalid_output",
        reason: `stop_reason '${parsed.data.stop_reason}'`,
        model: this.model,
        usage,
        providerRequestId,
      };
    }
    const text = (parsed.data.content ?? [])
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("");
    const result = parseModelOutput(text, request.outputSchema);
    if (!result.ok) {
      return { kind: "invalid_output", reason: result.reason, model: this.model, usage, providerRequestId };
    }
    return { kind: "ok", output: result.output, model: this.model, usage, providerRequestId, repaired: false };
  }
}
