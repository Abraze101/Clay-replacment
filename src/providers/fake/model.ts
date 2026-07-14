import type {
  ModelGenerateOutcome,
  ModelGenerateRequest,
  ModelProvider,
} from "../models/types.js";

/**
 * Deterministic fake model provider for offline generation tests and demos.
 * Builds schema-valid, evidence-grounded output straight from the prompt's
 * evidence list (ids parsed from the "E1: label = value" lines). Registered
 * only when GENERATE_MODEL_PROVIDER=fake — the registry stays empty by
 * default so generation-disabled behavior remains the baseline.
 *
 * Test hook: any evidence VALUE containing 'FORCE_INVALID_OUTPUT' makes every
 * attempt return invalid_output (exercising retry-once-then-continue);
 * 'FORCE_UNGROUNDED_CLAIM' emits one claim citing a nonexistent evidence id
 * (exercising grounding strips).
 */
export class FakeModelProvider implements ModelProvider {
  readonly name = "fake-model";
  readonly model = "fake-model-1";

  async generate<T>(request: ModelGenerateRequest<T>): Promise<ModelGenerateOutcome<T>> {
    const usage = {
      inputTokens: Math.ceil(request.prompt.user.length / 4),
      outputTokens: 64,
    };
    const providerRequestId = `fake-model-${request.requestKey}`;
    if (request.prompt.user.includes("FORCE_INVALID_OUTPUT")) {
      return Promise.resolve({
        kind: "invalid_output",
        reason: "fixture forced invalid output",
        model: this.model,
        usage,
        providerRequestId,
      });
    }

    const evidence = [...request.prompt.user.matchAll(/^(E\d+): (.+?) = (.+)$/gm)].map((m) => ({
      id: m[1] as string,
      label: m[2] as string,
      value: m[3] as string,
    }));
    const ids = evidence.map((e) => e.id);
    const nameItem = evidence.find((e) => e.label.includes("name")) ?? evidence[0];
    const claims = evidence.slice(0, 3).map((e) => ({
      text: `${e.label}: ${e.value}`,
      evidence: [e.id],
    }));
    if (request.prompt.user.includes("FORCE_UNGROUNDED_CLAIM")) {
      claims.push({ text: "an invented fact with no basis", evidence: ["E999"] });
    }
    const subject = `About ${nameItem?.value ?? "your business"}`;

    const raw: Record<string, unknown> =
      request.kind === "fit_rationale"
        ? {
            summary: `Deterministic fit rationale for ${nameItem?.value ?? "the lead"} from ${ids.length} evidence item(s).`,
            claims,
            caveats: ["fake output for offline testing"],
          }
        : request.kind === "call_notes"
          ? {
              openerLine: `Hi, this is a call for ${nameItem?.value ?? "you"}.`,
              talkingPoints: claims,
              bestCallWindow: evidence.some((e) => e.label === "timezone") ? "9:30-11:30 local time" : null,
              doNotSay: ["Never call a number 'verified' when only its format was checked."],
            }
          : {
              subject,
              opener: `Noticed ${nameItem?.value ?? "your business"} — short note from a local agency.`,
              claims,
            };

    const parsed = request.outputSchema.safeParse(raw);
    if (!parsed.success) {
      return Promise.resolve({
        kind: "invalid_output",
        reason: `fake output failed schema: ${parsed.error.issues[0]?.message ?? "unknown"}`,
        model: this.model,
        usage,
        providerRequestId,
      });
    }
    return Promise.resolve({
      kind: "ok",
      output: parsed.data,
      model: this.model,
      usage,
      providerRequestId,
      repaired: false,
    });
  }
}
