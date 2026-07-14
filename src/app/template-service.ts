import { readFile } from "node:fs/promises";

import { AppError } from "../shared/errors.js";
import { parseWorkflowDefinition } from "../engine/workflow-schema/workflow.js";

/**
 * The server-side workflow-template allowlist, shared by the web UI, MCP, and
 * CLI so every interface seeds the same files and no caller ever sends a file
 * path. Templates are stateless JSON in examples/; adding one here surfaces
 * it everywhere.
 */
const WORKFLOW_TEMPLATES: Record<string, URL> = {
  "local-service-demo": new URL("../../examples/local-service-demo.workflow.json", import.meta.url),
  "local-business-quick-list": new URL("../../examples/local-business-quick-list.workflow.json", import.meta.url),
  "professional-executive": new URL("../../examples/professional-executive.workflow.json", import.meta.url),
  "imported-list-enrich": new URL("../../examples/imported-list-enrich.workflow.json", import.meta.url),
  "call-ready-continuation": new URL("../../examples/call-ready-continuation.workflow.json", import.meta.url),
};

export interface TemplateSummary {
  id: string;
  name: string;
  description: string;
  sourceProvider: string;
}

export function templateIds(): string[] {
  return Object.keys(WORKFLOW_TEMPLATES);
}

export async function loadTemplateDefinition(id: string): Promise<unknown> {
  const url = WORKFLOW_TEMPLATES[id];
  if (!url) throw new AppError("NOT_FOUND", `Unknown template '${id}'.`, { known: templateIds() });
  return JSON.parse(await readFile(url, "utf8")) as unknown;
}

export async function listTemplates(): Promise<TemplateSummary[]> {
  const out: TemplateSummary[] = [];
  for (const id of templateIds()) {
    const definition = parseWorkflowDefinition(await loadTemplateDefinition(id));
    const source = definition.steps.find((s) => s.type === "source");
    out.push({
      id,
      name: definition.name,
      description: definition.description ?? "",
      sourceProvider: source && "provider" in source ? source.provider : "unknown",
    });
  }
  return out;
}
