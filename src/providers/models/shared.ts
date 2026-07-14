import { z } from "zod";

/**
 * Derive a strict-mode-friendly JSON Schema from the engine's Zod schema.
 * Vendor strict modes (OpenAI json_schema strict, Anthropic output_config)
 * reject value-constraint keywords and demand `additionalProperties: false`
 * with every property required — the constraints stay enforced engine-side by
 * Zod, which remains the source of truth.
 */
export function toStrictJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const raw = z.toJSONSchema(schema) as Record<string, unknown>;
  return sanitize(raw) as Record<string, unknown>;
}

const STRIPPED_KEYWORDS = new Set([
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "pattern",
  "format",
  "minItems",
  "maxItems",
  "default",
  "$schema",
]);

function sanitize(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(sanitize);
  if (node === null || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  const record = node as Record<string, unknown>;
  for (const [key, value] of Object.entries(record)) {
    if (STRIPPED_KEYWORDS.has(key)) continue;
    out[key] = sanitize(value);
  }
  if (out["type"] === "object" && typeof out["properties"] === "object" && out["properties"] !== null) {
    out["additionalProperties"] = false;
    out["required"] = Object.keys(out["properties"]);
  }
  return out;
}

/**
 * Pull the first JSON object out of a model reply, tolerating code fences and
 * surrounding prose (needed for vendors without native structured output).
 */
export function extractJsonCandidate(text: string): string | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const body = fenced?.[1] ?? text;
  const start = body.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < body.length; i += 1) {
    const ch = body[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = inString;
      continue;
    }
    if (ch === '"') inString = !inString;
    if (inString) continue;
    if (ch === "{") depth += 1;
    if (ch === "}") {
      depth -= 1;
      if (depth === 0) return body.slice(start, i + 1);
    }
  }
  return null;
}

/** Parse + validate a model reply against the engine schema; returns a reason on failure. */
export function parseModelOutput<T>(
  text: string,
  schema: z.ZodType<T>,
): { ok: true; output: T } | { ok: false; reason: string } {
  const candidate = extractJsonCandidate(text);
  if (candidate === null) return { ok: false, reason: "reply contains no JSON object" };
  let json: unknown;
  try {
    json = JSON.parse(candidate);
  } catch {
    return { ok: false, reason: "reply JSON does not parse" };
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    return { ok: false, reason: `schema validation failed: ${issues}` };
  }
  return { ok: true, output: parsed.data };
}
