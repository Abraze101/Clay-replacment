# Video interpretation

Source: [Angus Sewell's Instagram reel](https://www.instagram.com/angus.sewell/reel/DW9A4UKEY8K/), posted April 10, 2026.

## What Angus is arguing

Angus groups several valuable AI products into the same basic pattern:

1. A chat or task interface.
2. A data/connectors layer.
3. A general-purpose model.
4. A vertical output for a specific job.

His claim is that, when the product's advantage is mainly orchestration rather than proprietary data or a uniquely trained model, a capable operator can reproduce much of the useful workflow with Claude, connectors, and a focused system prompt.

For the Clay example, the video shows:

- Source/enrichment systems such as Apollo, LinkedIn, Clearbit, ZoomInfo, Crunchbase, and HubSpot.
- A simplified do-it-yourself version using Apollo MCP, a LinkedIn reference, and HubSpot CRM.
- A sales-enrichment prompt that finds role, company signals, and news, then produces a short cold-email draft.

Angus also gives the important caveat: Clay can still be valuable because it saves the user from configuring and maintaining many data sources.

## What the video leaves out

The diagram is a useful product thesis, not a production architecture. A real replacement must add:

- Durable list and row state.
- Identity resolution and deduplication.
- Field-level source provenance and freshness.
- Credit estimates, budgets, and actual usage.
- Rate-limit handling, batching, retries, and idempotency.
- Asynchronous webhook handling for waterfall enrichment.
- Prompt versioning and structured AI outputs.
- Human approval before paid enrichment, CRM writes, or outbound actions.
- Data retention, deletion, security, and audit controls.
- A legal integration path for LinkedIn data.

## Product conclusion

We are not recreating every Clay integration. We are building a reusable lead-generation loop:

`market/source workflow -> preview -> approved enrichment -> dedupe -> score -> research -> draft -> review -> export`

Apollo will be the primary professional-contact provider, while a separate local-business workflow covers small service businesses that may not appear in Apollo. Claude, Codex, or another compatible LLM harness can be the reasoning and conversational layer; PostgreSQL is the durable system of record, and HubSpot is an optional destination.
