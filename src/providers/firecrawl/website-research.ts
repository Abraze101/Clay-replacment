import { AmbiguousOutcomeError, RateLimitError } from "../../shared/errors.js";
import type { ResearchOutcome, ResearchProvider } from "../types.js";
import type { FirecrawlClient, FirecrawlScrapeResult } from "./client.js";

/**
 * Bounded business-website research via Firecrawl (ADR-027), behind the
 * provider-neutral name "website-research". Deterministic summary/facts (title,
 * meta description, a trimmed content excerpt — no LLM). A provider rate limit
 * propagates (the run pauses/reschedules); any site-level failure returns
 * `unavailable` so the run continues on source data (failure-table rule).
 *
 * Cleanly separable: registered only when WEBSITE_RESEARCH_PROVIDER=firecrawl,
 * so the owner can instead pick an ADR-013 lean fetcher or defer to M4 with no
 * engine change.
 */
export class FirecrawlWebsiteResearch implements ResearchProvider {
  readonly name = "website-research";
  readonly costPerRecord: number;
  private readonly client: FirecrawlClient;
  private readonly excerptChars: number;

  constructor(opts: { client: FirecrawlClient; costPerRecord?: number; excerptChars?: number }) {
    this.client = opts.client;
    this.costPerRecord = opts.costPerRecord ?? 1;
    this.excerptChars = opts.excerptChars ?? 500;
  }

  async research(input: { websiteUrl?: string | null; normalizedDomain?: string | null }): Promise<ResearchOutcome> {
    const url = input.websiteUrl ?? (input.normalizedDomain ? `https://${input.normalizedDomain}` : null);
    if (!url) return { kind: "unavailable", reason: "no_website" };

    try {
      const scraped = await this.client.scrape({ url });
      // A page the site served as an error (404/410/5xx) is not research
      // evidence, even though the scrape succeeded and was charged.
      if (scraped.statusCode !== null && scraped.statusCode >= 400) {
        return { kind: "unavailable", reason: `site_returned_${scraped.statusCode}` };
      }
      return {
        kind: "ok",
        summary: buildSummary(scraped, this.excerptChars),
        facts: buildFacts(scraped),
        providerRequestId: scraped.sourceUrl ?? url,
      };
    } catch (err) {
      // A rate limit pauses/reschedules the whole run. A possibly-completed,
      // possibly-BILLED scrape (timeout / unreadable 200) must propagate so the
      // runner books the provisional cost and parks the step in needs_review —
      // swallowing it would under-report spend past the credit gate. Everything
      // else (site blocked, 404, out-of-credits, network refusal) leaves
      // research incomplete and the run continues.
      if (err instanceof RateLimitError || err instanceof AmbiguousOutcomeError) throw err;
      return { kind: "unavailable", reason: err instanceof Error ? err.message.slice(0, 120) : "scrape_failed" };
    }
  }
}

function buildSummary(scraped: FirecrawlScrapeResult, excerptChars: number): string {
  const parts: string[] = [];
  if (scraped.title) parts.push(scraped.title);
  if (scraped.description) parts.push(scraped.description);
  const excerpt = (scraped.markdown ?? "").replace(/\s+/g, " ").trim().slice(0, excerptChars);
  if (excerpt) parts.push(excerpt);
  return parts.join(" — ") || "No readable content.";
}

function buildFacts(scraped: FirecrawlScrapeResult): Record<string, string> {
  const facts: Record<string, string> = {};
  if (scraped.title) facts["title"] = scraped.title;
  if (scraped.description) facts["description"] = scraped.description;
  if (scraped.sourceUrl) facts["sourceUrl"] = scraped.sourceUrl;
  return facts;
}
