import type { Env } from "../config/env.js";
import { FakeEnrichProvider } from "./fake/enrich.js";
import { FakeResearchProvider } from "./fake/research.js";
import { FakeSourceProvider } from "./fake/source.js";
import { FirecrawlClient } from "./firecrawl/client.js";
import { FirecrawlWebsiteResearch } from "./firecrawl/website-research.js";
import { SerpApiClient } from "./serpapi/client.js";
import { SerpApiLocalBusinessSource } from "./serpapi/maps-source.js";
import type { ProviderRegistry } from "./types.js";
import { emptyRegistry } from "./types.js";

/**
 * The always-present fake providers (demo workflows + offline tests) and an
 * intentionally EMPTY model-provider map. Real adapters are layered on top by
 * buildRegistry when their credentials are configured.
 */
export function buildFakeRegistry(options: { enrichLedgerPath: string }): ProviderRegistry {
  const registry = emptyRegistry();
  const source = new FakeSourceProvider();
  const enrich = new FakeEnrichProvider(options.enrichLedgerPath);
  const research = new FakeResearchProvider();
  registry.sources.set(source.name, source);
  registry.enrichers.set(enrich.name, enrich);
  registry.researchers.set(research.name, research);
  return registry;
}

/**
 * The runtime registry: the fakes plus any configured live adapters. The live
 * local-business source (SerpAPI, ADR-024) registers under the provider-neutral
 * name "local-business" only when SERPAPI_API_KEY is set; a workflow that
 * references it without the key fails validation with a clear message.
 */
export function buildRegistry(env: Env, options: { enrichLedgerPath: string }): ProviderRegistry {
  const registry = buildFakeRegistry(options);

  if (env.SERPAPI_API_KEY) {
    const client = new SerpApiClient({
      apiKey: env.SERPAPI_API_KEY,
      baseUrl: env.SERPAPI_BASE_URL,
      maxRequestsPerMinute: env.SERPAPI_MAX_RPM,
      defaultRetryAfterSeconds: env.SERPAPI_DEFAULT_RETRY_AFTER_SECONDS,
      costPerSearch: 1,
    });
    const localBusiness = new SerpApiLocalBusinessSource({
      client,
      creditsPerRequest: 1,
      maxPagesPerQuery: env.SERPAPI_MAX_PAGES_PER_QUERY,
    });
    registry.sources.set(localBusiness.name, localBusiness);
  }

  // Website research via Firecrawl is doubly opt-in (flag + key) so the default
  // stays free/offline and the module remains deferrable (ADR-027).
  if (env.WEBSITE_RESEARCH_PROVIDER === "firecrawl" && env.FIRECRAWL_API_KEY) {
    const client = new FirecrawlClient({
      apiKey: env.FIRECRAWL_API_KEY,
      baseUrl: env.FIRECRAWL_BASE_URL,
      maxRequestsPerMinute: 8,
      costPerScrape: 1,
    });
    const research = new FirecrawlWebsiteResearch({ client, costPerRecord: 1 });
    registry.researchers.set(research.name, research);
  }

  return registry;
}

export interface ProviderCatalogEntry {
  name: string;
  kind: "source" | "enrich" | "research" | "model";
  paid: boolean;
  connected: boolean;
  requiresEnv: string;
  description: string;
}

/**
 * The full catalog of live providers the product can use, INCLUDING those not
 * yet configured (connected:false) — the registry alone cannot surface a
 * missing provider because unconfigured adapters are never registered.
 */
export function knownProviders(env: Env): ProviderCatalogEntry[] {
  return [
    {
      name: "local-business",
      kind: "source",
      paid: true,
      connected: Boolean(env.SERPAPI_API_KEY),
      requiresEnv: "SERPAPI_API_KEY",
      description:
        "Local-business discovery via SerpAPI's Google Maps engine (name, category, address, phone, website, rating, reviews).",
    },
    {
      name: "website-research",
      kind: "research",
      paid: true,
      connected: env.WEBSITE_RESEARCH_PROVIDER === "firecrawl" && Boolean(env.FIRECRAWL_API_KEY),
      requiresEnv: "FIRECRAWL_API_KEY",
      description: "Bounded business-website research via Firecrawl.",
    },
  ];
}
