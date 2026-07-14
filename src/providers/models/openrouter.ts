import { z } from "zod";

import { AppError } from "../../shared/errors.js";
import type { ModelGenerateOutcome, ModelGenerateRequest, ModelProvider } from "./types.js";
import { ModelHttp, type ModelHttpOptions } from "./http.js";
import { parseModelOutput } from "./shared.js";

/**
 * OpenRouter generation adapter (ADR-032 amendment): the owner's chosen route
 * to MiniMax (default model `minimax/minimax-m3`) without a direct MiniMax
 * account. OpenRouter speaks the OpenAI CHAT-COMPLETIONS surface (not the
 * Responses API), so this is its own adapter: structured output rides
 * `response_format: {type:"json_schema"}` (passed through to supporting
 * providers — MiniMax M3 supports it) AND the schema travels in the system
 * prompt as belt-and-braces for routed providers that ignore response_format.
 * The engine's Zod schema validates every reply, with ONE repair round-trip
 * (the MiniMax-adapter pattern) before reporting invalid_output.
 *
 * Errors: 402 (out of credits) / 401/403 → operator-facing PROVIDER_ERROR;
 * 429 → RateLimitError; 5xx/network/timeout → RetryableProviderError (never
 * ambiguous — model calls bill the owner's OpenRouter account, not engine
 * credits). OpenRouter can also wrap upstream errors in a 200 body
 * `{error: {…}}`; that maps like its HTTP-status counterpart.
 */
const responseSchema = z
  .object({
    id: z.string().optional(),
    choices: z
      .array(z.object({ message: z.object({ content: z.string().nullable().optional() }).passthrough().optional() }).passthrough())
      .optional(),
    usage: z
      .object({ prompt_tokens: z.number().optional(), completion_tokens: z.number().optional() })
      .passthrough()
      .optional(),
    error: z.object({ code: z.union([z.number(), z.string()]).optional(), message: z.string().optional() }).passthrough().optional(),
  })
  .passthrough();

export interface OpenRouterModelOptions extends Omit<ModelHttpOptions, "vendor"> {
  apiKey: string;
  baseUrl?: string;
  model: string;
}

export class OpenRouterModelProvider implements ModelProvider {
  readonly name = "openrouter";
  readonly model: string;
  private readonly http: ModelHttp;
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(opts: OpenRouterModelOptions) {
    this.model = opts.model;
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl ?? "https://openrouter.ai/api/v1";
    this.http = new ModelHttp({ vendor: "openrouter", ...opts });
  }

  async generate<T>(request: ModelGenerateRequest<T>): Promise<ModelGenerateOutcome<T>> {
    const schemaInstruction = `Reply with ONLY a JSON object matching this JSON Schema (no prose, no code fences):\n${JSON.stringify(request.wireSchema)}`;
    const messages = [
      { role: "system", content: `${request.prompt.system}\n\n${schemaInstruction}` },
      { role: "user", content: request.prompt.user },
    ];

    const first = await this.chat(messages, request);
    let usage = first.usage;
    let providerRequestId = first.providerRequestId;
    const firstResult = parseModelOutput(first.text, request.outputSchema);
    if (firstResult.ok) {
      return { kind: "ok", output: firstResult.output, model: this.model, usage, providerRequestId, repaired: false };
    }

    // One repair round-trip: show the model its reply and the validation error.
    const repaired = await this.chat(
      [
        ...messages,
        { role: "assistant", content: first.text },
        {
          role: "user",
          content: `Your reply failed validation: ${firstResult.reason}. Reply again with ONLY the corrected JSON object.`,
        },
      ],
      request,
    );
    usage = {
      inputTokens: (usage.inputTokens ?? 0) + (repaired.usage.inputTokens ?? 0) || null,
      outputTokens: (usage.outputTokens ?? 0) + (repaired.usage.outputTokens ?? 0) || null,
    };
    providerRequestId = repaired.providerRequestId ?? providerRequestId;
    const repairedResult = parseModelOutput(repaired.text, request.outputSchema);
    if (!repairedResult.ok) {
      return { kind: "invalid_output", reason: repairedResult.reason, model: this.model, usage, providerRequestId };
    }
    return { kind: "ok", output: repairedResult.output, model: this.model, usage, providerRequestId, repaired: true };
  }

  private async chat<T>(
    messages: { role: string; content: string }[],
    request: ModelGenerateRequest<T>,
  ): Promise<{ text: string; usage: { inputTokens: number | null; outputTokens: number | null }; providerRequestId: string | null }> {
    const json = await this.http.postJson(
      `${this.baseUrl}/chat/completions`,
      {
        authorization: `Bearer ${this.apiKey}`,
        // OpenRouter attribution headers (optional, recommended by their docs).
        "x-title": "lead-engine",
      },
      {
        model: this.model,
        max_tokens: request.constraints.maxOutputTokens,
        ...(request.constraints.temperature !== undefined ? { temperature: request.constraints.temperature } : {}),
        messages,
        response_format: {
          type: "json_schema",
          json_schema: { name: "generation_output", strict: true, schema: request.wireSchema },
        },
      },
    );
    const parsed = responseSchema.safeParse(json);
    if (!parsed.success) {
      return { text: "", usage: { inputTokens: null, outputTokens: null }, providerRequestId: null };
    }
    if (parsed.data.error) {
      // Upstream errors can arrive inside an HTTP 200 envelope.
      throw new AppError(
        "PROVIDER_ERROR",
        `OpenRouter reported an error${parsed.data.error.code !== undefined ? ` (${parsed.data.error.code})` : ""}: ${parsed.data.error.message ?? "unknown"}`,
        { vendor: "openrouter" },
      );
    }
    return {
      text: parsed.data.choices?.[0]?.message?.content ?? "",
      usage: {
        inputTokens: parsed.data.usage?.prompt_tokens ?? null,
        outputTokens: parsed.data.usage?.completion_tokens ?? null,
      },
      providerRequestId: parsed.data.id ?? null,
    };
  }
}
