import { z } from "zod";

import { AppError, RateLimitError } from "../../shared/errors.js";
import type { ModelGenerateOutcome, ModelGenerateRequest, ModelProvider } from "./types.js";
import { ModelHttp, type ModelHttpOptions } from "./http.js";
import { parseModelOutput } from "./shared.js";

/**
 * MiniMax structured generation over the chat-completion API (ADR-012 — the
 * likely first embedded provider). MiniMax has no native json_schema output
 * mode: the schema travels as a prompt instruction, the engine's Zod schema
 * validates the reply, and ONE in-adapter repair round-trip (re-prompting
 * with the validation error) runs before reporting invalid_output.
 *
 * MiniMax wraps errors in an HTTP-200 `base_resp` envelope: status_code 0 is
 * success; 1002/1008-style throttle codes map to RateLimitError; anything
 * else is an operator-facing PROVIDER_ERROR.
 */
const responseSchema = z
  .object({
    id: z.string().optional(),
    choices: z
      .array(z.object({ message: z.object({ content: z.string().optional() }).passthrough().optional() }).passthrough())
      .optional(),
    usage: z
      .object({ total_tokens: z.number().optional(), prompt_tokens: z.number().optional(), completion_tokens: z.number().optional() })
      .passthrough()
      .optional(),
    base_resp: z.object({ status_code: z.number(), status_msg: z.string().optional() }).passthrough().optional(),
  })
  .passthrough();

const RATE_LIMIT_CODES = new Set([1002, 1008]);

export interface MiniMaxModelOptions extends Omit<ModelHttpOptions, "vendor"> {
  apiKey: string;
  baseUrl?: string;
  model: string;
}

export class MiniMaxModelProvider implements ModelProvider {
  readonly name = "minimax";
  readonly model: string;
  private readonly http: ModelHttp;
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(opts: MiniMaxModelOptions) {
    this.model = opts.model;
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl ?? "https://api.minimax.io";
    this.http = new ModelHttp({ vendor: "minimax", ...opts });
  }

  async generate<T>(request: ModelGenerateRequest<T>): Promise<ModelGenerateOutcome<T>> {
    const schemaInstruction = `Reply with ONLY a JSON object matching this JSON Schema (no prose, no code fences):\n${JSON.stringify(request.wireSchema)}`;
    const messages = [
      { role: "system", content: `${request.prompt.system}\n\n${schemaInstruction}` },
      { role: "user", content: request.prompt.user },
    ];

    const first = await this.chat(messages, request.constraints.maxOutputTokens, request.constraints.temperature);
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
      request.constraints.maxOutputTokens,
      request.constraints.temperature,
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

  private async chat(
    messages: { role: string; content: string }[],
    maxTokens: number,
    temperature?: number,
  ): Promise<{ text: string; usage: { inputTokens: number | null; outputTokens: number | null }; providerRequestId: string | null }> {
    const json = await this.http.postJson(
      `${this.baseUrl}/v1/text/chatcompletion_v2`,
      { authorization: `Bearer ${this.apiKey}` },
      {
        model: this.model,
        max_tokens: maxTokens,
        ...(temperature !== undefined ? { temperature } : {}),
        messages,
      },
    );
    const parsed = responseSchema.safeParse(json);
    if (!parsed.success) {
      return { text: "", usage: { inputTokens: null, outputTokens: null }, providerRequestId: null };
    }
    const base = parsed.data.base_resp;
    if (base && base.status_code !== 0) {
      if (RATE_LIMIT_CODES.has(base.status_code)) {
        throw new RateLimitError(`MiniMax throttled the request (${base.status_code}).`, 30, {
          vendor: "minimax",
          statusCode: base.status_code,
        });
      }
      throw new AppError("PROVIDER_ERROR", `MiniMax rejected the request (${base.status_code}): ${base.status_msg ?? ""}`, {
        vendor: "minimax",
        statusCode: base.status_code,
      });
    }
    return {
      text: parsed.data.choices?.[0]?.message?.content ?? "",
      usage: {
        inputTokens: parsed.data.usage?.prompt_tokens ?? null,
        outputTokens: parsed.data.usage?.completion_tokens ?? parsed.data.usage?.total_tokens ?? null,
      },
      providerRequestId: parsed.data.id ?? null,
    };
  }
}
