import assert from "node:assert/strict";
import { test } from "node:test";

import { createWorkflowFromDefinition, validateWorkflow } from "../src/app/workflow-service.js";
import { createDemoWorkflow, createTestApp, demoDefinition } from "./helpers/setup.js";

test("versioning: re-validating an unchanged draft returns the SAME version (no fork)", async () => {
  const t = await createTestApp();
  try {
    const slug = await createDemoWorkflow(t.app);
    const v1 = await validateWorkflow(t.app, slug);
    const v1again = await validateWorkflow(t.app, slug);
    assert.equal(v1.version, 1);
    assert.equal(v1again.version, 1);
    assert.equal(v1again.versionId, v1.versionId);
  } finally {
    await t.teardown();
  }
});

test("versioning: a changed definition creates the next version and leaves v1 untouched", async () => {
  const t = await createTestApp();
  try {
    const slug = await createDemoWorkflow(t.app);
    const changed = demoDefinition();
    (changed as { name: string }).name = "Renamed demo workflow";
    const v2 = await validateWorkflow(t.app, slug, changed);
    assert.equal(v2.version, 2);

    const versions = await t.app.db.kysely
      .selectFrom("workflow_versions")
      .selectAll()
      .orderBy("version")
      .execute();
    assert.equal(versions.length, 2);
    assert.equal((versions[0]?.definition as { name?: string }).name, "Local service business leads (fake demo)");
    assert.notEqual(versions[0]?.checksum, versions[1]?.checksum);
  } finally {
    await t.teardown();
  }
});

test("versioning: duplicate slug is rejected; unknown providers/templates fail validation", async () => {
  const t = await createTestApp();
  try {
    await createDemoWorkflow(t.app);
    await assert.rejects(() => createWorkflowFromDefinition(t.app, demoDefinition()), /already exists/);

    const badProvider = demoDefinition();
    (badProvider as { id: string }).id = "bad-provider";
    (badProvider as { steps: { id: string; provider?: string }[] }).steps[0]!.provider = "real-apollo";
    await assert.rejects(() => createWorkflowFromDefinition(t.app, badProvider), /Unknown source provider/);

    const badTemplate = demoDefinition();
    (badTemplate as { id: string }).id = "bad-template";
    const steps = (badTemplate as { steps: { id: string; type: string; template?: string }[] }).steps;
    steps.find((s) => s.type === "score")!.template = "enterprise-scoring";
    await assert.rejects(() => createWorkflowFromDefinition(t.app, badTemplate), /Unknown score template/);
  } finally {
    await t.teardown();
  }
});
