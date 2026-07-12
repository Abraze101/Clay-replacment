import assert from "node:assert/strict";
import { test } from "node:test";

import type { AppContainer } from "../src/app/container.js";
import { previewRun } from "../src/app/run-service.js";
import { createWorkflowFromDefinition } from "../src/app/workflow-service.js";
import { createTestApp } from "./helpers/setup.js";
import { ScriptedPagedSource } from "./helpers/scripted-source.js";

/** Quick-list workflow whose only paid step is a paged paid source. */
async function createSourceOnlyWorkflow(app: AppContainer, locations: string[]): Promise<string> {
  const created = await createWorkflowFromDefinition(app, {
    id: "local-business-quicklist",
    version: 1,
    name: "Local business quick list",
    inputs: { businessType: "roofing contractor", locations, limit: 50, enrichmentProfile: "quick_list" },
    steps: [
      { id: "discover", type: "source", provider: "local-business" },
      { id: "normalize", type: "normalize" },
      { id: "dedupe", type: "dedupe" },
      { id: "review", type: "review_gate" },
      { id: "export", type: "export", format: "csv" },
    ],
  });
  return created.slug;
}

test("plan: a paged paid source is priced by request count and never consumes the record cap", async () => {
  const t = await createTestApp();
  try {
    t.app.providers.sources.set("local-business", new ScriptedPagedSource({ name: "local-business", creditsPerRequest: 5 }));
    const slug = await createSourceOnlyWorkflow(t.app, ["Austin, TX", "Dallas, TX"]);

    const { plan } = await previewRun(t.app, slug, {});

    assert.equal(plan.estimatedPaidActions.length, 1);
    const action = plan.estimatedPaidActions[0];
    assert.equal(action?.stepId, "discover");
    assert.equal(action?.count, 2, "one search request per location");
    assert.equal(action?.costPerRecord, 5);
    assert.equal(plan.estimatedCost, 10);
    assert.equal(plan.creditLimit, 10);
    // A paid source books against its own ledger; the per-record cap stays 0.
    assert.equal(plan.paidRecordCap, 0);
    // The quick_list contact/enrichment caution must NOT fire for a paid source.
    assert.ok(!plan.warnings.some((w) => w.includes("no paid contact/enrichment")));
    // The informational source estimate IS surfaced.
    assert.ok(plan.warnings.some((w) => w.includes("paid search request")));
  } finally {
    await t.teardown();
  }
});

test("plan: source cost and plan hash track the locations input", async () => {
  const t = await createTestApp();
  try {
    t.app.providers.sources.set("local-business", new ScriptedPagedSource({ name: "local-business", creditsPerRequest: 5 }));
    const slug = await createSourceOnlyWorkflow(t.app, ["Austin, TX"]);

    const one = await previewRun(t.app, slug, { inputs: { locations: ["Austin, TX"] } });
    const three = await previewRun(t.app, slug, {
      inputs: { locations: ["Austin, TX", "Dallas, TX", "Houston, TX"] },
    });

    assert.equal(one.plan.estimatedCost, 5);
    assert.equal(three.plan.estimatedCost, 15);
    assert.notEqual(one.plan.planHash, three.plan.planHash, "more locations → more searches → different plan hash");
  } finally {
    await t.teardown();
  }
});
