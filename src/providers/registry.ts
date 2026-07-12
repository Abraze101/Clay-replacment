import { FakeEnrichProvider } from "./fake/enrich.js";
import { FakeResearchProvider } from "./fake/research.js";
import { FakeSourceProvider } from "./fake/source.js";
import type { ProviderRegistry } from "./types.js";
import { emptyRegistry } from "./types.js";

/**
 * Milestone 0 registry: fake providers only, and an intentionally EMPTY
 * model-provider map (a generate step must skip, not fail, without one).
 * Real adapters register here at their milestones (Places M3, Apollo M4,
 * validation/verification + MiniMax/OpenAI/Anthropic M5).
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
