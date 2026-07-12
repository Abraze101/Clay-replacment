import assert from "node:assert/strict";
import { test } from "node:test";

import { resumeRun, reviewRun } from "../src/app/run-service.js";
import { createDemoWorkflow, createTestApp, previewAndStart } from "./helpers/setup.js";

test("generate: with NO configured model provider the workflow still completes; generate steps skip with a reason", async () => {
  const t = await createTestApp();
  try {
    assert.equal(t.app.providers.models.size, 0, "M0 ships an intentionally empty model-provider registry");
    const slug = await createDemoWorkflow(t.app);
    const { run } = await previewAndStart(t.app, slug, { profile: "full" });
    await reviewRun(t.app, run.id, { reviewStatus: "approved", itemIds: "all" });
    const finished = await resumeRun(t.app, run.id, {});
    assert.equal(finished.status, "completed", "a run must not require a model provider to finish");

    const generateSteps = await t.app.db.kysely
      .selectFrom("run_item_steps")
      .selectAll()
      .where("step_id", "=", "opener")
      .execute();
    assert.ok(generateSteps.length >= 10);
    assert.ok(generateSteps.every((s) => s.status === "skipped"));
    assert.ok(generateSteps.every((s) => s.skip_reason === "model_provider_not_configured"));

    // Leads remain fully usable without generated copy: no opener outputs exist.
    const openers = await t.app.db.kysely
      .selectFrom("generated_outputs")
      .selectAll()
      .where("kind", "=", "opener")
      .execute();
    assert.equal(openers.length, 0);
  } finally {
    await t.teardown();
  }
});
