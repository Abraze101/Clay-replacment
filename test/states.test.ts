import assert from "node:assert/strict";
import { test } from "node:test";

import {
  assertItemTransition,
  assertRunTransition,
  assertStepTransition,
  ITEM_TRANSITIONS,
  RUN_TRANSITIONS,
  STEP_TRANSITIONS,
} from "../src/engine/runner/states.js";
import type { RunItemStatus, RunStatus, StepStatus } from "../src/storage/database-types.js";

const RUN_STATUSES: RunStatus[] = ["pending", "running", "waiting_review", "paused", "completed", "failed", "cancelled"];
const ITEM_STATUSES: RunItemStatus[] = ["pending", "in_progress", "completed", "failed", "skipped"];
const STEP_STATUSES: StepStatus[] = ["pending", "running", "completed", "failed", "needs_review", "skipped"];

test("states: exhaustive run transition matrix", () => {
  for (const from of RUN_STATUSES) {
    for (const to of RUN_STATUSES) {
      const legal = RUN_TRANSITIONS[from].includes(to);
      if (legal) assert.doesNotThrow(() => assertRunTransition(from, to), `${from}->${to}`);
      else assert.throws(() => assertRunTransition(from, to), `${from}->${to} must be illegal`);
    }
  }
  // Load-bearing pins:
  assert.ok(RUN_TRANSITIONS.waiting_review.includes("running"), "review gate resumes");
  assert.ok(RUN_TRANSITIONS.paused.includes("running"), "credit-cap pause resumes");
  assert.ok(RUN_TRANSITIONS.completed.includes("running"), "retry re-opens a completed run");
  assert.equal(RUN_TRANSITIONS.cancelled.length, 0, "cancelled is terminal");
});

test("states: exhaustive item transition matrix", () => {
  for (const from of ITEM_STATUSES) {
    for (const to of ITEM_STATUSES) {
      const legal = ITEM_TRANSITIONS[from].includes(to);
      if (legal) assert.doesNotThrow(() => assertItemTransition(from, to));
      else assert.throws(() => assertItemTransition(from, to), `${from}->${to} must be illegal`);
    }
  }
  assert.ok(ITEM_TRANSITIONS.failed.includes("in_progress"), "retry requeues failed items");
  assert.equal(ITEM_TRANSITIONS.completed.length, 0);
  assert.equal(ITEM_TRANSITIONS.skipped.length, 0);
});

test("states: exhaustive step transition matrix incl. needs_review rules", () => {
  for (const from of STEP_STATUSES) {
    for (const to of STEP_STATUSES) {
      const legal = STEP_TRANSITIONS[from].includes(to);
      if (legal) assert.doesNotThrow(() => assertStepTransition(from, to));
      else assert.throws(() => assertStepTransition(from, to), `${from}->${to} must be illegal`);
    }
  }
  // needs_review is not claimable: no needs_review -> running transition.
  assert.ok(!STEP_TRANSITIONS.needs_review.includes("running"));
  assert.ok(!STEP_TRANSITIONS.needs_review.includes("pending"));
  // Reconciliation resolves it to completed or failed only.
  assert.deepEqual([...STEP_TRANSITIONS.needs_review].sort(), ["completed", "failed"]);
  // running -> needs_review is the ambiguous-outcome path.
  assert.ok(STEP_TRANSITIONS.running.includes("needs_review"));
});
