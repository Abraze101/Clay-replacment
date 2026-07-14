import assert from "node:assert/strict";
import { test } from "node:test";

import { resumeRun, retryRun, reviewRun } from "../src/app/run-service.js";
import { listRunItems, listSteps } from "../src/storage/repositories/run-repo.js";
import { createDemoWorkflow, createTestApp, previewAndStart } from "./helpers/setup.js";

test("regenerate: marked items re-run their generate step, append a fresh output, and return to unreviewed", async () => {
  const t = await createTestApp({ GENERATE_MODEL_PROVIDER: "fake" });
  try {
    const slug = await createDemoWorkflow(t.app);
    const { run } = await previewAndStart(t.app, slug, { profile: "full" });
    await reviewRun(t.app, run.id, { reviewStatus: "approved", itemIds: "all" });
    const finished = await resumeRun(t.app, run.id, {});
    assert.equal(finished.status, "completed");

    const items = await listRunItems(t.app.db.kysely, run.id);
    const target = items.find((i) => i.position === 1);
    assert.ok(target?.lead_id);
    const before = await t.app.db.kysely
      .selectFrom("generated_outputs")
      .selectAll()
      .where("run_id", "=", run.id)
      .where("lead_id", "=", target.lead_id)
      .where("kind", "=", "opener")
      .execute();
    assert.equal(before.length, 1);

    // The needs_review enrich step (fx-011) must stay untouched by regeneration.
    const ambiguousItem = items.find((i) => i.source_key === "fx-011");
    const ambiguousBefore = (await listSteps(t.app.db.kysely, ambiguousItem!.id)).find((s) => s.step_id === "owner");
    assert.equal(ambiguousBefore?.status, "needs_review");

    await reviewRun(t.app, run.id, { reviewStatus: "regenerate", itemIds: [target.id] });
    const retried = await retryRun(t.app, run.id);
    assert.equal(retried.status, "completed");

    const after = await t.app.db.kysely
      .selectFrom("generated_outputs")
      .selectAll()
      .where("run_id", "=", run.id)
      .where("lead_id", "=", target.lead_id)
      .where("kind", "=", "opener")
      .orderBy("created_at")
      .execute();
    assert.equal(after.length, 2, "append-only history: the fresh output joins the old one");

    const refreshedItems = await listRunItems(t.app.db.kysely, run.id);
    const refreshed = refreshedItems.find((i) => i.id === target.id);
    assert.equal(refreshed?.review_status, "unreviewed", "a regenerated item returns to the review queue");
    assert.equal(refreshed?.status, "completed");
    const untouched = refreshedItems.filter((i) => i.id !== target.id && i.review_status === "approved");
    assert.ok(untouched.length > 0, "other approvals stay intact");

    const ambiguousAfter = (await listSteps(t.app.db.kysely, ambiguousItem!.id)).find((s) => s.step_id === "owner");
    assert.equal(ambiguousAfter?.status, "needs_review", "needs_review is never touched by retry/regenerate");
    assert.equal(ambiguousAfter?.attempts, ambiguousBefore?.attempts);
  } finally {
    await t.teardown();
  }
});
