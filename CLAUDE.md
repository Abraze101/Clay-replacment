# Project instructions

Read these documents before planning or changing code:

- @docs/video-interpretation.md
- @docs/product-requirements.md
- @docs/architecture.md
- @docs/ui-scope.md
- @docs/workflows.md
- @docs/harness-compatibility.md
- @docs/implementation-plan.md
- @docs/closed-loop-product-testing.md
- @docs/decisions.md
- @docs/claude-handoff.md

## Operating rules

- Work on one implementation milestone at a time. Do not silently expand scope.
- Start a new milestone in plan mode. Name assumptions, touched files, migrations, tests, and external calls before implementation.
- The product is for marketing agency owners and very small agency teams. Keep a minimal agency/workspace ownership boundary, but do not add billing, complex RBAC, enterprise SSO, or large-team administration in the MVP.
- Lead generation is the primary job. The reusable workflow builder is a core feature, but it must use typed, bounded step configurations rather than arbitrary code execution.
- The headless engine is foundational. Claude Code, Codex, and OpenAI-compatible harnesses are the first beta interfaces, not the permanent required interface. A minimal web UI is expected at Milestone 2 and must call the same application services.
- One codebase serves DIY/free self-hosted operation and a managed service. Do not add subscription billing, Stripe, invoices, or plan enforcement in early milestones.
- Keep the business logic portable across Claude Code, Codex, and OpenAI Agents SDK/Responses clients. Do not embed model- or harness-specific assumptions in workflows, providers, storage, or job execution.
- Support distinct sourcing workflows for local businesses, professional/executive contacts, and imported lists.
- Keep the UI intentionally small. Do not recreate Clay's spreadsheet formula engine or connector marketplace.
- Use Apollo MCP only for interactive prototyping and read-oriented verification. Production workflows must use typed provider adapters over official REST APIs.
- Never scrape LinkedIn or automate LinkedIn browsing, messaging, invitations, or profile collection. Treat a LinkedIn URL as an identifier supplied by Apollo, an import, or an approved LinkedIn integration.
- For health-company campaigns, target businesses and professional contacts unless the user explicitly establishes a compliant consumer/patient acquisition scope. Never infer or use private health conditions.
- Never make a credit-consuming enrichment call without a visible preview and explicit user approval.
- Treat Quick List, Call-Ready, and Full Enrichment as presets that expand into visible typed workflow steps. The user must be able to override phone discovery, phone validation, email discovery, and email validation separately.
- Never label a phone as "verified" when only its syntax or format was checked. Preserve separate results for format validity, line type, carrier/network line status, and person/business identity match when available.
- Cold-calling exports must distinguish a public business main line from a person's direct or mobile number and must include suppression/compliance-review status. Unknown status is not the same as cleared.
- Never send an email, create a sequence, enroll a contact, or write to a CRM without explicit user approval at action time.
- Never put API keys, OAuth tokens, prospect data, or other secrets in the repository, logs, fixtures, prompts, screenshots, CSV exports, or MCP responses.
- Persist enough source metadata, provider request IDs, credit usage, and prompt versions to explain a lead and safely retry a run. Do not build a general-purpose audit/event platform.
- All background steps must be retryable and idempotent. A retry must not double-spend credits or duplicate CRM records.
- If a paid provider call's outcome cannot be confirmed, mark it for manual review. Never auto-retry a possibly-completed paid call.
- Prefer deterministic rules for qualification. An LLM may explain or supplement a score, but it may not be the sole source of a qualification decision.
- The embedded AI assistant (MiniMax or any configured model) may not bypass cost preview or approval, write directly to the database, mark contact information verified, be the sole qualification authority, or own run state.
- AI-generated claims and outreach must be grounded only in persisted source fields; uncertain claims must be omitted or flagged.
- Record vendor/library decisions as ADR entries in `docs/decisions.md` with revisit triggers. The LinkedIn-scraping prohibition is a permanent guardrail. The former Google Maps/SERP-scraping prohibition was lifted by owner decision on 2026-07-12 (ADR-023, amended by ADR-024): SerpAPI's Google Maps API is the interim local-business discovery path, and Firecrawl covers optional business-website research. The owner accepts the platform ToS risk (both vendors scrape Google/websites inside their own boundaries); keep the source adapter provider-neutral so a different Maps API or an official-API adapter can replace SerpAPI without engine changes, and revisit before any managed/beta launch.

## Engineering conventions

- TypeScript in strict mode. Avoid `any` and validate all external payloads at runtime.
- PostgreSQL is the system of record, with PGlite for local embedded development. Prefer ordinary typed columns plus small JSONB metadata fields over a generalized entity/attribute system. Schema changes require migrations.
- Store multiple phone/email contact points with their role, source, confidence, validation method, result, and checked-at time; do not overwrite one provider's result with another.
- Keep provider-specific code behind interfaces in `src/providers` and keep workflow definitions provider-neutral where practical.
- Keep MiniMax, OpenAI, and Anthropic generation behind one shared model-provider interface. A workflow must still run when its optional `generate` step is disabled.
- Workflow steps must come from the approved allowlist: `source`, `normalize`, `dedupe`, `enrich`, `filter`, `research`, `score`, `generate`, `review_gate`, and `export`.
- Keep orchestration in explicit workflow steps, not in request handlers or UI components.
- Store sanitized provider fixtures for tests; CI must not use live SerpAPI, Firecrawl, Apollo, MiniMax, OpenAI, Anthropic, LinkedIn, or HubSpot credentials.
- Unit-test identity resolution, scoring, state transitions, cost gates, and idempotency.
- Add contract tests for provider adapters and an end-to-end test for the happy-path vertical slice.
- Update these documents when an accepted implementation decision changes the architecture.

## Completion report

For every milestone, report:

1. What changed.
2. Why it changed.
3. Validation performed and exact results.
4. Migrations or configuration required.
5. Remaining risks and the next milestone.
