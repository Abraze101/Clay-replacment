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

- Stable model-neutral MCP tool contract for workflow create/validate/list and run preview/start/status/results/cancel/export over the same application services.
- Stdio transport for local Claude Code, Codex, and OpenAI Agents SDK use.
- Auth-ready Streamable HTTP transport over the same tool handlers.
- `approval_tokens` registry backing the engine-level approval gate.
- Migration `0002` (`users`, `approval_tokens`, `created_by` attribution on workflows and workflow versions).
- Strict input/output schemas, tool annotations, server instructions, and paginated structured results.
- Claude Code, Codex, and OpenAI Agents SDK fixture compatibility with handoff prompts for the fake local, executive, and imported-list workflows.
- pg-boss adoption decision per the M0 spike ADR, behind the `JobQueue` interface, when real background execution starts.

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

The UI framework choice is an ADR decided at M2 planning. No migration is required.

Acceptance:

- A nontechnical tester can define, preview, approve, run, monitor, review, and export a fake run without the CLI or an external LLM harness.
- No business logic is duplicated in the UI; it calls the same application services.

## Milestone 3: local-business workflow

Deliver:

- Official local-business provider adapter (Google Places API (New)); no scraping.
- Category/geography and service-area search inputs.
- Storage/attribution handling, including restricted-snapshot expiry.
- Website-domain normalization and bounded website research through a lean policy-controlled fetcher.
- Local-business dedupe.
- Quick List workflow exporting available business details and public main phones without person-level enrichment.
- Cost previews computed from actual field masks.
- Shared retry/pause policy and 429 scheduling (first live rate-limited provider; see sequencing note).
- Migration `0003` (place IDs, timezone, snapshot expiry, resume/next-attempt scheduling).

Acceptance:

- A roofer campaign returns useful business leads through the CLI, MCP, and UI even when no owner or person record exists.
- Geographic/query coverage limits are visible; one provider is never presented as complete market coverage.
- Provider storage/attribution policy tests and documentation exist.
- Preview costs derive from the actual requested field masks.
- Rate-limit responses pause and reschedule instead of failing the run.
- CI remains fixture-only.

## Milestone 4: professional and imported workflows

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
