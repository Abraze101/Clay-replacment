import assert from "node:assert/strict";
import { test } from "node:test";

import { createApprovedRun, previewRun } from "../src/app/run-service.js";
import { executeRun } from "../src/engine/runner/runner.js";
import type { EnrichProvider, EnrichRequest } from "../src/providers/types.js";
import type { FakeEnrichProvider } from "../src/providers/fake/enrich.js";
import { listRunItems, listSteps } from "../src/storage/repositories/run-repo.js";
import { num } from "../src/storage/database-types.js";
import { createDemoWorkflow, createTestApp } from "./helpers/setup.js";

/**
 * The M4 crash-replay guard: a provider WITHOUT request-key idempotency
 * (Apollo declares idempotentReplay:false) must never re-execute an
 * interrupted paid attempt — the replay books an ambiguous outcome into
 * needs_review with the provisional cost, and a human reconciles it. This is
 * the enrich twin of the executeResearch guard.
 */
test("crash replay with a non-idempotent enricher books needs_review and never re-calls the provider", async () => {
  const t = await createTestApp();
  try {
    const slug = await createDemoWorkflow(t.app);
    const preview = await previewRun(t.app, slug, { profile: "full" });
    const run = await createApprovedRun(t.app, slug, preview.approval.token, { profile: "full" });

    let crashed = false;
    const crashingDeps = {
      ...t.app.runnerDeps,
      hooks: {
        beforeFinalize: (info: { stepId: string }) => {
          if (info.stepId === "owner" && !crashed) {
            crashed = true;
            throw new Error("SIMULATED_CRASH");
          }
        },
      },
    };
    await assert.rejects(() => executeRun(crashingDeps, run.id), /SIMULATED_CRASH/);

    const items = await listRunItems(t.app.db.kysely, run.id);
    const crashedItem = items.find((i) => i.source_key === "fx-001");
    assert.ok(crashedItem);
    const crashedKey = (await listSteps(t.app.db.kysely, crashedItem.id)).find((s) => s.step_id === "owner")?.request_key;
    assert.ok(crashedKey);

    // Swap in a NON-idempotent wrapper (Apollo-shaped) before resuming: it
    // serves fresh requests by delegating to the fake ledger but records every
    // key so the test can prove the interrupted one never reaches it.
    const real = t.app.providers.enrichers.get("fake-apollo") as FakeEnrichProvider;
    const calledKeys: string[] = [];
    const nonIdempotent: EnrichProvider = {
      name: "fake-apollo",
      costPerRecord: 1,
      idempotentReplay: false,
      enrich: (req: EnrichRequest) => {
        calledKeys.push(req.requestKey);
        return real.enrich(req);
      },
    };
    t.app.providers.enrichers.set("fake-apollo", nonIdempotent);

    const resumed = await executeRun(t.app.runnerDeps, run.id);
    assert.equal(resumed.status, "waiting_review", "one ambiguous item never blocks the rest of the run");

    const stepsAfter = await listSteps(t.app.db.kysely, crashedItem.id);
    const owner = stepsAfter.find((s) => s.step_id === "owner");
    assert.equal(owner?.status, "needs_review", "possibly-completed paid call is parked, not retried");
    assert.equal(num(owner?.cost_units ?? 0), 1, "the possible charge is booked provisionally");
    assert.equal(owner?.attempt_costs.at(-1)?.classification, "ambiguous");
    assert.ok(!calledKeys.includes(crashedKey), "the interrupted request key was never re-executed");
    assert.ok(calledKeys.length > 0, "other items still enriched normally");
  } finally {
    await t.teardown();
  }
});
