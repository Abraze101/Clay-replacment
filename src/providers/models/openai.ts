import { z } from "zod";

import type { ModelGenerateOutcome, ModelGenerateRequest, ModelProvider } from "./types.js";
import { ModelHttp, type ModelHttpOptions } from "./http.js";
import { parseModelOutput } from "./shared.js";

/**
 * OpenAI structured generation over the Responses API with a strict
 * json_schema output format. Plain fetch + Zod (ADR-032); the engine's Zod
 * schema re-validates whatever the API returns — strict mode is a first
 * filter, never the trust boundary.
 */
const responseSchema = z
  .object({
    id: z.string().optional(),
    status: z.string().optional(),
    incomplete_details: z.object({ reason: z.string().optional() }).passthrough().optional(),
    output: z
      .array(
        z
          .object({
            type: z.string().optional(),
            content: z.array(z.object({ type: z.string().optional(), text: z.string().optional() }).passthrough()).optional(),
          })
          .passthrough(),
      )
      .optional(),
    usage: z.object({ input_tokens: z.number().optional(), output_tokens: z.number().optional() }).passthrough().optional(),
  })
  .passthrough();

export interface OpenAiModelOptions extends Omit<ModelHttpOptions, "vendor"> {
  apiKey: string;
  baseUrl?: string;
  model: string;
}

export class OpenAiModelProvider implements ModelProvider {
  readonly name = "openai";
  readonly model: string;
  private readonly http: ModelHttp;
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(opts: OpenAiModelOptions) {
    this.model = opts.model;
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl ?? "https://api.openai.com";
    this.http = new ModelHttp({ vendor: "openai", ...opts });
  }

  async generate<T>(request: ModelGenerateRequest<T>): Promise<ModelGenerateOutcome<T>> {
    const json = await this.http.postJson(
      `${this.baseUrl}/v1/responses`,
      { authorization: `Bearer ${this.apiKey}` },
      {
        model: this.model,
        max_output_tokens: request.constraints.maxOutputTokens,
        ...(request.constraints.temperature !== undefined ? { temperature: request.constraints.temperature } : {}),
        input: [
          { role: "system", content: request.prompt.system },
          { role: "user", content: request.prompt.user },
        ],
        text: {
          format: { type: "json_schema", name: "generation_output", schema: request.wireSchema, strict: true },
        },
      },
    );
    const parsed = responseSchema.safeParse(json);
    const usage = {
      inputTokens: parsed.success ? (parsed.data.usage?.input_tokens ?? null) : null,
      outputTokens: parsed.success ? (parsed.data.usage?.output_tokens ?? null) : null,
    };
    const providerRequestId = parsed.success ? (parsed.data.id ?? null) : null;
    if (!parsed.success) {
      return { kind: "invalid_output", reason: "unrecognized Responses API payload", model: this.model, usage, providerRequestId };
    }
    if (parsed.data.status && parsed.data.status !== "completed") {
      return {
        kind: "invalid_output",
        reason: `response status '${parsed.data.status}'${parsed.data.incomplete_details?.reason ? ` (${parsed.data.incomplete_details.reason})` : ""}`,
        model: this.model,
        usage,
        providerRequestId,
      };
    }
    const text = (parsed.data.output ?? [])
      .flatMap((item) => item.content ?? [])
      .filter((c) => c.type === "output_text")
      .map((c) => c.text ?? "")
      .join("");
    const result = parseModelOutput(text, request.outputSchema);
    if (!result.ok) {
      return { kind: "invalid_output", reason: result.reason, model: this.model, usage, providerRequestId };
    }
    return { kind: "ok", output: result.output, model: this.model, usage, providerRequestId, repaired: false };
  }
}
