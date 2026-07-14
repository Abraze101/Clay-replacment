import assert from "node:assert/strict";
import { test } from "node:test";

import { AnthropicModelProvider } from "../src/providers/models/anthropic.js";
import { MiniMaxModelProvider } from "../src/providers/models/minimax.js";
import { OpenAiModelProvider } from "../src/providers/models/openai.js";
import { toStrictJsonSchema } from "../src/providers/models/shared.js";
import type { ModelGenerateRequest, ModelProvider } from "../src/providers/models/types.js";
import { openerOutputSchema, type OpenerOutput } from "../src/engine/generation/templates.js";
import { RateLimitError, RetryableProviderError } from "../src/shared/errors.js";

const SECRET = "sk-model-secret-987654";
const VALID_OUTPUT = { subject: "About Austin Roof Pros", opener: "Saw the 4.8 rating.", claims: [{ text: "rated 4.8", evidence: ["E1"] }] };

function request(): ModelGenerateRequest<OpenerOutput> {
  return {
    kind: "opener",
    promptVersion: "opener/v1",
    prompt: { system: "system prompt", user: "EVIDENCE:\nE1: rating = 4.8\n\nTASK:\nwrite" },
    outputSchema: openerOutputSchema,
    wireSchema: toStrictJsonSchema(openerOutputSchema),
    constraints: { maxOutputTokens: 400 },
    requestKey: "model-test-1",
  };
}

function fetchStub(responses: { status: number; body: unknown; headers?: Record<string, string> }[]): {
  impl: typeof fetch;
  calls: { url: string; body: string }[];
} {
  const calls: { url: string; body: string }[] = [];
  let index = 0;
  const impl = ((url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const urlText = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
    calls.push({ url: urlText, body: typeof init?.body === "string" ? init.body : "" });
    const next = responses[Math.min(index, responses.length - 1)]!;
    index += 1;
    return Promise.resolve(
      new Response(typeof next.body === "string" ? next.body : JSON.stringify(next.body), {
        status: next.status,
        headers: next.headers,
      }),
    );
  }) as typeof fetch;
  return { impl, calls };
}

function providers(fetchImpl: typeof fetch): { name: string; provider: ModelProvider }[] {
  const opts = { apiKey: SECRET, maxRequestsPerMinute: 6000, fetchImpl };
  return [
    { name: "openai", provider: new OpenAiModelProvider({ ...opts, model: "gpt-test" }) },
    { name: "anthropic", provider: new AnthropicModelProvider({ ...opts, model: "claude-test" }) },
    { name: "minimax", provider: new MiniMaxModelProvider({ ...opts, model: "MiniMax-Test" }) },
  ];
}

const OK_BODIES: Record<string, unknown> = {
  openai: {
    id: "resp_1",
    status: "completed",
    output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(VALID_OUTPUT) }] }],
    usage: { input_tokens: 100, output_tokens: 50 },
  },
  anthropic: {
    id: "msg_1",
    content: [{ type: "text", text: JSON.stringify(VALID_OUTPUT) }],
    stop_reason: "end_turn",
    usage: { input_tokens: 100, output_tokens: 50 },
  },
  minimax: {
    id: "mm_1",
    choices: [{ message: { content: JSON.stringify(VALID_OUTPUT) } }],
    usage: { prompt_tokens: 100, completion_tokens: 50 },
    base_resp: { status_code: 0 },
  },
};

test("model contract: the same request yields the same validated output across all three adapters", async () => {
  for (const { name, provider } of providers(fetch)) {
    const stub = fetchStub([{ status: 200, body: OK_BODIES[name] }]);
    const p = providers(stub.impl).find((x) => x.name === name)!.provider;
    const outcome = await p.generate(request());
    assert.equal(outcome.kind, "ok", `${name} succeeds`);
    if (outcome.kind !== "ok") continue;
    assert.deepEqual(outcome.output, VALID_OUTPUT, `${name} returns the schema-validated object`);
    assert.equal(outcome.usage.inputTokens, 100);
    assert.equal(outcome.usage.outputTokens, 50);
    assert.equal(outcome.repaired, false);
    void provider;
  }
});

test("model contract: 429 → RateLimitError with Retry-After; 5xx → retryable; key never leaks into errors", async () => {
  for (const { name } of providers(fetch)) {
    const limited = providers(fetchStub([{ status: 429, body: "slow down", headers: { "retry-after": "17" } }]).impl).find(
      (x) => x.name === name,
    )!.provider;
    await assert.rejects(
      () => limited.generate(request()),
      (err: unknown) => {
        assert.ok(err instanceof RateLimitError, `${name}: 429 is a RateLimitError`);
        assert.equal(err.retryAfterSeconds, 17);
        assert.ok(!JSON.stringify({ m: err.message, d: err.details }).includes(SECRET), "no key in errors");
        return true;
      },
    );

    const broken = providers(fetchStub([{ status: 503, body: "upstream down" }]).impl).find((x) => x.name === name)!.provider;
    await assert.rejects(
      () => broken.generate(request()),
      (err: unknown) => {
        assert.ok(err instanceof RetryableProviderError, `${name}: 5xx is retryable (never ambiguous — no credits at risk)`);
        assert.equal(err.details["charged"], false);
        return true;
      },
    );
  }
});

test("model contract: refusal/incomplete/malformed replies are invalid_output, not thrown errors", async () => {
  const cases: { name: string; body: unknown }[] = [
    { name: "openai", body: { id: "resp_2", status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [] } },
    { name: "anthropic", body: { id: "msg_2", content: [{ type: "text", text: "partial{" }], stop_reason: "max_tokens" } },
    { name: "minimax", body: { id: "mm_2", choices: [{ message: { content: "not json at all" } }], base_resp: { status_code: 0 } } },
  ];
  for (const c of cases) {
    // MiniMax runs its repair round-trip; feed it the same broken reply twice.
    const stub = fetchStub([{ status: 200, body: c.body }, { status: 200, body: c.body }]);
    const provider = providers(stub.impl).find((x) => x.name === c.name)!.provider;
    const outcome = await provider.generate(request());
    assert.equal(outcome.kind, "invalid_output", `${c.name} reports invalid output honestly`);
  }
});

test("minimax: one repair round-trip re-prompts with the validation error and reports repaired:true", async () => {
  const stub = fetchStub([
    { status: 200, body: { id: "mm_3", choices: [{ message: { content: "here it is: {\"opener\": 1}" } }], base_resp: { status_code: 0 } } },
    { status: 200, body: OK_BODIES["minimax"] },
  ]);
  const provider = new MiniMaxModelProvider({ apiKey: SECRET, model: "MiniMax-Test", maxRequestsPerMinute: 6000, fetchImpl: stub.impl });
  const outcome = await provider.generate(request());
  assert.equal(outcome.kind, "ok");
  if (outcome.kind !== "ok") return;
  assert.equal(outcome.repaired, true);
  assert.equal(stub.calls.length, 2);
  assert.match(stub.calls[1]!.body, /failed validation/, "the repair prompt carries the validation error");
});

test("minimax: base_resp throttle codes map to RateLimitError inside an HTTP 200", async () => {
  const stub = fetchStub([{ status: 200, body: { base_resp: { status_code: 1002, status_msg: "throttled" } } }]);
  const provider = new MiniMaxModelProvider({ apiKey: SECRET, model: "MiniMax-Test", maxRequestsPerMinute: 6000, fetchImpl: stub.impl });
  await assert.rejects(
    () => provider.generate(request()),
    (err: unknown) => err instanceof RateLimitError,
  );
});
