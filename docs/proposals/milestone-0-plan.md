# Milestone 0 implementation plan (proposal)

Status: **revised 2026-07-10 per `consolidated-revision-directive.md` — awaiting user approval; do not implement until approved.**
Written 2026-07-10 as a session handoff. Companion documents (read all together):

- `docs/proposals/consolidated-revision-directive.md` — authoritative; supersedes conflicting statements in the other proposals and in this plan.
- `docs/proposals/database-schema.md` — the proposed target data model (proposed until the M0 vertical slice validates it); migration `0001_init` embeds its untagged DDL verbatim (12 domain tables + `schema_migrations`).
- `docs/proposals/build-vs-adopt.md` — tool-selection research; vendor/library decisions carry ADR entries with revisit triggers in `docs/decisions.md`.

Milestone numbering follows the revised sequence: M0 engine skeleton, M1 harness adapter, M2 minimal UI, M3 local-business workflow, M4 professional + imported workflows, M5 contact enrichment + MiniMax, M6 personal VPS/managed beta. M0 scope: no MCP, no UI, no live providers, no model providers.

## Scaffolding audit result (already performed)

Codex's uncommitted scaffolding is config-only and mostly sound (package.json/lockfile/node_modules consistent for darwin-arm64; zod 4, commander 15, pg + PGlite, TS 7.0.2 strict, tsx, ESLint 10). **No application code exists** — no `src/`, `test/`, or migrations, and zero git commits. Confirmed defects to fix during M0:

1. `eslint .` crashes: type-checked rules apply globally but `projectService` covers only `src`/`test` → add `disableTypeChecked` block for JS files; add `exports/`, `.data/`, `.pnpm-store/` to ignores.
2. `tsconfig.json` includes `eslint.config.js` without `allowJs` — dead entry, remove.
3. `src/cli/index.ts` needs `#!/usr/bin/env node` (bin target).
4. Test glob `test/*.test.ts` is flat-only → convention: tests flat, helpers in `test/helpers/`.
5. dotenv 17 prints a stdout banner → load with `quiet: true` (would corrupt `--json` output).
6. `pnpm-workspace.yaml` `allowBuilds:` key must be verified against pnpm 11 docs at first install.
7. Zero commits → make a **baseline commit** of existing scaffolding/docs before implementation, then one reviewed M0 commit after validation.

## Environment (blocker, resolved by plan)

The machine has **no Node, pnpm, Homebrew, or Docker**. Setup (one-time network use; no sudo):
pinned Node v22.17.0 tarball → `~/.local/node`, PATH line in `~/.zshrc`, corepack-activated pnpm@11.7.0 (honors `packageManager`), `pnpm install --frozen-lockfile`, `cp .env.example .env`, commit a `.node-version`. Default DB is embedded PGlite (`pglite://./.data/lead-engine`) — no Docker needed; `pg` driver ships behind the same `Db` interface for `postgresql://` (compose.yaml), parity-tested only when a `TEST_PG_URL` is provided.

## External calls

One-time Node/pnpm download only. Zero provider calls, zero credentials, zero paid actions. Tests are offline (in-memory PGlite, fake fixtures).

## Key design decisions

1. **M0 approval gate = plan hash** (sha256 over workflow-version checksum + inputs + profile + overrides + record cap + budget + estimate). `run preview` prints it; `run start --approval <hash>` recomputes and rejects mismatch. Changing profile/cap/budget invalidates it. M1's signed `approval_tokens` replace it behind an `ApprovalService` interface. Approvals append to `runs.approvals` (never overwritten).
2. **`run_item_steps` ledger** (see schema doc §9): unique (run_item_id, step_id) + attempt-scoped `request_key` + accumulate-on-fail cost protocol = resume marker, retry counter, and **internal replay guard** in one table. `request_key` is not a universal credit-safety guarantee: provider-side idempotency (key acceptance, stable request IDs, reconciliation, whether failures charge, retryable errors, manual-review outcomes) is documented per paid adapter starting M3/M4. A paid-style step whose outcome may have completed but cannot be confirmed is marked `needs_review` and is never auto-retried.
3. **Dedupe**: hard unique only on `(agency_id, source_provider, source_provider_id)`; domain and phone+locality are non-unique lookups resolved in code to `new|matched|conflict`. Conflicts flag (run_items.dedupe_status/skip_reason), never merge.
4. **Contact honesty from day one**: full per-signal contact_points design (schema doc §11); M0 writes only `format_valid` via the normalize step's engine check into append-only `contact_point_checks`.
5. **review_gate** = durable `waiting_review` run state; export executor independently asserts passage (`REVIEW_REQUIRED`). **generate** consults an empty model-provider registry and skips with `model_provider_not_configured` (proves runs complete without a model; real model providers — MiniMax/OpenAI/Anthropic behind one shared interface — arrive M5).
6. **Crash recovery**: run lease (`lease_token`/`lease_expires_at`, atomic conditional UPDATE); `run resume` reclaims stale leases and recomputes position from persisted markers. Budget exhaustion pauses (`credit_cap_reached`) before committing the over-budget charge.
7. **Caps**: `inputs.limit` (≤500) bounds sourcing; `paid_record_cap = min(inputs.limit, 100, --cap)` bounds paid work; both inside the plan hash. quick_list ⇒ cap 0 is legal.

## pg-boss/PGlite compatibility spike (M0 deliverable)

Current pg-boss supports PGlite via `fromPglite`; the support is new, so adoption waits on a bounded spike covering: filesystem persistence; start/stop/restart; job recovery after a killed process; retry/backoff; duplicate-claim prevention; cancellation; modest concurrency; interaction with application transactions where supported. Record the outcome as the pg-boss ADR in `docs/decisions.md` (pending → accepted/rejected). Pass ⇒ pg-boss activates at M1 behind the `JobQueue` interface when real background execution starts; fail ⇒ the in-process driver continues through M1 while an alternative is evaluated (ADR revisit trigger). The spike does not change M0's run executor either way — it stays the in-process claim-and-drain driver — and pg-boss job-delivery guarantees remain distinct from third-party paid-call side effects.

## Dependencies (M0 — updated per directive §13)

Already scaffolded: zod ^4.4.3, commander 15, pg 8.22, @electric-sql/pglite 0.5.4, dotenv 17 (quiet), tsx, TS 7.0.2, ESLint 10.
**Add (runtime):** kysely (exact pin; chosen over drizzle — hand-authored SQL DDL; current Kysely ships **official PGlite dialect support** — verify the dialect import at setup as a checkbox, not a risk fork), csv-stringify, libphonenumber-js (import `/max`), tldts.
**Add (dev, spike only):** pg-boss — used exclusively by the M0 compatibility spike; promoted to a runtime dependency at M1 only if the spike passes.
**Do not add:** json-rules-engine (deferred — the filter/score grammar is a hand-typed operator allowlist, below; reconsider only when real workflow complexity justifies a general rules engine), zod-to-json-schema (archived), ajv, node-pg-migrate, drizzle, crawlee, bottleneck.
**Deferred to milestones:** pg-boss runtime adoption behind `JobQueue` (M1), @modelcontextprotocol/sdk current stable v1.x line (M1), openai-agents-js devDep (M1), p-retry/p-queue (M3 — the local-business provider is the first live rate-limited provider under the new ordering), cheerio/robots-parser/geo-tz (M3), csv-parse + Apollo adapter (M4), phone-validation/email-verification/model-provider SDKs incl. MiniMax (M5).

## File plan (~55 files)

- `src/shared/` — errors (machine codes), checksum (sha256/canonical JSON), clock (injectable).
- `src/config/env.ts` — zod-validated env; provider keys optional.
- `src/storage/` — `Db` interface (PGlite + pg drivers), migration runner (TS-embedded SQL from the schema doc; `schema_migrations` with checksums), repositories (one per aggregate; no UPDATE exposed for workflow_versions or contact_point_checks).
- `src/app/` — application services (workflow management; run preview/start/status/results/cancel; lead review; export). The CLI is a thin adapter over these services; M1 MCP tools and the M2 UI reuse them unchanged — no business logic duplicated per interface.
- `src/engine/workflow-schema/` — zod discriminated union over the 10-step allowlist, hand-typed filter/score rule grammar (serializable JSON conditions over declared typed fields; operators `eq/neq/gt/gte/lt/lte/in/not_in/contains/exists`; points-summing score templates; no eval, no dynamic paths), profile resolution (quick_list/call_ready/full → included steps), plan resolver + hash.
- `src/engine/{records,dedupe,scoring,runner,export}/` — normalization (libphonenumber-js, tldts), identity resolution (new|matched|conflict), deterministic `local-service` scoring template, state machines with exhaustive transition maps (incl. `needs_review`), per-step executors, CSV export via csv-stringify (`escape_formulas`, `bom`, columns whitelist, dataset_checksum rule from schema doc §16).
- `src/providers/` — provider-neutral interfaces + registry; `fake/` places-like source, apollo-like enrich (request_key-deduplicated internal ledger), website research; ~15 fixture businesses covering shared-domain, shared-phone, conflicting-identifier, no-match-survivor, flaky, always-broken, and ambiguous-outcome (possibly completed, unconfirmable) cases.
- `src/jobs/run-worker.ts` — in-process claim-and-drain over run lease + run_item_steps; the `JobQueue` seam pg-boss fills at M1 if the spike passes.
- `spikes/pg-boss-pglite/` — bounded spike scripts + notes (scope above); excluded from the production build.
- `src/cli/` — commander tree over `src/app` services; `--json` envelope `{ok, data, summary, warnings}` (future MCP shape, zero MCP code in M0).
- `examples/` — demo workflow (all 10 step types) + full and quick_list input files.
- `test/` — 21 files (below) + `test/helpers/`.

## CLI surface

`leads db migrate|status` · `workflow create --file|validate|list|show` · `run preview|start --approval <plan-hash>|status|results|review (--approve/--reject, explicit --all)|resume|retry|cancel` · `lead review` · `export csv [--force]`.

## Tests (21 files, offline)

env; db-driver parity; migrations/checksums; schema rejection of invalid/unknown steps + operator-allowlist grammar (unknown operators and dynamic paths rejected); version immutability; provider contract tests (anchor for the M3 Places and M4 Apollo adapters); normalization; identity/dedupe incl. never-merge; deterministic scoring; exhaustive state-transition matrices incl. `needs_review`; profile resolution (quick_list = zero cost rows, still exports); happy-path runner; crash-resume exactly-once (fault before/after commit); credit gate + pause + re-approval; bounded retries incl. ambiguous outcome → `needs_review`, never auto-retried; review-gate bypass attempts; generate-disabled completion; contact-point never-overwrite/append-only; plan-hash invalidation; CSV format/idempotency; subprocess E2E proving persistence across process exits (`migrate → create → preview → start → (exit) → status → review → results → export`).
The pg-boss spike suite lives under `spikes/` and runs separately from `pnpm check`.
Validation: `pnpm check` (lint + typecheck + test + build) + README demo flow + spike run.

## Decisions locked as defaults (user may override at approval)

1. CSV: RFC 4180 CRLF + formula neutralization ON.
2. Runs with failed items finish `completed` + visible failed count + `run retry` (no separate status).
3. If TS 7.0.2 breaks tooling: fallback is pinning typescript@5.9.x — **ask the user before downgrading** (needs network).
4. quick_list still passes review_gate.
5. Agencies seeded now; users deferred to M1.
6. `workflow create` is file-only in M0; `--template` names arrive with the live workflow templates (M3/M4).

## Risks

TS 7.0.2 (native compiler) with tsx/typescript-eslint unverified until Node exists — run `pnpm build`/`pnpm lint` first. `request_key` is the internal replay guard only; the fake provider proves the mechanism, not any provider-side contract — the per-adapter idempotency questionnaire lands with the first paid adapters (M3/M4). pg-boss `fromPglite` support is new and may fail the spike; fallback is keeping the in-process driver through M1 while alternatives are evaluated. `pg`-driver path untested without Docker (gated suite exists).

## On completion, report

(1) what changed, (2) why, (3) exact validation results incl. the CLI demo flow, (4) migrations/config required, (5) remaining risks + proposed Milestone 1 plan. Record the pg-boss spike outcome as an ADR entry in `docs/decisions.md`, update `docs/architecture.md` per the deviations section of the schema doc, move accepted proposals out of proposals/ status, and make the two git commits (baseline, then reviewed M0).
