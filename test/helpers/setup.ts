import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { AppContainer } from "../../src/app/container.js";
import { createContainer } from "../../src/app/container.js";
import { createWorkflowFromDefinition } from "../../src/app/workflow-service.js";
import { previewRun, startRun, type RunOptions } from "../../src/app/run-service.js";
import { migrate } from "../../src/storage/migrate.js";

/**
 * Offline test harness: in-memory PGlite, temp export dir, temp fake-enrich
 * ledger. No credentials, no network. Callers MUST await teardown().
 */
export interface TestApp {
  app: AppContainer;
  tempDir: string;
  ledgerPath: string;
  exportDir: string;
  teardown(): Promise<void>;
}

export async function createTestApp(): Promise<TestApp> {
  const tempDir = mkdtempSync(path.join(tmpdir(), "lead-engine-test-"));
  const ledgerPath = path.join(tempDir, "fake-enrich-ledger.json");
  const exportDir = path.join(tempDir, "exports");
  const app = await createContainer({
    DATABASE_URL: "pglite://memory",
    EXPORT_DIR: exportDir,
    FAKE_ENRICH_LEDGER_PATH: ledgerPath,
    LEASE_TTL_SECONDS: 5,
    MAX_STEP_ATTEMPTS: 3,
  });
  await migrate(app.db);
  return {
    app,
    tempDir,
    ledgerPath,
    exportDir,
    teardown: async () => {
      await app.close();
      rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

export const DEMO_WORKFLOW_PATH = path.resolve("examples/local-service-demo.workflow.json");

export function demoDefinition(): Record<string, unknown> {
  return JSON.parse(readFileSync(DEMO_WORKFLOW_PATH, "utf8")) as Record<string, unknown>;
}

export async function createDemoWorkflow(app: AppContainer): Promise<string> {
  const created = await createWorkflowFromDefinition(app, demoDefinition());
  return created.slug;
}

/** preview → approve-with-the-real-hash → start; the canonical happy path. */
export async function previewAndStart(app: AppContainer, slug: string, options: RunOptions = {}) {
  const preview = await previewRun(app, slug, options);
  const run = await startRun(app, slug, preview.plan.planHash, options);
  return { preview, run };
}
