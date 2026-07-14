# Decision registry (ADRs)

Status: created 2026-07-10 per `docs/proposals/consolidated-revision-directive.md`.

This file records vendor, library, and product-structure decisions as lightweight ADR entries. Every entry carries: **Decision / Date / Evidence / Reason / Status / Revisit trigger**. Statuses are `accepted`, `pending`, `deferred`, or `rejected`. No entry is "never relitigate": each has a concrete revisit trigger. Add or update an entry whenever a milestone makes or corrects a vendor/library decision.

**Guardrail note:** The LinkedIn-scraping prohibition is a permanent project guardrail defined in `CLAUDE.md`; it is not an ADR and carries no revisit trigger. The former Google Maps/SERP-scraping guardrail was lifted by owner decision on 2026-07-12 — see ADR-023, as amended by ADR-024 (SerpAPI performs the Maps scraping; Firecrawl handles website research).

Milestone references use the canonical sequence: M0 engine skeleton, M1 harness adapter, M2 minimal UI, M3 local-business workflow, M4 professional + imported workflows, M5 contact enrichment + MiniMax, M6 personal VPS + managed beta.

---

## ADR-001: Kysely over Drizzle for storage

- **Decision:** Use Kysely for repositories and migrations; do not mix in Drizzle or node-pg-migrate.
- **Date:** 2026-07-10
- **Evidence:** Verified bake-off in `docs/proposals/build-vs-adopt.md` §2; directive §13 confirms current Kysely ships official PGlite support (community-shim claim corrected).
- **Reason:** The schema is hand-authored SQL with partial unique indexes and CHECK constraints that diff-based codegen handles poorly; Kysely's Migrator runs the exact DDL and its typed SQL fits the plain-relational model.
- **Status:** accepted
- **Revisit trigger:** Schema work moves to codegen-heavy workflows.

## ADR-002: pg-boss for background jobs

- **Decision:** Select pg-boss for persistent jobs, behind a `JobQueue` interface; the engine never imports it directly. Adoption lands at M3 with the first live rate-limited provider (decided at M1 planning; M1 has no background-execution need beyond the in-process driver).
- **Date:** 2026-07-10
- **Evidence:** Bake-off vs graphile-worker/DBOS in `docs/proposals/build-vs-adopt.md` §2; directive §13 corrects the report — current pg-boss supports PGlite via `fromPglite`.
- **Reason:** Postgres-native retry/backoff, SKIP LOCKED delivery, and transactional enqueue without Redis. Because `fromPglite` support was new, M0 ran the mandated bounded compatibility spike. pg-boss job-delivery guarantees are distinct from third-party paid-call side effects (see directive §11).
- **Status:** accepted — the M0 spike (2026-07-11, pg-boss 12.25.1 on @electric-sql/pglite 0.5.4, schema v36) passed 8/8 scenarios: `fromPglite` bootstrap, filesystem persistence across restart, crashed-worker recovery via expiration + supervise, bounded retry to terminal failed, duplicate-claim prevention, cancellation, 20-job/4-worker exactly-once concurrency, and enqueue inside an application PGlite transaction (per-call `db` override; rollback discards the job, commit keeps it). Details: `spikes/pg-boss-pglite/README.md`. M0 and M1 ship the in-process claim-and-drain driver; the pg-boss driver activates behind `JobQueue` at M3, when the first live rate-limited provider creates a real background-execution need (user decision at M1 planning, 2026-07-11). Caveat: PGlite is single-connection — parallel-throughput expectations do not transfer from real Postgres.
  **Activated at M3 (2026-07-12):** `PgBossRunWorker` in `src/jobs/pg-boss-worker.ts` — one `run-execute` queue, payload `{runId}` keyed by `singletonKey: runId` (observability only: a standard-policy queue does not dedupe on singletonKey — the run lease is the sole single-driver guarantee, and a duplicate delivery exits via the tested `LEASE_HELD` no-op). A rate-limited pause reschedules itself with `startAfter = runs.resume_at`; delayed jobs persist across restart, and a startup sweep enqueues due pauses created while no resident worker was running. pg-boss shares the app's single connection (`fromPglite` on PGlite, `fromKysely` on Postgres) and moved from devDependencies to dependencies. Driver selection: `JOB_DRIVER` env or the container's `jobDriver` option — long-lived entries can run `pgboss`; one-shot CLI defaults to `inprocess`, which self-heals short rate-limit pauses inline (`RATE_LIMIT_INLINE_WAIT_MAX_SECONDS`, default 120) and otherwise leaves the pause for `leads worker`/`pnpm web`.
- **Revisit trigger:** A maintainership change, or production behavior contradicting the spike's recovery/transaction semantics.

## ADR-003: json-rules-engine

- **Decision:** Defer json-rules-engine.
- **Date:** 2026-07-10
- **Evidence:** Directive §13 overrides the earlier "adopt" entry in `docs/proposals/build-vs-adopt.md`.
- **Reason:** A general rules engine (with its pathResolver hardening burden) is premature; the typed operator allowlist (ADR-004) covers M0 filter/score needs.
- **Status:** deferred
- **Revisit trigger:** Workflow conditions outgrow the typed operator allowlist.

## ADR-004: Typed operator allowlist for filter/score

- **Decision:** Implement filter conditions and deterministic score templates as a small hand-typed operator allowlist: serializable JSON conditions over declared typed fields (`eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `in`, `not_in`, `contains`, `exists`), points-summing score templates, no eval, no dynamic paths.
- **Date:** 2026-07-10
- **Evidence:** Directive §13 ("Corrections to the research report" — json-rules-engine deferral); operator grammar specified in `docs/proposals/build-vs-adopt.md` §2 ("Deferred from adopt now") and `docs/proposals/milestone-0-plan.md` (workflow-schema file plan).
- **Reason:** Deterministic, auditable qualification with a minimal attack/complexity surface; replaces the deferred rules engine.
- **Status:** accepted — extended at M4 (2026-07-12): `RULE_FIELDS` gained six person/contact fields (`title`, `employer_name`, `has_linkedin`, `has_email`, `has_verified_email`, `has_direct_phone` — all deterministic from the persisted snapshot; `has_verified_email` stays false until a real M5 deliverability check writes it), and `ScoreRule.when` upgraded from a bare AND list to the SAME all/any RuleGroup the filter step already used (OR-matching over titles). Still the typed allowlist; the rules engine stays deferred.
- **Revisit trigger:** Same as ADR-003 — real workflow complexity justifying a general rules engine.

## ADR-005: PGlite locally, PostgreSQL hosted

- **Decision:** PGlite for local embedded development; real PostgreSQL for VPS/hosted operation (M6). Identical PG16-compatible DDL on both.
- **Date:** 2026-07-10
- **Evidence:** Directive §4 and §19.
- **Reason:** Credential-free, Docker-free local development with the same migrations and repositories; PostgreSQL remains the system of record.
- **Status:** accepted
- **Revisit trigger:** PGlite compatibility gaps break migrations, the pg-boss spike, or test parity with hosted PostgreSQL.

## ADR-006: Node 22 LTS pin

- **Decision:** Pin Node 22 LTS.
- **Date:** 2026-07-10
- **Evidence:** `docs/proposals/build-vs-adopt.md` — pg-boss requires Node ≥22.12; kysely and p-retry require ≥22.
- **Reason:** Lowest version satisfying all selected dependencies with LTS support.
- **Status:** accepted
- **Revisit trigger:** Node 24 LTS.

## ADR-007: MCP TypeScript SDK v1.x line

- **Decision:** Build the M1 MCP adapter on the current stable v1.x SDK line; confine SDK imports to the MCP adapter.
- **Date:** 2026-07-10
- **Evidence:** Directive §16.
- **Reason:** Projected v2 release dates are forecasts, not guarantees; confinement keeps a later migration cheap.
- **Status:** accepted — M1 (2026-07-11) pinned `@modelcontextprotocol/sdk` 1.29.0 exact; its `zod ^3.25 || ^4.0` peer range was verified against our zod 4.4.3 (native zod-4 raw shapes in the tool schemas, no `zod-to-json-schema`). SDK imports are confined to `src/mcp/` and the MCP test files. `@openai/agents` 0.13.2 is a devDependency used only by the credential-free harness fixture test.
- **Revisit trigger:** MCP SDK v2 is actually stable.

## ADR-008: Contact-discovery waterfall vendor

- **Decision:** Select one waterfall-as-API discovery provider after an M5 benchmark. Candidates: BetterContact, FullEnrich, LeadMagic. None is selected from marketing claims.
- **Date:** 2026-07-10
- **Evidence:** Directive §13; candidate research in `docs/proposals/build-vs-adopt.md` §3.
- **Reason:** Benchmark on match rate, accuracy, attribution, cost per usable result, latency, API reliability, webhook/reconciliation behavior, ambiguous-request handling, and provider/resale terms — plus the per-adapter idempotency questionnaire (directive §11).
- **Status:** pending (M5 benchmark) — all three adapters are BUILT and fixture-tested (ADR-030); protocol + harness: `docs/benchmarks-m5.md`, `pnpm bench:discovery`. Selection is an env change (ADR-031) once the owner records the decision here.
- **Revisit trigger:** Benchmark results; later, pricing or terms changes by the selected vendor.

## ADR-009: Twilio Lookup as first phone-validation candidate

- **Decision:** Twilio Lookup is the first phone-validation candidate; a second adapter (e.g. Telnyx) later proves the interface is genuinely provider-neutral.
- **Date:** 2026-07-10
- **Evidence:** Directive §13; `docs/proposals/build-vs-adopt.md` — Twilio's per-signal packages map one-to-one onto the `contact_point_checks` validation model.
- **Reason:** Clean per-signal mapping (format, line type, line status, identity match) supports the contact-data-honesty rule that no single `verified` boolean exists.
- **Status:** pending (M5 benchmark) — the Twilio Lookup v2 adapter is BUILT and fixture-tested (ADR-030) with per-signal mapping onto contact_point_checks; interface neutrality is proven by the shared capability contract suite (fake + Twilio). Protocol: `docs/benchmarks-m5.md`, `pnpm bench:phone`.
- **Revisit trigger:** M5 benchmark results, Twilio pricing/signal changes, or a candidate with better signal fidelity (a second live adapter, e.g. Telnyx, stays the future-proofing note).

## ADR-010: Email verifier

- **Decision:** Choose the email-verification provider after an M5 benchmark. Candidates: ZeroBounce, MillionVerifier.
- **Date:** 2026-07-10
- **Evidence:** Directive §13; `docs/proposals/build-vs-adopt.md` — ZeroBounce's taxonomy matches the `valid | invalid | catch_all | unknown | role_based | not_checked` vocabulary; MillionVerifier is the bulk cost tier.
- **Reason:** Verification status semantics must map losslessly onto the persisted email-status vocabulary; two verifiers would also prove interface neutrality.
- **Status:** pending (M5 benchmark) — BOTH adapters are BUILT and fixture-tested (ADR-030); each maps losslessly onto the persisted email-status vocabulary and models the unknown-refund policy (`costOnUnknown: 0`). Protocol: `docs/benchmarks-m5.md`, `pnpm bench:email`.
- **Revisit trigger:** Benchmark results; taxonomy or pricing changes.

## ADR-011: Foursquare OS Places

- **Decision:** Keep Foursquare OS Places optional; do not adopt now.
- **Date:** 2026-07-10
- **Evidence:** Directive §13.
- **Reason:** A large data/operations commitment (bulk dataset ingestion and refresh), not a trivial adapter; the official Google Places API covers M3.
- **Status:** deferred
- **Revisit trigger:** Google Places storage/attribution restrictions or coverage gaps make a persistable secondary local-business source worth the operational cost.

## ADR-012: MiniMax M3 as likely first embedded model provider

- **Decision:** MiniMax M3 is the likely first embedded model provider, landing at M5 behind the shared model-provider interface (MiniMax, OpenAI, Anthropic adapters).
- **Date:** 2026-07-10
- **Evidence:** Directive §15.
- **Reason:** Powers natural-language workflow drafts, preview explanations, summaries, fit rationale, cold-call notes, openers, and configuration assistance. Constraints are architectural: it may not call lead providers outside application services, bypass preview/approval, write to the database, mark contact info verified, be the sole qualification authority, own run state, or be required for deterministic sourcing/export. Nothing model-provider-specific is architectural.
- **Status:** pending (owner account decision) — the M5 adapter is BUILT behind the shared model-provider interface alongside OpenAI and Anthropic (ADR-032); generation runs fixture-only until the owner adopts a MiniMax (or other) key. Every constraint listed above is enforced in code.
- **Revisit trigger:** MiniMax pricing, quality, or availability changes; the owner's account decision.

## ADR-013: crawlee rejected for website research

- **Decision:** Reject crawlee; build a lean policy-controlled fetcher instead (standard HTTP client, robots-parser, cheerio, p-queue, response-size/timeout/redirect/content-type limits, per-domain rate limits).
- **Date:** 2026-07-10
- **Evidence:** Verification in `docs/proposals/build-vs-adopt.md` §5 — robots enforcement defaults off, fingerprint-spoofing defaults built for anti-bot evasion, file-based queue conflicts with Postgres-owned run state.
- **Reason:** Its defaults invert the project's compliance posture; no fingerprint spoofing, CAPTCHA evasion, or anti-bot circumvention is permitted.
- **Status:** rejected
- **Revisit trigger:** Only a change in the project's compliance posture — unlikely.

## ADR-014: Apollo as first professional-contact provider

- **Decision:** Apollo is the first professional/executive sourcing and enrichment provider (M4), via a typed adapter over official REST APIs. Apollo MCP is for interactive prototyping and read-oriented verification only. Initial path: personal/internal use and customer-owned accounts.
- **Date:** 2026-07-10
- **Evidence:** Directive §14.
- **Reason:** Best-fit coverage for company/employment-represented contacts. Apollo standard plans cannot be assumed to permit data resale or powering an external customer product; a managed-credit model requires an appropriate agreement first.
- **Status:** accepted — implemented at M4 (2026-07-12); the verified endpoint scope, plan-tier finding (Basic minimum), and paid-call contract are ADR-028.
- **Revisit trigger:** Managed-credit design (resale/terms review), or Apollo coverage/terms degradation.

## ADR-015: Two delivery models, one codebase

- **Decision:** One codebase and one workflow format serve both DIY/free self-hosted operation and a managed commercial service. No subscription billing, Stripe, invoices, or plan enforcement in early milestones.
- **Date:** 2026-07-10
- **Evidence:** Directive §2.
- **Reason:** The paid value is hosting, setup, onboarding, maintenance, and support — not source access. Variable data costs stay separate; managed users initially connect their own provider accounts.
- **Status:** accepted
- **Revisit trigger:** Managed-credit system design (separate unit-economics and provider-resale review) or billing introduction.

## ADR-016: Minimal UI at Milestone 2

- **Decision:** Deliver a bare-bones usability UI at M2, over the fake provider and the existing application services, before any live provider integration.
- **Date:** 2026-07-10
- **Evidence:** Directive §3 and §20.
- **Reason:** Harnesses are the first beta interfaces, not the required permanent interface; a nontechnical tester must be able to define, preview, approve, run, monitor, review, and export without the CLI or an external LLM harness. No business logic is duplicated in the UI.
- **Status:** accepted
- **Revisit trigger:** M1 harness results showing a materially safer ordering.

## ADR-017: UI framework/stack

- **Decision:** Vite + React SPA (hash-routed, no router/state/query libraries, hand-written CSS) over a thin JSON API on raw `node:http` in `src/web/`. API routes are 1:1 wrappers over the `src/app` services validating bodies with the engine's own Zod schemas; the SPA lives in top-level `web/` (own tsconfig, excluded from the node build) and type-checks against server DTOs through one type-only seam (`src/web/contracts.ts`). Single root package.json/lockfile; React/Vite are devDependencies only. Rejected: Hono+htmx (results-screen interactivity forces a rebuild by M5), SvelteKit (framework owns the server entry; dev reloads re-open PGlite), Next.js (fights the in-process engine singletons).
- **Date:** 2026-07-11 (user decision at M2 planning)
- **Evidence:** M2 scope is six small guided screens (no canvas/spreadsheet per `docs/ui-scope.md` guardrails); `src/mcp/http.ts` proves the raw-node:http pattern; one toolchain (TS 5.9/tsx/ESLint) per ADR-022. The web server co-hosts the engine because PGlite is single-connection and the in-process worker executes runs in the serving process — never run `pnpm web` and `pnpm mcp:http` against the same `pglite://` directory concurrently.
- **Reason:** The framework never touches the engine process lifecycle (React/Vite stay in static-asset land), the JSON API is a third adapter peer to the CLI and MCP contract-testable with node:test, and the M6 hosted path is the same process plus auth and a PostgreSQL URL.
- **Status:** accepted — implemented at M2 (2026-07-11) with react 19.2 / vite 8.1 (exact versions in pnpm-lock.yaml).
- **Revisit trigger:** M6 hosted/authenticated UI (sessions, per-workspace credentials), or screen growth making hand-rolled routing/fetch a maintenance burden.

## ADR-018: Zod 4 for all runtime validation

- **Decision:** Zod 4 is the single validation source of truth: workflow schemas (10-step allowlist as a discriminated union), env/config, CLI inputs, provider payloads, and (M1) MCP tool schemas via native `z.toJSONSchema()`. Do not add ajv or `zod-to-json-schema` (archived March 2026).
- **Date:** 2026-07-10
- **Evidence:** Directive §13 (M0 dependency direction); `docs/proposals/build-vs-adopt.md` §2.
- **Reason:** One schema source of truth with no hand-written JSON Schema; the same objects serve engine validation and the M1 MCP tool contract.
- **Status:** accepted
- **Revisit trigger:** A Zod major release, or MCP SDK v2's Standard Schema support changing the single-source-of-truth calculus.

## ADR-019: csv-stringify and csv-parse for CSV I/O

- **Decision:** csv-stringify for the `export` step and `run_export_csv` at M0; csv-parse (v7, pinned) for the imported-list workflow at M4. Zod still validates each parsed row.
- **Date:** 2026-07-10
- **Evidence:** Directive §13 (M0 dependency direction); `docs/proposals/build-vs-adopt.md` §2 — streaming, `columns` whitelist, `bom`, `escape_formulas` CSV-injection defense.
- **Reason:** Deletes hand-written quoting/escaping/streaming code while keeping the export-safety controls (formula escaping, column whitelist) declarative.
- **Status:** accepted — implemented (csv-parse 7.0.1 pinned exact landed at M4, 2026-07-12: sync parse over bounded ≤512 KiB inline text — streaming is unnecessary under that ceiling — with `bom`, `trim`, `relax_column_count:false`, a case-insensitive header-alias allowlist that hard-fails on unknown columns, and Zod per-row validation in `src/engine/import/csv-import.ts`; no revisit-trigger regressions found).
- **Revisit trigger:** csv-parse v7 is a fresh major — regressions found during the M4 imported-list workflow.

## ADR-020: libphonenumber-js/max for phone normalization

- **Decision:** libphonenumber-js imported from `/max` for the `normalize` step and free tier-0 phone checks: E.164 normalization, parse/format validity, toll-free detection.
- **Date:** 2026-07-10
- **Evidence:** Directive §13 (M0 dependency direction); `docs/proposals/build-vs-adopt.md` §2 — US/NANPA `getType()` returns FIXED_LINE_OR_MOBILE, so offline line type stays `unknown`.
- **Reason:** Free format-level signals feed the E.164 CHECK constraint and the phone+locality dedupe key; the offline line-type caveat matches the contact-data-honesty rule — only paid Twilio-class lookups set line type.
- **Status:** accepted
- **Revisit trigger:** Metadata staleness, or non-US expansion needing different parsing behavior.

## ADR-021: tldts for domain normalization

- **Decision:** tldts for registrable-domain (eTLD+1) identity keys in `engine/records`, with `allowPrivateDomains: true`.
- **Date:** 2026-07-10
- **Evidence:** Directive §13 (M0 dependency direction); `docs/proposals/build-vs-adopt.md` §2 — without private domains, `acme.github.io` collapses to `github.io` and force-merges distinct businesses.
- **Reason:** Embedded public-suffix list is offline and CI-safe; correct eTLD+1 keys are load-bearing for business dedupe.
- **Status:** accepted
- **Revisit trigger:** Embedded PSL staleness causing dedupe misses or false merges.

## ADR-022: TypeScript pinned to 5.9.x

- **Decision:** Pin `typescript` to 5.9.x (exact) instead of the scaffolded 7.0.2.
- **Date:** 2026-07-11
- **Evidence:** M0 validation — `tsc`/`tsx` work on 7.0.2, but typescript-eslint (8.63.0, the latest) crashes against the TS 7 JS API (`ModuleKind` surface change), and no lint-toolchain upgrade path exists. This was the M0 plan's named risk and locked-default fallback; the user approved the downgrade on 2026-07-11.
- **Reason:** One supported toolchain for compiler, runner, and type-aware linting beats native-compiler speed at this codebase size; `no-floating-promises` and friends are load-bearing for an async engine.
- **Status:** accepted
- **Revisit trigger:** typescript-eslint (or its successor) shipping TypeScript 7 support.

## ADR-023: Firecrawl scraping replaces Google Places for local-business discovery (interim)

- **Decision:** Use Firecrawl as the M3 local-business discovery provider instead of the official Google Places API. Full scrape scope approved by the owner: Firecrawl may scrape Google Maps listings, Google search results, and business websites. The LinkedIn prohibition is untouched and remains permanent. The adapter stays behind the provider-neutral `SourceProvider` interface so an official-API adapter (Google Places, Foursquare, Yelp Fusion) can replace it without engine, workflow, or storage changes.
- **Date:** 2026-07-12
- **Evidence:** Owner decision in the M2 wrap-up session, made twice with the risk picture presented (this entry records informed consent, not an engineering recommendation). Supersedes the former CLAUDE.md "permanent guardrail" for Maps/SERP scraping; partially supersedes the compliance-posture rationale in ADR-013 (anti-bot circumvention now happens inside the Firecrawl vendor boundary) and removes ADR-011's "official Google Places API covers M3" premise.
- **Reason:** Speed to a usable lead flow without Google Cloud billing/API setup; Firecrawl is a single vendor covering search, Maps listings, and site scraping.
- **Risks accepted by the owner:** Google ToS breach (blocking, account action, and — rarely — civil claims); no Places data-licensing terms means no field-mask billing but also no contractual right to store/display the data; scraped-data freshness and provenance are weaker than API responses; Firecrawl pricing/reliability becomes load-bearing; scraped Maps content (ratings/reviews) has unclear reuse rights in client-facing exports.
- **Status:** accepted (interim — "for now" per the owner). **Amended by ADR-024 (2026-07-12):** the Maps/SERP half of this decision was not implementable — Firecrawl cannot reliably scrape Google Maps — so discovery moved to SerpAPI's Google Maps API; Firecrawl is retained for the business-website half (see ADR-027). The scraping-ToS posture accepted here is unchanged. Note: `lead_sources.snapshot_expires_at` landed in migration 0003 but has NO purge job — snapshot expiry was a Google-Places-API caching requirement; neither SerpAPI nor Firecrawl imposes one. The Places-policy machinery activates only if an official-API adapter is (re)introduced (see ADR-011).
- **Revisit trigger:** Any managed/beta launch or data-resale arrangement (mandatory re-review before serving third parties scraped data); Google blocking or legal contact; Firecrawl pricing/reliability problems; or the DIY release, where shipping a ToS-breaching default to other operators needs its own decision.

## ADR-024: SerpAPI Google Maps API for local-business discovery (amends ADR-023)

- **Decision:** Source local businesses through SerpAPI's Google Maps engine (`GET serpapi.com/search?engine=google_maps&type=search`) behind the provider-neutral registry name `local-business`, instead of scraping Google Maps pages with Firecrawl as ADR-023 assumed. Implemented as a typed `fetch` client + `SerpApiLocalBusinessSource` in `src/providers/serpapi/`. Firecrawl keeps the business-website research role (ADR-027). Alternatives behind the same `PagedPaidSource` interface if SerpAPI pricing/terms change: Serper.dev, Outscraper, ScrapingDog, or an official Google Places adapter.
- **Date:** 2026-07-12
- **Evidence:** Web research during M3 planning (owner asked whether the community had solved Maps sourcing): Firecrawl's map-data-extraction feature request was closed "not planned" (firecrawl#1135); multiple open issues document Firecrawl failing on strong anti-bot hosts while still charging credits (#2257, #495, #2413); no success reports exist for scraping `google.com/maps/search` through it. The community-validated lead-gen pattern is a dedicated Maps API for discovery + Firecrawl for website enrichment. SerpAPI returns structured `local_results` (title, type, address, phone, website, rating, reviews, `place_id`, `data_cid`), bills only successful searches (empty 200s are charged; 5xx/429/failed are not; identical queries are served free from a 1-hour cache), and needs `ll` GPS coordinates to paginate past page 1 (~20 results; `start` steps of 20 to ~100). Owner approved the amendment in the M3 planning session (2026-07-12).
- **Reason:** Structured JSON with a stable listing identity (`place_id`, numeric CID) beats maintaining a fragile LLM-extraction schema over an anti-bot-defended page; the bill-only-successful policy plus the 1-hour cache also makes crash-replay effectively free.
- **Coverage semantics (honest limits):** a plain place-name location yields page 1 only (~20 listings) via `q="<business> <location>"`; a location written as `@lat,lon,zoom` is passed as `ll` and paginated up to `SERPAPI_MAX_PAGES_PER_QUERY` (default 6 ≈ 120 results). Volume scales by tiling locations (metro + suburbs). Name→coordinate geocoding for deep pagination of named locations is a recorded follow-up, as is `/search` SERP-based discovery. Every run surfaces per-request coverage notes (`run_source_requests.coverage_note`).
- **ToS posture:** unchanged from ADR-023 — SerpAPI scrapes Google inside its own vendor boundary exactly as Firecrawl would have; the owner-accepted risk envelope and all ADR-023 revisit triggers carry over.
- **Residual credit risk (accepted, bounded):** a crash between a completed search and its ledger commit replays the identical query on resume; within SerpAPI's 1-hour cache the replay is free, but a resume delayed past the cache window re-charges at most that one search. SerpAPI accepts no idempotency key, so this is documented per the per-adapter paid-call contract rather than engineered away. (Paid Firecrawl research has no such cache; there a crash replay is booked as ambiguous → `needs_review` instead of re-executed.)
- **Status:** accepted (interim, same "for now" scope as ADR-023)
- **Revisit trigger:** ADR-023's triggers, plus SerpAPI pricing/terms/reliability changes or coverage gaps that a Serper.dev/Outscraper/official-Places adapter would close.

## ADR-025: Plain typed fetch + Zod clients for SerpAPI and Firecrawl (no vendor SDKs)

- **Decision:** Implement both vendor clients as plain `fetch` wrappers with Zod response validation (`src/providers/serpapi/client.ts`, `src/providers/firecrawl/client.ts`); do not adopt the `serpapi` or `@mendable/firecrawl-js` npm SDKs.
- **Date:** 2026-07-12
- **Evidence:** Each integration touches one or two documented REST endpoints; both SDKs are thin wrappers whose retry/timeout semantics would have to be audited against the engine's charged/uncharged/ambiguous error taxonomy (directive §11).
- **Reason:** The error taxonomy is load-bearing for paid-call safety: a 429 must map to `RateLimitError` (not an attempt), 5xx to `RetryableProviderError{charged:false}`, and timeouts/malformed-200s to `AmbiguousOutcomeError` → `needs_review`. Owning the HTTP layer keeps that mapping explicit, testable against fixtures, and free of hidden SDK retries that could double-spend.
- **Status:** accepted
- **Revisit trigger:** Adopting additional endpoints (batch/crawl/async jobs) where an SDK's job-polling machinery would carry real weight.

## ADR-026: Hand-rolled serial rate limiter and backoff (p-queue/p-retry deferred)

- **Decision:** Client-side throttling is a ~10-line serial min-interval limiter inside each vendor client, and transient-error backoff is the runner's existing bounded retry loop; p-queue and p-retry are not adopted at M3 (a deliberate deviation from the directive's M3 naming of those libraries).
- **Date:** 2026-07-12
- **Evidence:** Source searches execute strictly sequentially under the exclusive run lease — there is no concurrency for p-queue to manage; the vendors' server-side limits (SerpAPI hourly throughput; Firecrawl per-plan RPM) are enforced by 429s the engine already turns into durable pause/reschedule state (`runs.resume_at`).
- **Reason:** Two dependencies would replace ~20 lines of code while the real protection (429 → pause → `resume_at` → delayed resume) lives in the engine, not the client.
- **Status:** accepted
- **Revisit trigger:** Concurrent multi-provider scheduling (M4+ enrichment waterfalls), where a real queue with per-provider concurrency becomes load-bearing.

## ADR-027: Website research via a flag-gated Firecrawl ResearchProvider

- **Decision:** Bounded business-website research is `FirecrawlWebsiteResearch` (`src/providers/firecrawl/website-research.ts`), registered under the provider-neutral name `website-research` only when `WEBSITE_RESEARCH_PROVIDER=firecrawl` AND `FIRECRAWL_API_KEY` are set (default `fake` keeps M0 behavior). Deterministic summary/facts (title, meta description, trimmed excerpt — no LLM). It sets `ResearchProvider.costPerRecord = 1`, which makes research a paid item step priced by the plan resolver and gated by the record cap/budget.
- **Date:** 2026-07-12
- **Evidence:** ADR-023 explicitly permits Firecrawl on business websites; the M3 Quick List workflow contains no research step, so the module is isolated and deferrable at zero cost.
- **Reason:** One vendor already under contract covers the research need without building the ADR-013 lean fetcher now; module isolation keeps the recorded alternatives (an ADR-013-style self-built fetcher, or deferring research to M4) a registry/env change only.
- **Status:** accepted (module optional/deferrable by env)
- **Revisit trigger:** Credit costs at real volumes making the free ADR-013 lean fetcher worth building, or Firecrawl reliability problems on ordinary business sites.

## ADR-028: Apollo typed REST adapter — endpoint scope and paid-call contract

- **Decision:** Implement Apollo (ADR-014) as a plain typed `fetch` + Zod client (`src/providers/apollo/client.ts`, per ADR-025) wrapping exactly two data endpoints, registered under provider-neutral names: **people search** `POST /api/v1/mixed_people/api_search` as the zero-cost `PagedPaidSource` `professional-contacts` (ledgered for crash replay and 429 → `resume_at` pausing), and **person enrichment** `POST /api/v1/people/match` as the `EnrichProvider` `person-enrichment` (`costPerRecord: 1`, `idempotentReplay: false`). The legacy `/mixed_people/search` endpoint is NEVER called (it returns 403 on Basic plans). `reveal_personal_emails` is always false (B2B work email only); `reveal_phone_number` is never sent — Apollo delivers phone reveals asynchronously to a mandatory HTTPS webhook, so phone discovery is deferred to M5 where contact enrichment and call-readiness live. Zero-cost key check: `GET /api/v1/auth/health`. No sequences, emails, contact-creation, or CRM writes are wrapped, ever (prohibited-action guardrail). One shared client instance serves both roles so the serial limiter (ADR-026) spans Apollo's account-wide per-minute window.
- **Date:** 2026-07-12
- **Evidence:** Verified against docs.apollo.io on 2026-07-12 (people-api-search, people-enrichment, api-pricing, auth health) plus 2026 hands-on guides: search requires a **master API key**, consumes no credits, and returns no emails/phones; enrichment consumes ~1 credit per record when data is returned; the `api_search`-vs-legacy 403 distinction is undocumented by Apollo but reproduced by multiple integrators. **Plan tier — live-corrected 2026-07-12 with the owner's free master key:** Apollo 403s `mixed_people/api_search` ENTIRELY on free plans ("not accessible with this api_key on a free plan") — a free key can be created and health-checked (`auth/health` returned ok) but cannot search; the third-party "free tier: 50/min, 600/day search" picture is stale. **Basic (~$49/user/mo annual) is therefore the minimum tier for any live traffic**, not just recommended. Credit allowances shifted repeatedly in 2026 — confirm at checkout. Standard terms prohibit resale/powering external products (ADR-014's managed-credit caveat stands).
- **Paid-call idempotency contract** (per docs/architecture.md; mirrored in the client docblock): neither endpoint accepts an idempotency key or returns a stable request id (the engine's `request_key` is persisted as the fallback). *Search:* failures never consume credits, so network errors, 5xx, timeouts, AND malformed 200s are all `RetryableProviderError{charged:false}` (deliberate divergence from paid clients); 429 → `RateLimitError` (daily-window bodies wait ≥ 1h). *Match:* clean 4xx/5xx and `no_match` don't charge; timeout or malformed 200 → `AmbiguousOutcomeError(possibleCost=1)` → `needs_review` with NO automatic reconciliation (Apollo has no per-request ledger API — reconcile manually against the dashboard); crash replay of an interrupted paid attempt is likewise booked ambiguous (`idempotentReplay:false`), never re-executed; 401/402/403/422 → operator-facing `PROVIDER_ERROR`.
- **Reason:** Search being credit-free and contact-less makes the professional workflow's "review real rows before any spend" gate structurally cheap; the two-endpoint scope keeps the guardrail surface (no outbound actions) auditable; owning the HTTP layer keeps the charged/uncharged/ambiguous taxonomy explicit and fixture-testable.
- **Status:** accepted
- **Revisit trigger:** Apollo pricing/tier gating changes (they shifted repeatedly in 2026), the M5 phone-reveal webhook design, managed-credit/resale design (ADR-014), or Apollo publishing request ids/idempotency keys that would let ambiguous outcomes reconcile automatically.

## ADR-029: Submit-then-poll for async contact discovery; no webhook receiver at M5

- **Decision:** Async contact-discovery vendors (BetterContact, FullEnrich) are driven by submit → persist the vendor job id in `run_item_steps.result.capabilityJob` → poll on later attempts scheduled via `next_attempt_at`; the run parks as `paused/awaiting_provider` with `resume_at` = the earliest poll due (the same auto-resume machinery as rate-limit pauses, in both job drivers). A pending poll is neither an error nor a spent attempt (`PendingProviderJobError` → `deferStepForPoll`). Crash replay with a persisted job id re-polls — never re-submits; a submit that dies before the job id commits reconciles via the vendor's echoed client reference where an API exists, else books `AmbiguousOutcomeError` → `needs_review` (the ADR-028 Apollo-match precedent; LeadMagic, with no job id, stays in that class for all unconfirmed outcomes). No inbound webhook receiver is built at M5 — the deployment is local-only until M6, and Apollo's phone reveal (webhook-ONLY delivery) stays deferred accordingly.
- **Date:** 2026-07-13
- **Evidence:** Owner decision at M5 planning (webhooks deferred to the M6 HTTPS deployment); BetterContact and FullEnrich both expose poll endpoints and echo client references (custom_fields / bulk name); offline proof in `test/capability-poll-resume.test.ts` (pending → defer → awaiting_provider pause → auto-resume ×2 → delivery, cost booked once at delivery; attempts not consumed by polls).
- **Reason:** Submit-then-poll gets async vendors working without public infrastructure, and a persisted job id turns the crash-replay problem from "possibly double-paid" into "re-read the answer" — strictly safer than sync vendors without request ids.
- **Status:** accepted
- **Revisit trigger:** The M6 public HTTPS deployment (webhooks become cheap — Apollo phone reveal unlocks then), or a selected vendor deprecating its poll endpoint.

## ADR-030: All six capability adapters built at M5; vendor selection deferred to owner benchmarks

- **Decision:** Build all benchmark candidates as full adapters behind the M5 capability interfaces (`src/providers/capabilities.ts`): Twilio Lookup v2 (`twilio-lookup`, PhoneValidationProvider), ZeroBounce + MillionVerifier (EmailVerificationProvider), BetterContact + FullEnrich + LeadMagic (ContactDiscoveryProvider — one instance serves BOTH phone_discovery and email_discovery steps via the request's `wanted` kinds). All are ADR-025-style plain fetch + Zod clients with the paid-call contract in the docblock and the charged/uncharged/ambiguous taxonomy fixture-tested per vendor plus a shared neutrality suite. Cost models are explicit: `costPerSignal` (Twilio bills per signal package; the plan resolver prices a validation step by its requested `signals`), `costOnUnknown: 0` (both email verifiers refund unknowns), `costPerKind` with found-only billing and phone≈10×email (discovery vendors), `costOnNoResult: 0` everywhere. Adapter built ≠ vendor selected: the registry activates exactly one vendor per capability via env selection (ADR-031), and the ADR-008/009/010 decisions wait for the owner-run benchmarks (`docs/benchmarks-m5.md`, `pnpm bench:*` — CI-refusing, spend-confirming, sanitized reports).
- **Date:** 2026-07-13
- **Evidence:** Owner decision at M5 planning ("build all candidate adapters"). Endpoint paths/fields and charging policies encode public API knowledge as of early 2026 and are marked for live re-verification via each harness's `--probe` mode before benchmark spend; the load-bearing assumptions (unknown refunds, package-error charging, per-kind credit ratios) are priced into previews and must be confirmed then.
- **Reason:** With adapters pre-built, the benchmark IS the integration test, and the owner's post-benchmark selection is an env change, not an engineering project.
- **ADR-026 re-evaluation (its revisit trigger fired — M5 is the multi-provider milestone):** the hand-rolled serial per-client limiter remains sufficient: steps execute strictly sequentially under the exclusive run lease, a discovery step calls exactly ONE configured vendor, and the "waterfall" happens inside the vendors. p-queue stays unadopted. New revisit trigger: parallel per-item capability fan-out or multiple resident workers sharing one client instance.
- **Status:** accepted (vendor selections pending — ADR-008/009/010)
- **Revisit trigger:** Benchmark results (owner decision), vendor API/pricing drift found at probe time, or Twilio ambiguity noise at volume (a ~$0.01 lookup timeout books needs_review; a usage-API auto-reconciliation could relax this).

## ADR-031: Capability env-selection pattern (doubly opt-in, per capability)

- **Decision:** `PHONE_VALIDATION_PROVIDER=fake|twilio`, `EMAIL_VERIFICATION_PROVIDER=fake|zerobounce|millionverifier`, and `CONTACT_DISCOVERY_PROVIDER=fake|bettercontact|fullenrich|leadmagic` extend the `WEBSITE_RESEARCH_PROVIDER` pattern: the deterministic fake providers (shared persisted ledger, `FAKE_CAPABILITY_LEDGER_PATH`) bind by default so the whole Call-Ready flow runs offline; a live vendor binds only when BOTH the selection and its key(s) are present; a selection WITHOUT keys leaves the capability empty so plan resolution fails loudly (never a silent fake under a live-looking selection). One discovery instance registers for both discovery step capabilities while `findPhones`/`findEmail` stay independently overridable (the step's `wanted` kinds constrain each call).
- **Date:** 2026-07-13
- **Evidence:** ADR-027's doubly-opt-in precedent; registry behavior covered by the capability plan-resolution and web provider-status tests.
- **Reason:** Selection stays an env concern, per capability, with no engine or workflow changes when the owner picks or switches vendors.
- **Status:** accepted
- **Revisit trigger:** Multi-vendor waterfalls per capability (running two discovery vendors in sequence), which would need an ordered selection list instead of a single choice.

## ADR-032: Model adapters as plain typed fetch behind ONE shared generation interface

- **Decision:** MiniMax, OpenAI, and Anthropic generation adapters (`src/providers/models/`) implement one shared `ModelProvider` interface — `generate(request with kind, promptVersion, engine-built prompt, Zod outputSchema + derived strict wire schema, constraints)` returning validated output or an honest `invalid_output` — as plain `fetch` + Zod clients (extends ADR-025; MiniMax has no official TS SDK, and one testing style covers all three; honest counterpoint: the official OpenAI/Anthropic SDKs ship parse helpers and typed errors we forgo). Structured output per vendor: OpenAI Responses API `json_schema` strict; Anthropic Messages `output_config.format json_schema`; MiniMax schema-in-prompt + ONE in-adapter repair round-trip. The ENGINE owns prompts, evidence bundles, and grounding (`src/engine/generation/`): versioned templates (`fit-rationale/v1` → fit_summary, `call-notes/v1` → call_notes, `opener/v1` → opener; bump on any prompt/schema change), claims must cite evidence ids from persisted rows, ungrounded claims are stripped and a required section left empty invalidates the output (retry once, then the step completes `generation_invalid_output` and the lead stays usable). Selection: `GENERATE_MODEL_PROVIDER` (or key-presence with preference minimax > openai > anthropic per ADR-012; `fake` registers the deterministic fake). Generation books engine cost 0 — model calls bill the owner's model account; token usage is recorded informationally. Transport errors keep the taxonomy (429 → RateLimit pause; 5xx/timeout → retryable; NEVER ambiguous — no engine credits at risk). `skipPersonalization` narrows to personalization templates only (call notes survive it). Regeneration: review decision `regenerate` + `run_retry` re-runs the generate step (fresh request key), appends a new output row (history is append-only), and returns the item to `unreviewed`.
- **Date:** 2026-07-13
- **Evidence:** `test/model-adapters.test.ts` (per-vendor contract + shared same-request-same-schema check), `test/generation-grounding.test.ts`, `test/generate-step.test.ts`, `test/regenerate-flow.test.ts`; `test/generate-disabled.test.ts` stays green (empty registry remains the baseline). Exact model ids/endpoints (`MiniMax-M3`, `gpt-5-mini`, MiniMax intl base URL) are env-configurable and flagged for live verification when the owner adds keys — no MiniMax account exists yet (ADR-012 stays pending on the account decision).
- **Reason:** One interface, one grounding enforcement point, one fixture-testing style; nothing model-provider-specific is architectural, and every M5 acceptance behavior works with generation disabled.
- **Status:** accepted (MiniMax account/key remains the owner's pending ADR-012 decision)
- **Revisit trigger:** The M5+ embedded assistant needing streaming/tool-use (SDKs earn their keep there), vendor structured-output API changes, or the owner's model-provider account decisions.

## ADR-033: OpenRouter as the MiniMax route (amends ADR-012/ADR-032)

- **Decision:** The embedded MiniMax model runs through OpenRouter (`src/providers/models/openrouter.ts`, provider name `openrouter`, default model `minimax/minimax-m3`) instead of a direct MiniMax account. OpenRouter exposes the OpenAI CHAT-COMPLETIONS surface, so it is a fourth adapter behind the same shared interface: structured output via `response_format json_schema` (MiniMax M3 supports it on OpenRouter) plus the schema-in-prompt fallback and one repair round-trip; the engine's Zod schema stays the trust boundary. Preference order when GENERATE_MODEL_PROVIDER is unset: openrouter > minimax > openai > anthropic. The direct MiniMax adapter stays as the fallback path if OpenRouter routing/pricing degrades.
- **Date:** 2026-07-13
- **Evidence:** Owner decision ("setup the OpenRouter account for MiniMax"). openrouter.ai lists `minimax/minimax-m3` with structured-output support at ~$0.30/M input, $1.20/M output; fixture contract test `test/model-adapters.test.ts` (openrouter case) covers the structured request, repair path, and in-body error envelope.
- **Reason:** One account/key covers MiniMax today and any future model swap (the model id is an env var), with OpenAI-compatible semantics we already exercise; no direct MiniMax billing relationship needed.
- **Status:** accepted (owner creates the account/key; ADR-012's "MiniMax first" intent is satisfied via this route)
- **Revisit trigger:** OpenRouter pricing/routing/availability problems for MiniMax models, or the embedded assistant needing features OpenRouter does not pass through.
