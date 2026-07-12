# Build vs adopt: Clay-alternative landscape and tool selection (proposal)

Status: **corrected 2026-07-10 per `consolidated-revision-directive.md`; decisions tracked in `docs/decisions.md`. M0 outcome (2026-07-11): Kysely's official `PGliteDialect` and pg-boss's `fromPglite` verified on the installed packages; the pg-boss/PGlite spike passed 8/8 (ADR-002 accepted); TypeScript pinned to 5.9.x after typescript-eslint proved incompatible with 7.0.2 (ADR-022).** Produced 2026-07-10 from a five-lens web/GitHub sweep (85 unique candidates), 16 primary-source deep-dives (license files, npm metadata, release history), and a synthesis against `docs/architecture.md`, `docs/implementation-plan.md`, and `docs/proposals/database-schema.md`. Decisions here feed the milestone plans. Scraping-class rejections are permanent project guardrails; library/vendor selections are ADR entries with revisit triggers in `docs/decisions.md`.

# Build-vs-Adopt Research Report — Lead Engine

Grounded in `/Users/abraze/Documents/Clay replacment/docs/architecture.md`, `/Users/abraze/Documents/Clay replacment/docs/implementation-plan.md`, and `/Users/abraze/Documents/Clay replacment/docs/proposals/database-schema.md` (the proposed 12-domain-table M0 DDL — plus `schema_migrations` — with append-only `contact_point_checks`, the `run_item_steps` cost/idempotency ledger, and the M1 `approval_tokens` model).

---

## 1. What exists vs what we're building

**There is no open-source Clay to adopt.** The honest landscape:

- **YALC — GTM operating system** (MIT, 257 stars) is the most substantial open "CLI-first Clay alternative": TS, 20 provider adapters, DB-backed rate limiting, MCP integration. But it is SQLite/Turso (we are PostgreSQL-as-system-of-record), single-author, and has none of our load-bearing requirements: approval tokens bound to preview scope, append-only validation history, per-signal phone semantics, idempotent cost ledger. Mine it; do not fork it.
- **beton-ai** (MIT, 72 stars) is the closest stack match (TS/Express/Prisma/Postgres/Bull/Apollo REST) but is deprecated. Study material for the Apollo adapter and job patterns only.
- **Bricks** and **LeadGenius** have **no license file** — code legally uncopyable — and Bricks is scraping-centric (Puppeteer stealth), which our compliance baseline forbids.
- **KeeLead** (MIT, 7 stars) is immature and its "62 data sources" likely include ToS-risky scrapers.
- **Activepieces** (MIT core, 23k stars) and **n8n** (fair-code, not OSI) are general automation platforms — n8n's license bars vendoring and both embrace the arbitrary-code generality our typed-step allowlist exists to reject.
- **Twenty / EspoCRM / SuiteCRM** (all AGPL) are CRMs, not enrichment engines; AGPL bars code reuse anyway.
- **Firecrawl** (148k stars) and **Reacher** (9.1k stars) have AGPL cores — hosted-API-only, never vendored.

**Conclusion:** our differentiators — the preview→approval-token→start gate, per-signal contact validation honesty, provenance/idempotency schema, and the harness-neutral MCP contract — exist nowhere as adoptable open source. **Build the engine; buy the data; adopt commodity libraries for every solved problem below.** Roughly half of the Milestone 0 plumbing in `docs/implementation-plan.md` can be deleted in favor of verified MIT/Apache dependencies.

---

## 2. Adopt now (Milestone 0/1)

All verified strong-fit from primary sources (license files, npm, recent releases).

| Dependency | License | Replaces in `src/` | Effort |
|---|---|---|---|
| **zod ^4.4.3** | MIT | `engine/workflow-schema` validation, env/config validation, CLI input parsing, provider payload validation, and (M1) MCP tool schemas via native `z.toJSONSchema()` — one source of truth, no hand-written JSON Schema, no ajv. Step allowlist = `z.discriminatedUnion`. Do **not** add `zod-to-json-schema` (archived March 2026). | drop-in |
| **kysely 0.29.3 (pinned exact)** | MIT | `storage/` repositories + migrations. Zero-dep typed SQL over `pg`; built-in Migrator (DB advisory lock, transactional DDL) runs TS migration files embedding the exact hand-authored DDL from `docs/proposals/database-schema.md`. **Decision: Kysely over Drizzle** — both verified strong-fit, but our schema is already finalized SQL with partial unique indexes, paired-NULL CHECKs, and regex CHECKs that diff-based codegen (drizzle-kit) handles poorly; hand-shaped aggregate queries match "plain relational, no EAV". Do not mix. Current Kysely ships **official PGlite support** — the same dialect runs embedded PGlite locally and hosted PostgreSQL, no community shim or custom dialect needed. **node-pg-migrate becomes unnecessary** (Kysely's Migrator covers it). | drop-in |
| **pg-boss v12 (pinned; M0 spike devDependency, runtime adoption at M1)** | MIT | `jobs/` entirely: SKIP LOCKED fetch, retry/backoff, queue rate limits, dead-letter, archive — no Redis. Killer feature: enqueue **inside the same Postgres transaction** that writes `run_items`/`run_item_steps` state. Current pg-boss supports PGlite via **`fromPglite`**; because that support is new, **M0 runs a bounded compatibility spike** — filesystem persistence, start/stop/restart, job recovery, retry/backoff, duplicate-claim prevention, cancellation, modest concurrency, interaction with application transactions where supported — and pg-boss is adopted only after the spike passes. **Decision: pg-boss over graphile-worker and DBOS Transact** (all three verified strong-fit; ADR pending the spike): graphile-worker deletes completed jobs (no audit trail) and has a single maintainer; DBOS's checkpoint tables duplicate what `run_item_steps` already owns and add workflow-determinism + app-version recovery constraints. Caveats locked into the plan: pg-boss is at-least-once, and its **job-delivery guarantees are distinct from third-party paid-call side effects** — the `run_item_steps` `request_key`/cost ledger is the internal replay guard checked before every paid call, while provider-side idempotency must be documented per paid adapter. Do not use pg-boss "flows"; orchestration stays in explicit engine steps. Requires Node ≥22.12 — pin Node 22 LTS now. | thin adapter (`JobQueue` interface; engine never imports pg-boss directly) |
| **csv-stringify (M0) + csv-parse (M4, with the imported-list workflow; pinned — parse v7 is a fresh major)** | MIT | `export` step / `run_export_csv` (streaming, `columns` whitelist, `bom`, `escape_formulas` for CSV-injection defense) and the imported-list source (`columns: true`, strict column count) — deletes all quoting/escaping/streaming code. Zod still validates each parsed row. | drop-in |
| **libphonenumber-js (import from `/max`)** | MIT | `normalize` step + free tier-0 phone check: E.164, parse validity, toll-free detection; feeds the `contact_points_phone_e164_ck` constraint and phone+locality dedupe key. Verified caveat baked into design: US/NANPA `getType()` returns FIXED_LINE_OR_MOBILE — offline line-type stays `unknown`; only paid Twilio-class lookups set it (which is exactly our "format-valid is never verified" rule). | drop-in |
| **tldts** | MIT | `engine/records` domain normalization — registrable-domain (eTLD+1) identity key with `allowPrivateDomains: true` (else `acme.github.io` collapses to `github.io` and force-merges distinct businesses). Embedded PSL = offline, CI-safe. | drop-in |
| **@modelcontextprotocol/sdk v1.29.x (pinned)** — M1 | MIT (v1.x) | All of `mcp/`: `registerTool` with the same zod objects, `readOnlyHint`/`destructiveHint` annotations, server `instructions` (512-char Codex rule), `StdioServerTransport` + `StreamableHTTPServerTransport` from one `McpServer` — satisfies the "same tools over both transports" acceptance test with zero protocol code. Confine imports to `src/mcp/`; stay on the stable v1.x line until v2 (new package names, Standard Schema) is **actually stable** — its ~2026-07-28 release date is a forecast, not a guarantee. Migration is then a contained refactor. | drop-in |
| **openai/openai-agents-js (devDependency only)** — M1 | MIT | Nothing in `src/` — it *fulfills* the documented "OpenAI Agents SDK test client" acceptance fixture. Verified: `MCPServerStdio`/`MCPServerStreamableHttp` work standalone without an OpenAI key, so CI stays credential-free. Never in `src/engine|providers|storage|mcp`. | drop-in |

### Deferred from "adopt now"

- **json-rules-engine v7.3.x (ISC) — deferred.** M0 builds the `filter`/`score` grammar itself: a small hand-typed deterministic operator allowlist — serializable JSON conditions over declared typed fields (`eq/neq/gt/gte/lt/lte/in/not_in/contains/exists`), a thin points-summing layer for `score` templates, no eval, no dynamic paths — stored in `workflow_versions`, with per-rule results persisted as the `score_rationale` in `generated_outputs`. Reconsider a general rules engine only when real workflow complexity outgrows the allowlist (ADR with revisit trigger in `docs/decisions.md`). If ever adopted, the original mandates stand: a restricted dot-path `pathResolver` (its jsonpath-plus dependency had RCE CVEs; rule JSON is LLM-authored) and the points-summing layer (it fires boolean events, not scores).

---

## 3. Adopt at the milestone

### Milestone 3 — local-business workflow (first live provider; now precedes Apollo in the milestone sequence)
- **Google Places API (New)** as the sourcing adapter. Field masks are the billing lever: phone + website force the $35/1k Enterprise SKU — `run_preview` must compute cost estimates **from the requested field mask**. `lead_sources.snapshot_expires_at` purge job implements the storage policy (already in the schema doc).
- **p-retry v8 + p-queue** (both MIT, active; **not bottleneck** — stale since Jan 2024) land here, not with Apollo: under the revised milestone order the local-business provider is the first live rate-limited provider, so the shared `src/providers/retry.ts` house policy and 429 pause scheduling arrive with it — retries 3-4, jitter, `shouldRetry` limited to 429/network/connection-5xx, `shouldConsumeRetry` exempting 429 waits, everything else `AbortError` into the job layer's visible retryable state. Guardrail: only wrap requests provably not credit-spending; paid POSTs go through the `request_key` internal-replay contract in `run_item_steps` plus the per-adapter provider-side idempotency contract.
- **Lean fetcher, not crawlee** for `providers/website`: undici + **robots-parser** (MIT) + **cheerio** (MIT — never its `fromURL`; all HTTP through our policy layer) + p-queue. Crawlee was verified and **rejected**: robots enforcement defaults off, got-scraping defaults to browser-fingerprint spoofing built for anti-bot evasion, and its file-based queue would create dual state ownership against `run_items`. Use its politeness knobs as the spec for our limits.
- **geo-tz** (MIT) offline lat/lng → IANA timezone for `leads.timezone`; no paid timezone API.
- **Foursquare OS Places** (Apache-2.0, 100M+ POI, monthly Parquet drops): **optional, and a large data/operations commitment — not a trivial adapter.** Ingesting, storing, and refreshing monthly Parquet drops is real pipeline work. Keep it as a deferred hedge against Google's storage restrictions (ADR in `docs/decisions.md`), not a default M3 deliverable.

### Milestone 4 — professional and imported workflows
- **Apollo REST** via our own typed adapter (`providers/apollo`). No adoptable OSS client exists (community MCP wrappers are unlicensed or Python). The official Apollo MCP (already in `.mcp.json`) stays prototyping-only per project rules; use its 30+ tool catalog to scope which REST operations we wrap and which (sequences, emails, CRM writes) we must never wire up.
- **csv-parse v7 (pinned)** for the imported CSV/domain workflow (`columns: true`, strict column count); Zod validates each parsed row.
- Provider retry-policy hardening reuses the M3 `retry.ts` house policy; identity-conflict handling (`identity_conflicts`) lands here.

### Milestone 5 — contact enrichment, validation, and MiniMax assistance

**The waterfall question — decided:** split by capability. Vendor names below are **benchmark candidates pending the M5 benchmark** (ADRs with revisit triggers in `docs/decisions.md`), not final selections.

- **Phone validation: build individual adapters, never buy a bundle.** Twilio Lookup v2 remains the strong first candidate: its per-signal packages (format free; line type $0.008; line status $0.007→$0.00385; identity match ~$0.10) map **one-to-one** onto `contact_point_checks.method` — this per-signal transparency is the whole point of our schema. **Telnyx** as the second adapter (carrier $0.0015, cheaper fallback) proves the interface is genuinely provider-neutral. IPQualityScore only if Twilio Line Status proves insufficient (fraud-plan pricing ~$499+/mo skews it out).
- **Email verification: ZeroBounce is the leading candidate** — its taxonomy (valid/invalid/catch_all/role_based/unknown) matches our `email_status` CHECK almost verbatim — with **MillionVerifier** (~$0.0037/email) as the bulk cost tier; two verifiers = the classic two-tier waterfall and a neutrality proof. Both remain benchmark decisions. Free tier-0 first: syntax + MX via `node:dns` + disposable-domain list (pattern from deep-email-validator/AfterShip — vendored ideas, not the packages); tier-0 results are never labeled beyond their check.
- **Discovery (find phones/emails/people): ONE waterfall-as-API adapter instead of N vendor adapters.** **BetterContact, FullEnrich, and LeadMagic are benchmark candidates — do not select one from marketing claims.** Benchmark on: match rate; accuracy; attribution; cost per usable result; latency; API reliability; webhook/reconciliation behavior; ambiguous-request handling; provider and resale terms. (Fit notes: BetterContact's pay-only-on-found pricing at $15/mo entry aligns with our credit-gate model — 1 credit email / 10 mobile; FullEnrich's async/bulk shape fits the jobs+polling model but is $69/mo entry; LeadMagic's MIT OpenAPI spec is the fastest typed-adapter codegen and an MCP-first peer.) **Trade-off stated:** buying the waterfall means we don't control provider ordering or see exactly which upstream source/check produced a value — persist whatever source attribution the API returns into `source_metadata`, and keep the capability interface so individual adapters (Prospeo ~$0.01/email, Findymail quality tier) can be added later without schema change. Apollo (integrated at M4) remains a first-class discovery source before the waterfall fires. Do NOT build our own multi-vendor discovery waterfall in the MVP — that is exactly the config-maintenance burden Clay charges for, and enrichment-kit (MIT, 29 stars) shows the cost-ordering/short-circuit logic if we ever do.
- **Generation: MiniMax M3 is the likely first embedded model provider** (ADR pending M5), joining official OpenAI + Anthropic SDKs behind the one `providers/models` interface per the architecture doc. The embedded assistant may not bypass preview/approval, write to the database, mark contact information verified, be the sole qualification authority, or own run state; workflows still run with generation disabled.

---

## 4. Study, don't copy

| Source | License (why not copy) | The one pattern to imitate |
|---|---|---|
| **Trigger.dev** | Apache-2.0 (legally minable, but a whole orchestration platform) | TaskRun status lifecycle + idempotency keys with TTL — the best-licensed reference for `runs`/`run_items` state transitions. |
| **Windmill OpenFlow spec** | Spec is Apache-2.0 (product AGPL) | Suspend/approval steps that halt a run until an approver resumes — an existing formalization of our `review_gate` + approval token. |
| **Inngest** | SSPL (code untouchable) | Step memoization: persisted `step.run()` results returned on retry instead of re-executing — the exact contract `run_item_steps` implements for "never re-spend credits". |
| **Temporal** | MIT (cluster is infra overkill) | Append-only event history + idempotent activities; sanity-check our state machine against their docs. |
| **DBOS Transact** | MIT (not selected for jobs) | `dbos.workflow_status`/`operation_outputs` column design as a cross-check on `run_item_steps`. |
| **Twenty CRM** | AGPL | Uniqueness semantics: soft-deleted rows count toward uniqueness, upsert-on-unique-match, explicit two-record merge — validates our flag-don't-merge rules. |
| **Mautic** | GPL | Points ledger scoring (every point change stored with trigger/reason/timestamp) and channel-level DNC → our `score_rationale` and `suppressions`. |
| **Activepieces** | MIT core only (`packages/ee/` commercial — mine MIT paths only) | Typed Props step-config validation and flow-run state storage; the closest MIT analog to our bounded step schemas. Patterns/types may be vendored from MIT paths. |
| **YALC / beton-ai / enrichment-kit** | MIT (immature/deprecated/tiny) | DB-backed token-bucket rate limiter (YALC), Apollo REST client + Bull retry patterns (beton-ai), cost-ordered waterfall with confidence short-circuit (enrichment-kit). |
| **github/github-mcp-server** | MIT, Go | Toolset grouping, `--read-only` override mode, per-tool enable config — for our M1 tool contract. |
| **Stripe agent toolkit** | MIT | The closest production analog to preview → approval-token → execute for money/credit-spending tools. |
| **modelcontextprotocol/servers**, **cloudflare/mcp-server-cloudflare**, **cloudflare/agents** | MIT/Apache (demos / Workers-specific) | Tool annotation usage; authenticated remote Streamable HTTP organization for the later shared deployment. |
| **cablate/mcp-google-map** / **twilio-labs/mcp** | MIT | Places API (New) field-mask/tool shapes; Twilio Lookup as typed tools. |
| **AfterShip email-verifier** | MIT, Go | The best-documented verification-signal taxonomy and check ordering — port semantics into `contact_point_checks`. |
| **DataForge** | MIT, Python | Government-registry sourcing (NPI Registry for health-sector B2B, SAM.gov) as a future free compliant `source` adapter idea. |
| **gtm-eng-skills / waterfall-gtm / Rowbound** | MIT | How to decompose lead-gen jobs into harness-drivable tools; real-world provider ordering; dry-run + run-history MCP surface. |

---

## 5. Explicitly rejected (scraping-class = permanent guardrails; library/vendor entries carry revisit triggers in `docs/decisions.md`)

- **joeyism/linkedin_scraper, StaffSpy, and the entire LinkedIn-scraper class** — hard project prohibition; violates LinkedIn's User Agreement; LinkedIn URLs enter only via Apollo/import/approved integration.
- **gosom/google-maps-scraper, omkarcloud/google-maps-scraper** — MIT license does not cure Google Maps ToS violation; official Places API only.
- **SerpApi / Serper Google Maps endpoints** — ToS-violating SERP scraping with demonstrated litigation risk (Google v. SerpApi, filed Dec 19, 2025).
- **Firecrawl core** — AGPL; hosted API behind a typed adapter is the only permitted use; never vendor.
- **Reacher core** — AGPL; hosted/self-hosted HTTP behind our email-verification interface only.
- **crawlee** — verified reject: anti-bot-evasion defaults (fingerprint spoofing, robots off) invert our compliance posture; file-based queue conflicts with Postgres-owned `run_items` state.
- **n8n** — fair-code license bars vendoring; arbitrary-code node model is what our allowlist rejects.
- **zod-to-json-schema** — archived March 2026; Zod 4 is native.
- **google-libphonenumber** — ~530 kB, wrapper license NOASSERTION, no benefit for US-focused MVP.
- **bottleneck** — unmaintained (>2y); use p-queue.
- **Yelp Places API** — 24-hour cache limit and no-analysis consumer-display terms are incompatible with a durable `leads` table.
- **Bricks, LeadGenius, hunter-io/chatgpt-mcp** — no license file; code legally uncopyable (read-only inspiration at most).
- **SuiteCRM** — EAV-ish vardefs architecture is the generalized entity/attribute system our docs forbid.
- **Inngest as a dependency** — SSPL today.
- **Numverify** — adds nothing over free local libphonenumber + Twilio-class checks.
- **Google Maps Grounding Lite MCP** — answer-grounding storage restrictions incompatible with persisting leads (confirms we build our own Places adapter).
- **Temporal cluster / Trigger.dev as runtime** — good licenses, wrong weight class; concepts only.

**Not rejected, just not selected** (fine tools; the plan picks one per slot): drizzle-orm + drizzle-kit, node-pg-migrate, graphile-worker, DBOS Transact. Recorded as ADR entries with revisit triggers in `docs/decisions.md`; the bake-off reopens only on new evidence.

## 6. Plan changes

Edits to `docs/implementation-plan.md` this research justifies, on the revised milestone sequence (M0 engine skeleton, M1 harness adapter, M2 minimal UI, M3 local-business, M4 professional + imported, M5 contact enrichment + MiniMax, M6 personal VPS / managed beta):

1. **M0 — stop building:** custom job queue/polling/backoff/scheduler (→ pg-boss, pending the M0 PGlite spike), migration ledger/runner (→ kysely Migrator running the `database-schema.md` DDL), CSV writer (→ csv-stringify), phone parsing/E.164 (→ libphonenumber-js/max), domain-suffix logic (→ tldts), hand-written JSON Schemas (→ zod). The `filter`/`score` grammar stays hand-built: the small typed deterministic operator allowlist (json-rules-engine deferred).
2. **M0 — add and record:** the pg-boss/PGlite `fromPglite` compatibility spike (pg-boss as devDependency only until adoption). Record decisions as ADR entries with revisit triggers in `docs/decisions.md`: Kysely over Drizzle (do not mix); pg-boss over graphile-worker/DBOS pending the spike, with the at-least-once caveat — `run_item_steps.request_key` is the internal replay guard, and provider-side idempotency is documented per paid adapter; pin Node 22 LTS (pg-boss ≥22.12, kysely ≥22, p-retry ≥22); pin exact versions of all pre-1.0 deps (kysely, pg-boss config surface, csv-parse v7).
3. **M1 — stop building:** all MCP protocol/transport code (→ @modelcontextprotocol/sdk v1.29.x, imports confined to `src/mcp/`); the OpenAI Agents SDK acceptance fixture becomes a pinned devDependency test, credential-free in CI. pg-boss adoption activates here behind `JobQueue` if the M0 spike passed. Migrate to MCP SDK v2 only when it is actually stable; the ~2026-07-28 date is a forecast, not a guarantee.
4. **M2 — minimal UI:** no new library adoptions decided by this report; the UI framework/stack is an open ADR decided at M2 planning. The UI calls the same application services and duplicates no business logic.
5. **M3 — local business (first live provider):** website research is the lean fetcher (undici + robots-parser + cheerio + p-queue), not a crawler framework; `run_preview` Places cost estimates computed from the field mask; the shared `src/providers/retry.ts` (p-retry + p-queue house policy) and 429 pause scheduling land here because Places is now the first live rate-limited provider; geo-tz populates `leads.timezone`. Foursquare OS Places stays optional/deferred — a large data/operations commitment, not a trivial adapter.
6. **M4 — professional and imported:** Apollo adapter scoped from the official MCP tool catalog (search/enrich only; outreach tools explicitly out); csv-parse v7 for the imported-list workflow; retry-policy hardening; identity-conflict handling.
7. **M5 — contact enrichment and MiniMax:** phone validation = Twilio Lookup v2 (first candidate) + Telnyx individual adapters (per-signal mapping to `contact_point_checks` is non-negotiable); email verification = ZeroBounce/MillionVerifier benchmark; contact **discovery** = Apollo first, then ONE waterfall meta-provider adapter chosen by the M5 benchmark (BetterContact/FullEnrich/LeadMagic candidates) instead of building N vendor adapters or our own discovery waterfall; free tier-0 checks (libphonenumber, MX/disposable) always precede paid calls; MiniMax adapter joins OpenAI/Anthropic behind the shared model-provider interface.
8. **Docs:** on M0 acceptance, update `docs/architecture.md` per the deviations section of `docs/proposals/database-schema.md`; `docs/decisions.md` is the standing tool-selection registry, with this report as its evidence base.

---

## 7. Integration notes against our actual M0 environment (added post-synthesis)

- **PGlite and pg-boss.** M0's default database is embedded PGlite (`DATABASE_URL=pglite://...`; this machine has no Docker). Current pg-boss supports PGlite through **`fromPglite`** — the earlier claim that pg-boss cannot run on PGlite is withdrawn. Because that support is new, M0 runs the bounded compatibility spike (filesystem persistence; start/stop/restart; job recovery; retry/backoff; duplicate-claim prevention; cancellation; modest concurrency; interaction with application transactions where supported). Keep the planned `JobQueue` seam either way: M0 ships the in-process claim-and-drain driver over the run lease + `run_item_steps`; the pg-boss driver activates at M1 if the spike passes. pg-boss is an M0 devDependency for the spike only, promoted to a runtime dependency at adoption.
- **Kysely on PGlite** is officially supported by current Kysely — the earlier community-shim/custom-dialect claim is withdrawn. Verify the dialect import at M0 setup as a checkbox, not a risk fork. The migration DDL is hand-authored either way (from `docs/proposals/database-schema.md`), so this cannot block M0.
- **Version pins vs current scaffolding.** `package.json` already has zod 4.4.3, pg 8.22, commander 15, PGlite 0.5.4 — consistent with this report. New M0 additions: kysely (exact pin), csv-stringify, libphonenumber-js, tldts, plus pg-boss as the spike-only devDependency. Later, at their milestones and not before: @modelcontextprotocol/sdk and openai-agents (dev) at M1; cheerio, robots-parser, geo-tz, p-retry, p-queue at M3; csv-parse at M4; phone-validation, email-verification, and model-provider SDKs (including MiniMax) at M5.
