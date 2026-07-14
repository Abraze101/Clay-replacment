import assert from "node:assert/strict";
import { test } from "node:test";

import { resumeRun, reviewRun } from "../src/app/run-service.js";
import { createWorkflowFromDefinition } from "../src/app/workflow-service.js";
import { num } from "../src/storage/database-types.js";
import { listRunItems, listSteps } from "../src/storage/repositories/run-repo.js";
import { createDemoWorkflow, createTestApp, previewAndStart } from "./helpers/setup.js";

test("generate step: fake model produces grounded, versioned outputs at zero engine cost", async () => {
  const t = await createTestApp({ GENERATE_MODEL_PROVIDER: "fake" });
  try {
    const slug = await createDemoWorkflow(t.app);
    const { run } = await previewAndStart(t.app, slug, { profile: "full" });
    await reviewRun(t.app, run.id, { reviewStatus: "approved", itemIds: "all" });
    const finished = await resumeRun(t.app, run.id, {});
    assert.equal(finished.status, "completed");

    const outputs = await t.app.db.kysely
      .selectFrom("generated_outputs")
      .selectAll()
      .where("run_id", "=", run.id)
      .where("kind", "=", "opener")
      .execute();
    assert.ok(outputs.length >= 9, "openers generated for the completed leads");
    for (const output of outputs) {
      assert.equal(output.prompt_version, "opener/v1");
      assert.equal(output.model_provider, "fake-model");
      assert.equal(output.model, "fake-model-1");
      assert.ok(output.evidence.length > 0, "every output carries persisted-evidence refs");
      const content = output.content as { opener?: string; claims?: { evidence: string[] }[] };
      assert.ok(content.opener);
      assert.ok((content.claims ?? []).every((c) => c.evidence.length > 0));
    }

    // Generation is free: no engine credits beyond the enrich/validation spend
    // (32 — see runner-happy-path), and the generate steps booked cost 0.
    const items = await listRunItems(t.app.db.kysely, run.id);
    const first = items.find((i) => i.position === 1);
    const steps = await listSteps(t.app.db.kysely, first!.id);
    const generate = steps.find((s) => s.step_id === "opener");
    assert.equal(generate?.status, "completed");
    assert.equal(num(generate?.cost_units ?? 0), 0);
    const result = generate?.result as { provider?: string; outputTokens?: number };
    assert.equal(result?.provider, "fake-model");
    assert.ok((result?.outputTokens ?? 0) > 0, "token usage recorded informationally");
  } finally {
    await t.teardown();
  }
});

test("generate step: invalid output twice → step completes, lead stays usable without copy", async () => {
  const t = await createTestApp({ GENERATE_MODEL_PROVIDER: "fake" });
  try {
    const definition = {
      id: "generate-invalid-test",
      version: 1,
      name: "Invalid generation test",
      inputs: { limit: 2, enrichmentProfile: "full" },
      steps: [
        { id: "import", type: "source", provider: "imported-list" },
        { id: "normalize", type: "normalize" },
        { id: "dedupe", type: "dedupe" },
        { id: "opener", type: "generate", template: "agency-opener", profiles: ["full"] },
      ],
    };
    const created = await createWorkflowFromDefinition(t.app, definition);
    const inputs = {
      importRows: [
        { name: "FORCE_INVALID_OUTPUT Roofing", website: "https://invalid-gen.example", locality: "Austin", region: "TX" },
        { name: "Fine Roofing Co", website: "https://fine-gen.example", locality: "Austin", region: "TX" },
      ],
    };
    const { run } = await previewAndStart(t.app, created.slug, { profile: "full", inputs });
    assert.equal(run.status, "completed");

    const items = await listRunItems(t.app.db.kysely, run.id);
    const broken = items.find((i) => i.source_key.includes("1") || (i.snapshot as { source?: { name?: string } }).source?.name?.includes("FORCE"));
    const fine = items.find((i) => i.id !== broken?.id);
    assert.ok(broken && fine);
    assert.equal(broken.status, "completed", "the lead stays usable without generated copy");
    const brokenSteps = await listSteps(t.app.db.kysely, broken.id);
    const brokenGenerate = brokenSteps.find((s) => s.step_id === "opener");
    assert.equal(brokenGenerate?.status, "completed");
    assert.match((brokenGenerate?.result as { reason?: string }).reason ?? "", /forced invalid/);

    const outputs = await t.app.db.kysely
      .selectFrom("generated_outputs")
      .selectAll()
      .where("run_id", "=", run.id)
      .execute();
    assert.equal(outputs.filter((o) => o.lead_id === broken.lead_id).length, 0, "no output row for invalid generations");
    assert.equal(outputs.filter((o) => o.lead_id === fine.lead_id).length, 1, "the healthy lead still generated");
  } finally {
    await t.teardown();
  }
});

test("generate step: with NO model provider the run still sources, scores, and exports (regression)", async () => {
  const t = await createTestApp();
  try {
    const slug = await createDemoWorkflow(t.app);
    const preview = await previewAndStart(t.app, slug, { profile: "full" });
    assert.ok(
      preview.preview.plan.warnings.some((w) => w.includes("SKIPPED: no model provider")),
      "the preview says generation will be skipped",
    );
    await reviewRun(t.app, preview.run.id, { reviewStatus: "approved", itemIds: "all" });
    const finished = await resumeRun(t.app, preview.run.id, {});
    assert.equal(finished.status, "completed");
    const outputs = await t.app.db.kysely
      .selectFrom("generated_outputs")
      .selectAll()
      .where("run_id", "=", preview.run.id)
      .where("kind", "=", "opener")
      .execute();
    assert.equal(outputs.length, 0);
  } finally {
    await t.teardown();
  }
});
