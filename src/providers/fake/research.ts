import type { ResearchOutcome, ResearchProvider } from "../types.js";
import { FIXTURE_BUSINESSES } from "./fixtures.js";

/**
 * Bounded website-research fake: free, offline, deterministic. Produces a
 * short business summary for reachable fixture sites and an `unavailable`
 * outcome for the ghost-site fixture (research incomplete; run continues).
 */
export class FakeResearchProvider implements ResearchProvider {
  readonly name = "fake-website";

  research(input: { websiteUrl?: string | null; normalizedDomain?: string | null }): Promise<ResearchOutcome> {
    if (!input.websiteUrl && !input.normalizedDomain) {
      return Promise.resolve({ kind: "unavailable", reason: "no_website" });
    }
    const fixture = FIXTURE_BUSINESSES.find(
      (f) => f.website && input.normalizedDomain && f.website.toLowerCase().includes(input.normalizedDomain),
    );
    if (fixture?.researchUnavailable) {
      return Promise.resolve({ kind: "unavailable", reason: "site_unreachable" });
    }
    const name = fixture?.name ?? input.normalizedDomain ?? "unknown";
    return Promise.resolve({
      kind: "ok",
      summary: `${name} is a ${fixture?.category ?? "local"} business serving ${fixture?.locality ?? "its area"}.`,
      facts: {
        services: fixture?.category ?? "unknown",
        serviceArea: fixture?.locality ?? "unknown",
      },
      providerRequestId: `fake-website-${input.normalizedDomain ?? "none"}`,
    });
  }
}
