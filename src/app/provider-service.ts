import { AppError } from "../shared/errors.js";
import { FirecrawlClient } from "../providers/firecrawl/client.js";
import { SerpApiClient } from "../providers/serpapi/client.js";
import type { AppContainer } from "./container.js";

export interface ProviderStatusEntry {
  name: string;
  kind: "source" | "enrich" | "research" | "model";
  connected: boolean;
  paid: boolean;
  costPerRecord?: number;
  /** Env var that connects the provider (DIY mode keeps keys in env; never in the browser). */
  requiresEnv?: string;
  description?: string;
  /** True when a zero-cost connection test is available via provider_test. */
  testable?: boolean;
}

/**
 * Registry + catalog merge: registered providers are `connected`; catalog
 * entries that are not registered surface as `connected:false` (the registry
 * alone cannot show a missing provider because unconfigured adapters are never
 * registered).
 */
export function listProviderStatus(app: AppContainer): ProviderStatusEntry[] {
  const catalogByName = new Map(app.providerCatalog.map((c) => [c.name, c]));
  const entries: ProviderStatusEntry[] = [];
  const seen = new Set<string>();

  const push = (name: string, kind: ProviderStatusEntry["kind"], paid: boolean, costPerRecord?: number): void => {
    const catalog = catalogByName.get(name);
    entries.push({
      name,
      kind,
      connected: true,
      paid: catalog?.paid ?? paid,
      ...(costPerRecord !== undefined && costPerRecord > 0 ? { costPerRecord } : {}),
      ...(catalog ? { requiresEnv: catalog.requiresEnv, description: catalog.description, testable: true } : {}),
    });
    seen.add(name);
  };

  for (const p of app.providers.sources.values()) push(p.name, "source", false);
  for (const p of app.providers.enrichers.values()) push(p.name, "enrich", p.costPerRecord > 0, p.costPerRecord);
  for (const p of app.providers.researchers.values()) push(p.name, "research", (p.costPerRecord ?? 0) > 0, p.costPerRecord);
  for (const p of app.providers.models.values()) push(p.name, "model", true);

  for (const catalog of app.providerCatalog) {
    if (seen.has(catalog.name)) continue;
    entries.push({
      name: catalog.name,
      kind: catalog.kind,
      connected: false,
      paid: catalog.paid,
      requiresEnv: catalog.requiresEnv,
      description: catalog.description,
      testable: false,
    });
  }
  return entries;
}

export interface ProviderTestResult {
  name: string;
  ok: boolean;
  detail: string;
}

/**
 * Zero-cost connection test for a live provider (SerpAPI /account, Firecrawl
 * credit-usage). Spends no searches/credits; never returns the key.
 */
export async function testProviderConnection(app: AppContainer, name: string): Promise<ProviderTestResult> {
  if (name === "local-business") {
    if (!app.env.SERPAPI_API_KEY) {
      return { name, ok: false, detail: "Not configured: set SERPAPI_API_KEY in the server environment." };
    }
    const client = new SerpApiClient({
      apiKey: app.env.SERPAPI_API_KEY,
      baseUrl: app.env.SERPAPI_BASE_URL,
      maxRequestsPerMinute: app.env.SERPAPI_MAX_RPM,
    });
    const usage = await client.creditUsage();
    return {
      name,
      ok: true,
      detail:
        usage.totalSearchesLeft === null
          ? "Connected."
          : `Connected; ${usage.totalSearchesLeft} SerpAPI searches left this month.`,
    };
  }
  if (name === "website-research") {
    if (!app.env.FIRECRAWL_API_KEY) {
      return { name, ok: false, detail: "Not configured: set FIRECRAWL_API_KEY in the server environment." };
    }
    const client = new FirecrawlClient({
      apiKey: app.env.FIRECRAWL_API_KEY,
      baseUrl: app.env.FIRECRAWL_BASE_URL,
      maxRequestsPerMinute: 8,
    });
    const usage = await client.creditUsage();
    return {
      name,
      ok: true,
      detail:
        usage.remainingCredits === null ? "Connected." : `Connected; ${usage.remainingCredits} Firecrawl credits left.`,
    };
  }
  throw new AppError("NOT_FOUND", `Provider '${name}' has no connection test.`, { name });
}
