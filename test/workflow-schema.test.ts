import assert from "node:assert/strict";
import { test } from "node:test";

import { parseWorkflowDefinition } from "../src/engine/workflow-schema/workflow.js";
import { conditionSchema, evaluateCondition, evaluateRuleGroup } from "../src/engine/workflow-schema/rules.js";
import { demoDefinition } from "./helpers/setup.js";

function withSteps(steps: unknown[]): Record<string, unknown> {
  return { ...demoDefinition(), steps };
}

test("schema: the demo definition (all 10 step types) validates", () => {
  const definition = parseWorkflowDefinition(demoDefinition());
  assert.equal(definition.steps.length, 10);
});

test("schema: unknown step types are rejected", () => {
  assert.throws(
    () => parseWorkflowDefinition(withSteps([{ id: "x", type: "execute_javascript", code: "evil()" }])),
    /invalid/i,
  );
});

test("schema: duplicate step ids are rejected", () => {
  assert.throws(() =>
    parseWorkflowDefinition(
      withSteps([
        { id: "a", type: "source", provider: "fake-places" },
        { id: "a", type: "normalize" },
      ]),
    ),
  );
});

test("schema: the first step must be a source step", () => {
  assert.throws(() => parseWorkflowDefinition(withSteps([{ id: "n", type: "normalize" }])));
});

test("schema: export requires a preceding review_gate and must be last", () => {
  assert.throws(() =>
    parseWorkflowDefinition(
      withSteps([
        { id: "s", type: "source", provider: "fake-places" },
        { id: "e", type: "export", format: "csv" },
      ]),
    ),
  );
  assert.throws(() =>
    parseWorkflowDefinition(
      withSteps([
        { id: "s", type: "source", provider: "fake-places" },
        { id: "e", type: "export", format: "csv" },
        { id: "r", type: "review_gate" },
      ]),
    ),
  );
});

test("schema: unknown extra keys on steps are rejected (strict objects)", () => {
  assert.throws(() =>
    parseWorkflowDefinition(
      withSteps([{ id: "s", type: "source", provider: "fake-places", shellCommand: "rm -rf /" }]),
    ),
  );
});

test("rules: unknown operators are rejected", () => {
  assert.equal(conditionSchema.safeParse({ field: "rating", op: "regex", value: ".*" }).success, false);
});

test("rules: fields outside the declared allowlist are rejected (no dynamic paths)", () => {
  assert.equal(conditionSchema.safeParse({ field: "lead.__proto__", op: "eq", value: 1 }).success, false);
  assert.equal(conditionSchema.safeParse({ field: "$.steps[0]", op: "eq", value: 1 }).success, false);
});

test("rules: operator/value shape mismatches are rejected", () => {
  assert.equal(conditionSchema.safeParse({ field: "rating", op: "exists", value: 1 }).success, false);
  assert.equal(conditionSchema.safeParse({ field: "rating", op: "in", value: 4 }).success, false);
  assert.equal(conditionSchema.safeParse({ field: "rating", op: "gte", value: "high" }).success, false);
  assert.equal(conditionSchema.safeParse({ field: "name", op: "contains", value: 4 }).success, false);
});

test("rules: evaluation semantics", () => {
  const ctx = { rating: 4.5, name: "Austin Roof Pros", has_website: true, review_count: 10 };
  assert.equal(evaluateCondition({ field: "rating", op: "gte", value: 4 }, ctx), true);
  assert.equal(evaluateCondition({ field: "rating", op: "lt", value: 4 }, ctx), false);
  assert.equal(evaluateCondition({ field: "name", op: "contains", value: "roof" }, ctx), true);
  assert.equal(evaluateCondition({ field: "category", op: "exists" }, ctx), false);
  assert.equal(evaluateCondition({ field: "name", op: "in", value: ["Austin Roof Pros"] }, ctx), true);
  assert.equal(evaluateRuleGroup({ all: [{ field: "has_website", op: "eq", value: true }, { field: "review_count", op: "gte", value: 5 }] }, ctx), true);
  assert.equal(evaluateRuleGroup({ any: [{ field: "has_website", op: "eq", value: false }, { field: "review_count", op: "gte", value: 5 }] }, ctx), true);
});
