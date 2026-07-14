import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";

import type { EvidenceBundle, EvidenceItem } from "../src/engine/generation/evidence.js";
import { validateGrounding } from "../src/engine/generation/grounding.js";
import { GENERATION_TEMPLATES } from "../src/engine/generation/templates.js";
import { extractJsonCandidate, toStrictJsonSchema } from "../src/providers/models/shared.js";

function bundleOf(items: Partial<EvidenceItem>[], hasTimezone = false): EvidenceBundle {
  const full = items.map((i, idx) => ({
    id: i.id ?? `E${idx + 1}`,
    label: i.label ?? `label ${idx + 1}`,
    value: i.value ?? `value ${idx + 1}`,
    ref: i.ref ?? { field: `field${idx + 1}` },
  }));
  return { items: full, byId: new Map(full.map((i) => [i.id, i])), hasTimezone };
}

const CALL_NOTES = GENERATION_TEMPLATES.get("call-notes")!;
const OPENER = GENERATION_TEMPLATES.get("agency-opener")!;

test("grounding: claims citing unknown evidence ids are stripped; refs resolve and dedupe", () => {
  const bundle = bundleOf([
    { id: "E1", ref: { leadSourceId: "ls-1", field: "displayName" } },
    { id: "E2", ref: { contactPointId: "cp-1", field: "normalized_value" } },
  ]);
  const result = validateGrounding(
    {
      subject: null,
      opener: "hello",
      claims: [
        { text: "grounded on both", evidence: ["E1", "E2"] },
        { text: "invented", evidence: ["E999"] },
        { text: "partially grounded", evidence: ["E2", "E404"] },
      ],
    },
    OPENER,
    bundle,
  );
  assert.ok(result.ok);
  if (!result.ok) return;
  const claims = result.content["claims"] as { text: string; evidence: string[] }[];
  assert.equal(claims.length, 2, "the fully-invented claim is stripped");
  assert.deepEqual(claims[1]?.evidence, ["E2"], "unknown ids are removed from surviving claims");
  assert.equal(result.strippedClaims, 1);
  assert.deepEqual(result.evidence, [
    { leadSourceId: "ls-1", field: "displayName" },
    { contactPointId: "cp-1", field: "normalized_value" },
  ]);
});

test("grounding: a required claim section with nothing grounded invalidates the output", () => {
  const bundle = bundleOf([{ id: "E1" }]);
  const result = validateGrounding(
    { subject: null, opener: "hello", claims: [{ text: "invented", evidence: ["E9"] }] },
    OPENER,
    bundle,
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /no grounded claims/);
});

test("grounding: bestCallWindow is nulled unless timezone evidence exists", () => {
  const noTz = validateGrounding(
    {
      openerLine: "hi",
      talkingPoints: [{ text: "point", evidence: ["E1"] }],
      bestCallWindow: "9-11am",
      doNotSay: [],
    },
    CALL_NOTES,
    bundleOf([{ id: "E1" }], false),
  );
  assert.ok(noTz.ok);
  if (noTz.ok) assert.equal(noTz.content["bestCallWindow"], null);

  const withTz = validateGrounding(
    {
      openerLine: "hi",
      talkingPoints: [{ text: "point", evidence: ["E1"] }],
      bestCallWindow: "9-11am",
      doNotSay: [],
    },
    CALL_NOTES,
    bundleOf([{ id: "E1", label: "timezone", value: "America/Chicago" }], true),
  );
  assert.ok(withTz.ok);
  if (withTz.ok) assert.equal(withTz.content["bestCallWindow"], "9-11am");
});

test("wire schema: strict-mode friendly — constraints stripped, additionalProperties false, all required", () => {
  const schema = z
    .object({
      name: z.string().min(3),
      count: z.number().max(10),
      tags: z.array(z.string()).max(5),
      note: z.string().nullable(),
    })
    .strict();
  const wire = toStrictJsonSchema(schema) as {
    additionalProperties?: boolean;
    required?: string[];
    properties?: Record<string, Record<string, unknown>>;
  };
  assert.equal(wire.additionalProperties, false);
  assert.deepEqual(wire.required?.sort(), ["count", "name", "note", "tags"]);
  assert.equal(wire.properties?.["name"]?.["minLength"], undefined);
  assert.equal(wire.properties?.["count"]?.["maximum"], undefined);
  assert.equal(wire.properties?.["tags"]?.["maxItems"], undefined);
});

test("extraction: JSON is found inside code fences and surrounding prose", () => {
  assert.equal(extractJsonCandidate('```json\n{"a": 1}\n```'), '{"a": 1}');
  assert.equal(extractJsonCandidate('Here you go: {"a": {"b": "}"}} extra'), '{"a": {"b": "}"}}');
  assert.equal(extractJsonCandidate("no json here"), null);
});
