# Clay Replacement

This workspace contains the product and engineering plan for a workflow-driven lead-generation engine inspired by Angus Sewell's "build it yourself" Clay example.

Status: Milestone 0 (engine skeleton) is implemented and validated (2026-07-11) — headless engine, fake providers, persistent runs, plan-hash approvals, CLI, CSV export, 21 offline test files, and the passing pg-boss/PGlite spike. Documentation follows the [consolidated revision directive](docs/proposals/consolidated-revision-directive.md) (2026-07-10). Next: Milestone 1, the harness adapter (MCP over stdio + Streamable HTTP).

## What we are building

The MVP will let the user, a marketing agency owner, or a small agency team:

1. Describe a market, offer, and desired lead output in natural language.
2. Create or select a reusable sourcing/enrichment workflow.
3. Discover local businesses, professional contacts, or imported companies.
4. Choose Quick List, Call-Ready, or Full Enrichment and preview any paid actions.
5. Optionally find and validate phones/emails, deduplicate, score, and personalize leads.
6. Review results through Claude, Codex, an OpenAI agent, the CLI, or the minimal web UI expected at Milestone 2.
7. Export approved records to CSV and, later, HubSpot.

The MVP will not scrape LinkedIn or Google Maps, automate LinkedIn actions, send email, enroll prospects in sequences, or target consumers using sensitive health data.

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

The headless workflow engine is foundational. Claude Code, Codex, and OpenAI-compatible harnesses are the first beta interfaces—not the required permanent interface—and call the engine through MCP tools. A minimal web UI is expected at Milestone 2 so a nontechnical user can run the whole loop without the CLI or an external LLM harness; it calls the same application services as the CLI and MCP server. The engine—not the chat, model, or UI—owns workflows, run state, dedupe, budgets, retries, and exports. The same product must cover local owner-operated businesses, regional SMBs, and larger companies across the United States by choosing different source and enrichment workflows.
