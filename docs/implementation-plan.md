# Implementation plan

Revised 2026-07-10 per `docs/proposals/consolidated-revision-directive.md`.

The headless workflow engine ships first. Claude Code, Codex, and OpenAI-compatible harnesses are the first beta interfaces, not the permanent required interface; a minimal usability UI is expected at Milestone 2, before any live provider. One codebase serves both DIY/free self-hosted operation and the later managed service. Vendor and library decisions are recorded as ADR entries with revisit triggers in `docs/decisions.md`.

Sequencing note: the shared retry/pause policy and 429 scheduling (p-retry/p-queue, `runs.resume_at`, `run_item_steps.next_attempt_at`) land at Milestone 3 rather than with the Apollo adapter, because under this ordering the local-business provider is the first live rate-limited provider. This is the one deliberate deviation from the directive's milestone lists.

## Milestone 0: engine skeleton

Deliver:

- Strict TypeScript project with a pinned dependency/version policy.
- Linting, type checking, tests, build, and environment validation.
- PGlite embedded local storage and migration `0001_init` (12 domain tables plus `schema_migrations`; see `docs/proposals/database-schema.md`).
- Typed workflow schemas with the approved 10-step allowlist (`source`, `normalize`, `dedupe`, `enrich`, `filter`, `research`, `score`, `generate`, `review_gate`, `export`) and a typed deterministic operator allowlist for filter/score conditions.
- Workflow versioning, immutable once used by a run.
- Fake provider adapters and a persistent fake run with explicit run state transitions.
- Preview and approval scope bound to a plan hash; scope changes invalidate the approval.
- Application services in `src/app/` that the CLI calls and later interfaces reuse.
- CLI commands for workflow validation, run preview, run start, status, results, and CSV export.
- Bounded pg-boss/PGlite compatibility spike (filesystem persistence, start/stop/restart, job recovery, retry/backoff, duplicate-claim prevention, cancellation, modest concurrency, transaction interaction), pg-boss as a devDependency only.

No MCP, no UI, no live providers, no model providers.

Acceptance:

- A fake workflow persists and completes without an LLM conversation remaining open.
- Restart/resume works.
- Unknown or invalid steps fail validation.
- Approval-scope changes are detected and rejected.
- Duplicate paid-style fake steps do not repeat.
- CSV export is safe.
- Lint, type check, tests, and build pass.
- No credentials or network calls are required.
- The pg-boss spike outcome is recorded as an ADR in `docs/decisions.md`.

## Milestone 1: harness adapter

Deliver:

- Stable model-neutral MCP tool contract (12 tools: workflow create/validate/list and run preview/start/status/results/cancel/resume/retry/export plus lead review) over the same application services. `run_resume`/`run_retry` were added at M1 planning so a harness can pass the review gate, lift a credit-cap pause, and requeue failures — the MCP contract must not be weaker than the CLI.
- Stdio transport for local Claude Code, Codex, and OpenAI Agents SDK use.
- Auth-ready Streamable HTTP transport over the same tool handlers.
- `approval_tokens` registry backing the engine-level approval gate.
- Migration `0002` (`users`, `approval_tokens`, `created_by` attribution on workflows and workflow versions).
- Strict input/output schemas, tool annotations, server instructions, and paginated structured results.
- Claude Code, Codex, and OpenAI Agents SDK fixture compatibility driving the fake local workflow (executive and imported-list example workflows arrive with their source adapters at M4).
- pg-boss stays a devDependency behind the `JobQueue` interface; the driver activates at M3 with the first live rate-limited provider (M1 keeps the in-process driver — see ADR-002).

Acceptance:

- Claude Code, Codex, and an OpenAI Agents SDK test client operate the same fake workflow without direct database or credential access.
- Closing, reopening, or switching the harness does not lose run state.
- Shared contract tests prove stdio and Streamable HTTP expose equivalent tools and schemas.
- Mutating calls fail without an engine approval token.
- No live model or lead-provider credentials are required.

## Milestone 2: minimal usability UI

Deliver a bare-bones web UI over the fake provider and the existing application services:

- Home: new lead list, recent runs, saved templates, provider status.
- Guided request: plain English in, editable interpreted fields out.
- Preset selection with understandable capability toggles.
- Preview and approval screen.
- Progress view with cancel.
- Results table with review updates and export.

The UI framework is decided: ADR-017 — Vite + React SPA over a thin JSON API on the shared application services. No migration is required.

Acceptance:

- A nontechnical tester can define, preview, approve, run, monitor, review, and export a fake run without the CLI or an external LLM harness.
- No business logic is duplicated in the UI; it calls the same application services.

## Milestone 3: local-business workflow

Amended at M3 planning (2026-07-12, ADR-024): discovery moved from Firecrawl-scraped Maps pages to SerpAPI's Google Maps API after research showed Firecrawl cannot reliably scrape Maps; Firecrawl was retained for the optional website-research step (ADR-027), replacing the previously planned lean self-built fetcher.

Deliver:

- SerpAPI Google Maps discovery adapter per ADR-024, behind the provider-neutral `local-business` source name and the `PagedPaidSource` interface (one billed search per location/page, durable `run_source_requests` ledger).
- Category/geography search inputs (named locations = page 1 per location; `@lat,lon,zoom` locations paginate; deep geocoded pagination is a recorded follow-up).
- Source provenance handling: per-record source URL, retrieved-at, and a stable per-listing identifier (`place_id`/CID; Places-specific storage/attribution and snapshot-expiry rules apply only if an official-API adapter is added).
- Website-domain normalization and bounded website research through a flag-gated Firecrawl ResearchProvider (ADR-027; deferrable by env).
- Local-business dedupe (plus `leads.place_id` and single-zone-state `leads.timezone`).
- Quick List workflow exporting available business details, rating/review metadata, provenance URL, and public main phones without person-level enrichment.
- Cost previews computed from the planned search-request volume (SerpAPI bills per successful search; the plan resolver prices the source step by request count).
- Shared retry/pause policy and 429 scheduling (first live rate-limited provider; see sequencing note): `RateLimitError` → pause `rate_limited` + `runs.resume_at`/`run_item_steps.next_attempt_at` → delayed auto-resume without a fresh approval.
- pg-boss activation behind `JobQueue` (ADR-002): `PgBossRunWorker`, delayed `startAfter` resumes, startup sweep, `leads worker` CLI command.
- Migration `0003` (leads.place_id/timezone, lead_sources.snapshot_expires_at, runs.resume_at, run_item_steps.next_attempt_at, run_source_requests ledger).

Acceptance:

- A roofer campaign returns useful business leads through the CLI, MCP, and UI even when no owner or person record exists.
- Geographic/query coverage limits are visible; one provider is never presented as complete market coverage.
- Every sourced lead carries provenance (source URL, retrieved-at, listing identifier).
- Preview costs derive from the provider's actual pricing for the planned request volume.
- Rate-limit responses pause and reschedule instead of failing the run.
- CI remains fixture-only (no live SerpAPI/Firecrawl credentials or spend).

## Milestone 4: professional and imported workflows

Amended at M4 planning (2026-07-12, ADR-028): Apollo people search is the `mixed_people/api_search` endpoint (master API key; credit-free; returns no contact data — the legacy `/search` endpoint 403s on Basic plans), so the professional template places its review gate BEFORE paid enrichment; Apollo phone reveal requires an async webhook and is deferred to M5. The imported-list channel is inline CSV text (CLI `--import-csv` file, UI paste, MCP `importCsv`) or typed `inputs.importRows`, parsed once and bound into the approval hash; web multipart upload is deferred to M6.

Deliver:

- Apollo search/enrichment adapter as a typed adapter over official REST APIs, not MCP.
- Professional/executive workflow template.
- Imported CSV/domain/URL workflow.
- Provider retry policy hardening and the per-adapter paid-call idempotency contract (idempotency keys, provider request IDs, ambiguous outcomes to `needs_review`).
- Preview versus bounded paid-enrichment approval.
- Identity-conflict handling (`identity_conflicts`): flag, do not force-merge.
- Migration `0004` (Apollo identifiers, LinkedIn URL, verified email, identity conflicts).

Acceptance:

- A CEO/founder campaign can preview, enrich a small approved set, and export through the CLI, MCP, and UI.
- Replaying a completed paid item does not repeat enrichment; a possibly-completed unconfirmable paid call is marked `needs_review`, never auto-retried.
- Conflicting identifiers are flagged instead of merged.
- An imported list normalizes, dedupes, and enriches without a live-provider requirement in CI.
- CI remains fixture-only.

## Milestone 5: contact enrichment and MiniMax assistance

Amended at M5 planning (2026-07-13, ADR-029/ADR-030): no inbound webhook receiver before the M6 HTTPS deployment — async discovery vendors run submit-then-poll, and Apollo's webhook-only phone reveal stays deferred; ALL SIX benchmark candidate adapters were built up front (owner decision), so the ADR-008/009/010 vendor selections are env changes after the owner-run benchmarks (`docs/benchmarks-m5.md`).

Deliver:

- Quick List, Call-Ready, and Full Enrichment presets compiled into visible typed steps with per-capability overrides.
- Provider-neutral phone-discovery, phone-validation, email-discovery, and email-verification interfaces.
- Multiple contact points with source metadata and append-only validation history.
- Transparent call-readiness policy (`ready`, `uncertain`, `invalid`, `suppressed`, `unchecked`), cold-calling export fields, and entity-specific suppression handling.
- Discovery-provider benchmark (BetterContact, FullEnrich, LeadMagic as candidates, not selections) and phone/email validation vendor benchmarks, each recorded as an ADR.
- MiniMax adapter behind the shared model-provider interface alongside OpenAI and Anthropic adapters.
- Grounded fit rationale, cold-call notes, and personalized opener with evidence validation and regeneration.
- Selected-lead continuation from Quick List into deeper enrichment.
- Migration `0005` (suppressions, call-readiness fields).

Acceptance:

- A Quick List lead can continue to Call-Ready without repeating completed source work, and only for approved rows.
- A public business main line, a direct number, and a mobile number remain distinguishable.
- Phone/email results state exactly what was checked and when; format-only checks are never labeled fully verified.
- Invalid and suppressed numbers are excluded from the default call-ready CSV; unchecked records are visibly `unchecked`, never treated as cleared.
- Changing enrichment depth, overrides, record cap, or budget requires a new preview and approval.
- Model outputs are runtime-schema-validated and grounded in persisted evidence; the workflow still sources, dedupes, scores, and exports with generation disabled.
- Provider calls are fixture-tested; CI spends no credits.

## Milestone 6: personal VPS and managed beta

Deliver:

- Real PostgreSQL deployment with identical PG16-compatible DDL.
- Background-worker and application-service deployment.
- Guided hosted UI and authenticated Streamable HTTP MCP.
- Minimal authentication and workspace isolation.
- Encrypted per-workspace provider credentials (migration `0006` sketch: `provider_credentials`, auth columns).
- Backups with verification, health monitoring, and usage/cost accounting.
- Operational usage/spending limits and managed-beta onboarding.

Billing remains a separate later decision; no subscription billing, Stripe, invoices, or plan enforcement.

Acceptance:

- The hosted deployment runs the same codebase and workflow format as DIY local operation, which still works with PGlite and fake providers.
- Credentials are encrypted per workspace, write-only after entry, and never exposed to models, logs, exports, or support diagnostics.
- A second workspace cannot read another workspace's leads, runs, or credentials.
- Backups restore verifiably; the personal VPS can serve as the managed beta environment.
- No enterprise SSO, RBAC, or billing infrastructure is added.

## Later, only after real usage

- HubSpot export.
- Additional local/business data providers.
- More website/news research.
- Client-facing reports.
- Managed-credit resale (requires unit-economics and provider-terms review).
- Billing or broader SaaS packaging.
- Documented Docker Compose, one-command installer, and packaged desktop distribution.

## Recommended first handoff

Ask Claude or Codex to plan Milestone 0 as a headless vertical slice, including the pg-boss/PGlite compatibility spike. The first demo runs a fake workflow from the CLI, persists it, resumes it, shows results, and exports CSV. Milestone 1 makes that fake vertical slice usable from Claude Code, Codex, and an OpenAI Agents SDK client; Milestone 2 puts the minimal UI over the same services — all before any live data provider is added. Do not start with live providers, model-provider integration, or a visual workflow editor.
