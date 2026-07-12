# Clay Replacement

This workspace contains the product and engineering plan for a workflow-driven lead-generation engine inspired by Angus Sewell's "build it yourself" Clay example.

Status: Milestones 0–3 are implemented and validated — headless engine with fake providers (M0), the model-neutral MCP harness adapter (M1), the minimal web UI (M2), and the live local-business workflow (M3, 2026-07-12): SerpAPI Google Maps discovery, Quick List export, durable rate-limit pause/auto-resume scheduling, pg-boss activation, and optional Firecrawl website research. Documentation follows the [consolidated revision directive](docs/proposals/consolidated-revision-directive.md) (2026-07-10). Next: Milestone 4, the professional (Apollo) and imported-list workflows.

## What we are building

The MVP will let the user, a marketing agency owner, or a small agency team:

1. Describe a market, offer, and desired lead output in natural language.
2. Create or select a reusable sourcing/enrichment workflow.
3. Discover local businesses, professional contacts, or imported companies.
4. Choose Quick List, Call-Ready, or Full Enrichment and preview any paid actions.
5. Optionally find and validate phones/emails, deduplicate, score, and personalize leads.
6. Review results through Claude, Codex, an OpenAI agent, the CLI, or the minimal web UI expected at Milestone 2.
7. Export approved records to CSV and, later, HubSpot.

The MVP will not scrape LinkedIn, automate LinkedIn actions, send email, enroll prospects in sequences, or target consumers using sensitive health data. Local-business discovery reads Google Maps results through SerpAPI's API, an owner-accepted interim decision with recorded ToS risk (ADR-023/ADR-024 in [docs/decisions.md](docs/decisions.md)).

## Delivery models

One codebase serves two delivery models. A capable user can run the application locally or self-host it for free, connect personal provider and model accounts, and pay providers directly. Agency owners can instead pay for a managed service: hosting, setup, onboarding, provider connection, templates, backups, monitoring, and ongoing support. Variable data costs stay separate in both models, and subscription billing, Stripe, invoices, and plan enforcement are excluded from the early milestones.

## Start here

- [Video interpretation](docs/video-interpretation.md)
- [Product requirements](docs/product-requirements.md)
- [System architecture](docs/architecture.md)
- [UI scope](docs/ui-scope.md)
- [Execution workflows](docs/workflows.md)
- [LLM harness compatibility](docs/harness-compatibility.md)
- [Implementation plan](docs/implementation-plan.md)
- [Decision registry (ADRs)](docs/decisions.md)
- [Claude handoff](docs/claude-handoff.md)
- [Local Claude Code workflow](docs/local-claude-workflow.md)

Claude Code will automatically read [CLAUDE.md](CLAUDE.md), while Codex will read [AGENTS.md](AGENTS.md). The project-scoped [.mcp.json](.mcp.json) declares Apollo's official remote MCP server for operator prototyping; it contains no credentials.

## Core architecture decision

The headless workflow engine is foundational. Claude Code, Codex, and OpenAI-compatible harnesses are the first beta interfaces—not the required permanent interface—and call the engine through MCP tools. The Milestone 2 web UI lets a nontechnical user run the whole loop without the CLI or an external LLM harness; it calls the same application services as the CLI and MCP server. The engine—not the chat, model, or UI—owns workflows, run state, dedupe, budgets, retries, and exports. The same product must cover local owner-operated businesses, regional SMBs, and larger companies across the United States by choosing different source and enrichment workflows.

## Web UI (Milestone 2)

```sh
pnpm install
pnpm ui:build   # build the SPA into web/dist
pnpm web        # serve UI + JSON API on http://localhost:3000 (applies migrations)
```

Development mode runs two terminals: `pnpm web` (API on `WEB_PORT`, default 3000) and `pnpm ui:dev` (Vite dev server proxying `/api`). Everything runs on the fake providers with embedded PGlite — no credentials, no credit spend. PGlite is single-connection: do not run `pnpm web` and `pnpm mcp:http` against the same `pglite://` directory at once; use a PostgreSQL `DATABASE_URL` to run both. Stack decision: ADR-017 in [docs/decisions.md](docs/decisions.md).

## Live providers (Milestone 3)

Without keys, everything above still works on the fake providers. To source real local businesses, set (in the server environment or a local `.env` — never in the browser):

- `SERPAPI_API_KEY` — connects the `local-business` source (SerpAPI Google Maps; free tier 250 searches/month; one search per location per run, shown in the preview before approval). Optional knobs: `SERPAPI_MAX_RPM` (default 10), `SERPAPI_MAX_PAGES_PER_QUERY` (default 6, used only for `@lat,lon,zoom` locations), `SERPAPI_DEFAULT_RETRY_AFTER_SECONDS` (default 60).
- `FIRECRAWL_API_KEY` + `WEBSITE_RESEARCH_PROVIDER=firecrawl` — optionally connects `website-research` (1 credit per researched site; call-ready/full profiles only).

Seed the M3 template from the UI (Provider setup shows connection status and free connection tests) or run the example: `examples/local-business-quick-list.workflow.json`. Provider rate limits pause the run with a resume time; short pauses self-heal in one-shot CLI runs, and `pnpm worker` (or `pnpm web`) hosts a resident pg-boss worker for delayed resumes (`JOB_DRIVER=pgboss|inprocess` overrides the per-entry default). `pnpm probe:serpapi -- --locations "Austin, TX" --yes` runs the gated dev probe that validates live field mapping and writes sanitized fixture drafts; it refuses to run without the key and the explicit `--yes`, and never runs in CI.
