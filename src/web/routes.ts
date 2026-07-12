import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";

import type { AppContainer } from "../app/container.js";
import { interpretRequest } from "../app/request-interpreter.js";
import {
  cancelRun,
  createApprovedRun,
  exportRunCsv,
  listRunSummaries,
  prepareResume,
  prepareRetry,
  previewRun,
  reviewRun,
  runResults,
  runStatus,
} from "../app/run-service.js";
import { createWorkflowFromDefinition, listWorkflowSummaries, showWorkflow } from "../app/workflow-service.js";
import { AppError, isAppError } from "../shared/errors.js";
import { decodeCursor, encodeCursor } from "../shared/pagination.js";
import type { ProviderStatusInfo, WebExportResult, WorkflowCreateResponse } from "./contracts.js";
import {
  createWorkflowBodySchema,
  exportBodySchema,
  interpretBodySchema,
  resultsQuerySchema,
  resumeBodySchema,
  reviewBodySchema,
  runOptionsBodySchema,
  runsQuerySchema,
  startBodySchema,
} from "./contracts.js";
import { HttpError, parseBody, readJsonBody, sendError, sendJson } from "./http-util.js";

/**
 * The web API: thin 1:1 wrappers over the shared application services — the
 * same code the CLI and MCP tools call. No business logic lives here; the
 * engine's approval gate is untouched (start/resume consume tokens inside the
 * services, and approval errors surface synchronously before any execution).
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Server-side template allowlist; the browser never sends workflow file paths. */
const WORKFLOW_TEMPLATES: Record<string, URL> = {
  "local-service-demo": new URL("../../examples/local-service-demo.workflow.json", import.meta.url),
};

export async function handleApi(
  app: AppContainer,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const requestId = randomUUID();
  try {
    await route(app, req, res, url, requestId);
  } catch (err) {
    sendError(res, err, requestId);
  }
}

function ok(
  res: ServerResponse,
  requestId: string,
  data: unknown,
  opts: { status?: number; warnings?: string[] } = {},
): void {
  sendJson(res, opts.status ?? 200, { ok: true, data, warnings: opts.warnings ?? [], requestId });
}

/** Fire-and-forget execution so run routes return 202 and the UI polls status. */
function kickRun(app: AppContainer, runId: string): void {
  void app.worker.runToBoundary(runId).catch((err: unknown) => {
    process.stderr.write(
      `[web] background execution of run ${runId} failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  });
}

function requireRunId(segment: string | undefined): string {
  if (segment === undefined || !UUID_RE.test(segment)) {
    throw new AppError("VALIDATION_FAILED", "Run id must be a UUID.", {});
  }
  return segment;
}

function queryObject(url: URL): Record<string, string> {
  return Object.fromEntries(url.searchParams);
}

async function route(
  app: AppContainer,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  requestId: string,
): Promise<void> {
  const method = req.method ?? "GET";
  if (method !== "GET" && method !== "POST") {
    throw new HttpError(405, "METHOD_NOT_ALLOWED", "Only GET and POST are supported.");
  }
  // ["api", ...rest]
  const seg = url.pathname.split("/").filter((s) => s.length > 0).slice(1).map(decodeURIComponent);

  if (method === "GET" && seg.length === 1 && seg[0] === "health") {
    ok(res, requestId, { status: "ok" });
    return;
  }

  if (method === "GET" && seg.length === 1 && seg[0] === "providers") {
    ok(res, requestId, { providers: providerStatus(app) });
    return;
  }

  if (method === "POST" && seg.length === 1 && seg[0] === "interpret") {
    const body = parseBody(interpretBodySchema, await readJsonBody(req));
    ok(res, requestId, interpretRequest(body.text));
    return;
  }

  if (seg[0] === "workflows") {
    if (method === "GET" && seg.length === 1) {
      ok(res, requestId, { workflows: await listWorkflowSummaries(app) });
      return;
    }
    if (method === "POST" && seg.length === 1) {
      const body = parseBody(createWorkflowBodySchema, await readJsonBody(req));
      const [data, status] = await createWorkflow(app, body);
      ok(res, requestId, data, { status });
      return;
    }
    const idOrSlug = seg[1];
    if (idOrSlug === undefined) throw new AppError("NOT_FOUND", "Unknown API route.", {});
    if (method === "GET" && seg.length === 2) {
      ok(res, requestId, await showWorkflow(app, idOrSlug));
      return;
    }
    if (method === "POST" && seg.length === 3 && seg[2] === "preview") {
      const options = parseBody(runOptionsBodySchema, await readJsonBody(req));
      const preview = await previewRun(app, idOrSlug, options);
      ok(res, requestId, preview, { warnings: preview.plan.warnings });
      return;
    }
    if (method === "POST" && seg.length === 3 && seg[2] === "start") {
      const { approval, ...options } = parseBody(startBodySchema, await readJsonBody(req));
      const run = await createApprovedRun(app, idOrSlug, approval, options);
      kickRun(app, run.id);
      ok(res, requestId, { runId: run.id, status: run.status }, { status: 202 });
      return;
    }
  }

  if (seg[0] === "runs") {
    if (method === "GET" && seg.length === 1) {
      const query = parseBody(runsQuerySchema, queryObject(url));
      ok(res, requestId, { runs: await listRunSummaries(app, query.limit) });
      return;
    }
    const runId = requireRunId(seg[1]);
    if (method === "GET" && seg.length === 3 && seg[2] === "status") {
      ok(res, requestId, await runStatus(app, runId));
      return;
    }
    if (method === "GET" && seg.length === 3 && seg[2] === "results") {
      const query = parseBody(resultsQuerySchema, queryObject(url));
      const offset = decodeCursor(query.cursor);
      const all = await runResults(app, runId, { reviewStatus: query.reviewStatus, status: query.status });
      const items = all.slice(offset, offset + query.limit);
      const nextCursor = offset + query.limit < all.length ? encodeCursor(offset + query.limit) : null;
      ok(res, requestId, { items, page: { offset, limit: query.limit, total: all.length, nextCursor } });
      return;
    }
    if (method === "POST" && seg.length === 3 && seg[2] === "review") {
      const body = parseBody(reviewBodySchema, await readJsonBody(req));
      if (Boolean(body.all) === Boolean(body.itemIds && body.itemIds.length > 0)) {
        throw new AppError("VALIDATION_FAILED", "Pass exactly one of itemIds or all=true.", {});
      }
      const result = await reviewRun(app, runId, {
        reviewStatus: body.decision,
        itemIds: body.all ? "all" : (body.itemIds ?? []),
      });
      ok(res, requestId, result);
      return;
    }
    if (method === "POST" && seg.length === 3 && seg[2] === "resume") {
      const body = parseBody(resumeBodySchema, await readJsonBody(req));
      const run = await prepareResume(app, runId, body);
      kickRun(app, runId);
      ok(res, requestId, { runId, status: run.status }, { status: 202 });
      return;
    }
    if (method === "POST" && seg.length === 3 && seg[2] === "retry") {
      await readJsonBody(req); // drain; retry takes no options
      const { run, requeued } = await prepareRetry(app, runId);
      if (requeued > 0) kickRun(app, runId);
      ok(res, requestId, { runId, status: run.status, requeued }, { status: 202 });
      return;
    }
    if (method === "POST" && seg.length === 3 && seg[2] === "cancel") {
      const run = await cancelRun(app, runId);
      ok(res, requestId, { runId, status: run.status, cancelRequested: run.cancel_requested });
      return;
    }
    if (method === "POST" && seg.length === 3 && seg[2] === "export") {
      const body = parseBody(exportBodySchema, await readJsonBody(req));
      const result = await exportRunCsv(app, runId, Boolean(body.force));
      const data: WebExportResult = {
        exportId: result.exportId,
        fileName: path.basename(result.filePath),
        rowCount: result.rowCount,
        noop: result.noop,
        downloadUrl: `/api/runs/${runId}/export/download`,
      };
      ok(res, requestId, data);
      return;
    }
    if (method === "GET" && seg.length === 4 && seg[2] === "export" && seg[3] === "download") {
      // Idempotent: re-running the export enforces REVIEW_REQUIRED and returns
      // the service-owned file path (never derived from client input).
      const result = await exportRunCsv(app, runId, false);
      const content = await readFile(result.filePath);
      res.writeHead(200, {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="run-${runId}.csv"`,
      });
      res.end(content);
      return;
    }
  }

  throw new AppError("NOT_FOUND", "Unknown API route.", {});
}

async function createWorkflow(
  app: AppContainer,
  body: { definition: Record<string, unknown> } | { template: "local-service-demo" },
): Promise<[WorkflowCreateResponse, number]> {
  if ("definition" in body) {
    const created = await createWorkflowFromDefinition(app, body.definition);
    return [{ ...created, created: true }, 201];
  }
  const templateUrl = WORKFLOW_TEMPLATES[body.template];
  if (!templateUrl) throw new AppError("NOT_FOUND", `Unknown template '${body.template}'.`, {});
  const definition = JSON.parse(await readFile(templateUrl, "utf8")) as unknown;
  try {
    const created = await createWorkflowFromDefinition(app, definition);
    return [{ ...created, created: true }, 201];
  } catch (err) {
    if (!isAppError(err) || err.code !== "CONFLICT") throw err;
    // Seeding is idempotent: the template already exists, return it as-is.
    const existing = await showWorkflow(app, body.template);
    return [
      {
        workflowId: existing.summary.id,
        slug: existing.summary.slug,
        version: existing.summary.latestVersion ?? 1,
        versionId: existing.summary.versionId ?? "",
        checksum: existing.summary.checksum ?? "",
        created: false,
      },
      200,
    ];
  }
}

function providerStatus(app: AppContainer): ProviderStatusInfo[] {
  const infos: ProviderStatusInfo[] = [];
  for (const p of app.providers.sources.values()) {
    infos.push({ name: p.name, kind: "source", connected: true, paid: false });
  }
  for (const p of app.providers.enrichers.values()) {
    infos.push({ name: p.name, kind: "enrich", connected: true, paid: p.costPerRecord > 0, costPerRecord: p.costPerRecord });
  }
  for (const p of app.providers.researchers.values()) {
    infos.push({ name: p.name, kind: "research", connected: true, paid: false });
  }
  for (const p of app.providers.models.values()) {
    infos.push({ name: p.name, kind: "model", connected: true, paid: true });
  }
  return infos;
}
