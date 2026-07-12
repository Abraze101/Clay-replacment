#!/usr/bin/env node
import { readFile } from "node:fs/promises";

import { Command } from "commander";

import type { AppContainer } from "../app/container.js";
import { createContainer } from "../app/container.js";
import { PgBossRunWorker } from "../jobs/pg-boss-worker.js";
import {
  createWorkflowFromDefinition,
  listWorkflowSummaries,
  showWorkflow,
  validateWorkflow,
} from "../app/workflow-service.js";
import {
  cancelRun,
  exportRunCsv,
  previewRun,
  resumeRun,
  retryRun,
  reviewRun,
  runResults,
  runStatus,
  startRun,
  type RunOptions,
} from "../app/run-service.js";
import type { Profile } from "../engine/workflow-schema/steps.js";
import { migrate, migrationStatus } from "../storage/migrate.js";
import type { ReviewStatus } from "../storage/database-types.js";
import { AppError } from "../shared/errors.js";
import type { CommandResult } from "./output.js";
import { emitError, emitResult } from "./output.js";

const program = new Command();
program.name("leads").description("Headless, workflow-driven lead-generation engine (Milestone 0: fake providers only)");
program.option("--json", "emit the machine-readable {ok, data, summary, warnings} envelope");

function useJson(): boolean {
  return Boolean(program.opts<{ json?: boolean }>().json);
}

function run(fn: (app: AppContainer) => Promise<CommandResult>): () => Promise<void> {
  return async () => {
    let app: AppContainer | undefined;
    let failed = false;
    try {
      app = await createContainer();
      const result = await fn(app);
      emitResult(useJson(), result);
    } catch (err) {
      failed = true;
      emitError(useJson(), err);
    } finally {
      await app?.close().catch(() => undefined);
      // PGlite's Emscripten teardown resets process.exitCode during close();
      // re-assert the failure code afterwards or errors would exit 0.
      if (failed) process.exitCode = 1;
    }
  };
}

async function readJsonFile(filePath: string): Promise<unknown> {
  const text = await readFile(filePath, "utf8").catch(() => {
    throw new AppError("VALIDATION_FAILED", `Cannot read file: ${filePath}`, { filePath });
  });
  try {
    return JSON.parse(text);
  } catch {
    throw new AppError("VALIDATION_FAILED", `File is not valid JSON: ${filePath}`, { filePath });
  }
}

function parseInlineJson(raw: string | undefined, flag: string): Record<string, unknown> | undefined {
  if (raw === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    return parsed as Record<string, unknown>;
  } catch {
    throw new AppError("VALIDATION_FAILED", `${flag} must be a JSON object string.`, { flag });
  }
}

interface RunFlagOptions {
  inputs?: string;
  profile?: string;
  overrides?: string;
  cap?: string;
  budget?: string;
}

async function toRunOptions(flags: RunFlagOptions): Promise<RunOptions> {
  return {
    inputs: flags.inputs ? ((await readJsonFile(flags.inputs)) as Record<string, unknown>) : undefined,
    profile: flags.profile as Profile | undefined,
    overrides: parseInlineJson(flags.overrides, "--overrides"),
    cap: flags.cap !== undefined ? Number(flags.cap) : undefined,
    budget: flags.budget !== undefined ? Number(flags.budget) : undefined,
  };
}

// --------------------------------------------------------------------------- db
const db = program.command("db").description("database administration");

db.command("migrate")
  .description("apply pending migrations")
  .action(
    run(async (app) => {
      const result = await migrate(app.db);
      return {
        data: result,
        summary:
          result.applied.length > 0
            ? `Applied migrations: ${result.applied.join(", ")}`
            : `No pending migrations (${result.alreadyApplied.length} already applied).`,
      };
    }),
  );

db.command("status")
  .description("show migration status")
  .action(
    run(async (app) => {
      const status = await migrationStatus(app.db);
      return {
        data: status,
        summary: `${status.filter((s) => s.appliedAt).length}/${status.length} migrations applied.`,
        humanLines: status.map((s) => `${s.id}  ${s.appliedAt ?? "PENDING"}`),
      };
    }),
  );

// --------------------------------------------------------------------------- worker
program
  .command("worker")
  .description("run a resident pg-boss worker that hosts delayed rate-limit resumes (use a PostgreSQL DATABASE_URL to run alongside the web/MCP servers; a pglite:// directory allows only one live process)")
  .action(async () => {
    const app = await createContainer({ jobDriver: "pgboss" });
    try {
      await migrate(app.db);
      if (app.worker instanceof PgBossRunWorker) await app.worker.start();
    } catch (err) {
      await app.close().catch(() => undefined);
      emitError(useJson(), err);
      process.exitCode = 1;
      return;
    }
    process.stdout.write("Lead-engine worker running (pg-boss). Press Ctrl+C to stop.\n");
    // pg-boss's polling/supervise timers keep the event loop alive; the process
    // stays up until a signal triggers a clean shutdown.
    const shutdown = (): void => {
      void app.close().catch(() => undefined).then(() => process.exit(0));
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });

// --------------------------------------------------------------------------- workflow
const workflow = program.command("workflow").description("workflow management");

workflow
  .command("create")
  .requiredOption("--file <path>", "workflow definition JSON file")
  .description("validate a definition file and create the workflow with immutable version 1")
  .action(async (opts: { file: string }) => {
    await run(async (app) => {
      const raw = await readJsonFile(opts.file);
      const created = await createWorkflowFromDefinition(app, raw);
      return {
        data: created,
        summary: `Workflow '${created.slug}' created at version ${created.version}.`,
      };
    })();
  });

workflow
  .command("validate <workflow>")
  .option("--file <path>", "new definition to validate (updates the draft)")
  .description("validate the stored draft (or a new file) and create the next immutable version")
  .action(async (workflowArg: string, opts: { file?: string }) => {
    await run(async (app) => {
      const raw = opts.file ? await readJsonFile(opts.file) : undefined;
      const validated = await validateWorkflow(app, workflowArg, raw);
      return {
        data: validated,
        summary: `Workflow '${validated.slug}' is valid at version ${validated.version} (checksum ${validated.checksum.slice(0, 12)}…).`,
      };
    })();
  });

workflow
  .command("list")
  .description("list active workflows")
  .action(
    run(async (app) => {
      const workflows = await listWorkflowSummaries(app);
      return {
        data: workflows,
        summary: `${workflows.length} workflow(s).`,
        humanLines: workflows.map((w) => `${w.slug}  v${w.latestVersion ?? "-"}  ${w.name}`),
      };
    }),
  );

workflow
  .command("show <workflow>")
  .description("show a workflow and its latest validated definition")
  .action(async (workflowArg: string) => {
    await run(async (app) => {
      const shown = await showWorkflow(app, workflowArg);
      return {
        data: shown,
        summary: `Workflow '${shown.summary.slug}' v${shown.summary.latestVersion ?? "-"} (${shown.summary.name}).`,
        humanLines: [JSON.stringify(shown.definition, null, 2)],
      };
    })();
  });

// --------------------------------------------------------------------------- run
const runCmd = program.command("run").description("run lifecycle");

const runFlagDefs = (c: Command): Command =>
  c
    .option("--inputs <path>", "JSON file of run inputs (merged over workflow defaults)")
    .option("--profile <profile>", "quick_list | call_ready | full")
    .option("--overrides <json>", "typed capability overrides as a JSON object string")
    .option("--cap <n>", "paid record cap (max 100)")
    .option("--budget <n>", "credit limit for paid steps");

runFlagDefs(runCmd.command("preview <workflow>"))
  .description("resolve the execution plan and costs, and issue a single-use approval token; spends nothing")
  .action(async (workflowArg: string, opts: RunFlagOptions) => {
    await run(async (app) => {
      const preview = await previewRun(app, workflowArg, await toRunOptions(opts));
      const plan = preview.plan;
      return {
        data: preview,
        warnings: plan.warnings,
        summary: `Plan resolved for '${workflowArg}' v${preview.workflowVersion} (${plan.profile}): ${plan.steps.filter((s) => s.willRun).length} steps, cap ${plan.paidRecordCap} paid records, estimated cost ${plan.estimatedCost}, budget ${plan.creditLimit}.`,
        humanLines: [
          ...plan.steps.map(
            (s) =>
              `  ${s.willRun ? "RUN " : "SKIP"} ${s.id} (${s.type}${s.provider ? `:${s.provider}` : ""})${s.paid ? ` paid @${s.costPerRecord}/record` : ""}${s.excludedBy ? ` [excluded by ${s.excludedBy}]` : ""}`,
          ),
          `Approval token (single-use, expires ${preview.approval.expiresAt}): ${preview.approval.token}`,
          `Approve with: leads run start ${workflowArg} --approval ${preview.approval.token}${opts.profile ? ` --profile ${opts.profile}` : ""}`,
        ],
      };
    })();
  });

runFlagDefs(runCmd.command("start <workflow>"))
  .requiredOption("--approval <token>", "single-use approval token from 'run preview'")
  .description("start a run; the engine rejects missing, expired, consumed, or scope-changed approvals")
  .action(async (workflowArg: string, opts: RunFlagOptions & { approval: string }) => {
    await run(async (app) => {
      const finalRun = await startRun(app, workflowArg, opts.approval, await toRunOptions(opts));
      const status = await runStatus(app, finalRun.id);
      return {
        data: status,
        summary: `Run ${finalRun.id} is ${finalRun.status} (${status.counts.items} items, ${status.creditsUsed}/${status.creditLimit} credits).`,
        humanLines:
          finalRun.status === "waiting_review"
            ? [`Review then continue: leads run review ${finalRun.id} --approve --all && leads run resume ${finalRun.id}`]
            : [],
      };
    })();
  });

runCmd
  .command("status <runId>")
  .description("durable run status and counts")
  .action(async (runId: string) => {
    await run(async (app) => {
      const status = await runStatus(app, runId);
      return {
        data: status,
        summary: `Run ${runId}: ${status.status}${status.pauseReason ? ` (${status.pauseReason})` : ""} — ${status.counts.completed}/${status.counts.items} completed, ${status.counts.failed} failed, ${status.counts.skipped} skipped, ${status.counts.stepsNeedingReview} needing review, credits ${status.creditsUsed}/${status.creditLimit}.`,
        humanLines: Object.entries(status.stepProgress).map(([step, marker]) => `  ${step}: ${marker}`),
      };
    })();
  });

runCmd
  .command("results <runId>")
  .option("--review-status <s>", "unreviewed | approved | rejected | regenerate")
  .option("--status <s>", "pending | in_progress | completed | failed | skipped")
  .description("list run items with lead summaries")
  .action(async (runId: string, opts: { reviewStatus?: string; status?: string }) => {
    await run(async (app) => {
      const results = await runResults(app, runId, {
        reviewStatus: opts.reviewStatus as ReviewStatus | undefined,
        status: opts.status as "pending" | "in_progress" | "completed" | "failed" | "skipped" | undefined,
      });
      return {
        data: results,
        summary: `${results.length} item(s).`,
        humanLines: results.map(
          (r) =>
            `  #${r.position} ${r.business?.name ?? r.sourceKey} [${r.status}${r.skipReason ? `:${r.skipReason}` : ""}] review=${r.reviewStatus}${r.score !== null ? ` score=${r.score}` : ""}${r.owner ? ` owner=${r.owner.name}` : ""} (${r.runItemId})`,
        ),
      };
    })();
  });

runCmd
  .command("review <runId>")
  .option("--approve", "approve items")
  .option("--reject", "reject items")
  .option("--item <runItemId...>", "specific run item ids")
  .option("--all", "apply to all non-skipped items (explicit)")
  .description("apply review decisions to run items")
  .action(async (runId: string, opts: { approve?: boolean; reject?: boolean; item?: string[]; all?: boolean }) => {
    await run(async (app) => {
      if (Boolean(opts.approve) === Boolean(opts.reject)) {
        throw new AppError("VALIDATION_FAILED", "Pass exactly one of --approve or --reject.", {});
      }
      const result = await reviewRun(app, runId, {
        reviewStatus: opts.approve ? "approved" : "rejected",
        itemIds: opts.all ? "all" : (opts.item ?? []),
      });
      return { data: result, summary: `${result.updated} item(s) ${opts.approve ? "approved" : "rejected"}.` };
    })();
  });

runCmd
  .command("resume <runId>")
  .option("--approval <token>", "fresh approval token (required when changing budget/cap)")
  .option("--budget <n>", "new credit limit (requires --approval)")
  .option("--cap <n>", "new paid record cap (requires --approval)")
  .description("resume after review, a pause, or a crash; budget changes need a fresh approval")
  .action(async (runId: string, opts: { approval?: string; budget?: string; cap?: string }) => {
    await run(async (app) => {
      const finalRun = await resumeRun(app, runId, {
        approval: opts.approval,
        budget: opts.budget !== undefined ? Number(opts.budget) : undefined,
        cap: opts.cap !== undefined ? Number(opts.cap) : undefined,
      });
      return { data: await runStatus(app, finalRun.id), summary: `Run ${runId} is ${finalRun.status}.` };
    })();
  });

runCmd
  .command("retry <runId>")
  .description("requeue failed items/steps (needs_review is never auto-retried) and continue")
  .action(async (runId: string) => {
    await run(async (app) => {
      const finalRun = await retryRun(app, runId);
      return { data: await runStatus(app, finalRun.id), summary: `Run ${runId} is ${finalRun.status}.` };
    })();
  });

runCmd
  .command("cancel <runId>")
  .description("request cancellation")
  .action(async (runId: string) => {
    await run(async (app) => {
      const finalRun = await cancelRun(app, runId);
      return { data: { status: finalRun.status }, summary: `Run ${runId} is ${finalRun.status}.` };
    })();
  });

// --------------------------------------------------------------------------- lead
const lead = program.command("lead").description("lead-level operations");

lead
  .command("review <runId> <runItemId>")
  .option("--approve", "approve the lead in this run")
  .option("--reject", "reject the lead in this run")
  .description("review one lead result within a run")
  .action(async (runId: string, runItemId: string, opts: { approve?: boolean; reject?: boolean }) => {
    await run(async (app) => {
      if (Boolean(opts.approve) === Boolean(opts.reject)) {
        throw new AppError("VALIDATION_FAILED", "Pass exactly one of --approve or --reject.", {});
      }
      const result = await reviewRun(app, runId, {
        reviewStatus: opts.approve ? "approved" : "rejected",
        itemIds: [runItemId],
      });
      return { data: result, summary: `${result.updated} item ${opts.approve ? "approved" : "rejected"}.` };
    })();
  });

// --------------------------------------------------------------------------- export
const exportCmd = program.command("export").description("exports");

exportCmd
  .command("csv <runId>")
  .option("--force", "rewrite even when the dataset checksum is unchanged")
  .description("export approved, completed leads to CSV (review gate enforced)")
  .action(async (runId: string, opts: { force?: boolean }) => {
    await run(async (app) => {
      const result = await exportRunCsv(app, runId, Boolean(opts.force));
      return {
        data: result,
        summary: result.noop
          ? `Export unchanged (dataset checksum match): ${result.filePath}`
          : `Exported ${result.rowCount} row(s) to ${result.filePath}.`,
      };
    })();
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  emitError(true, err);
});
