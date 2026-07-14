# Finalized database schema (proposal)

Status: **accepted at Milestone 0 (2026-07-11)** — the untagged DDL below is applied verbatim as migration `0001_init` (12 domain tables + `schema_migrations`) and validated by the M0 vertical slice; `docs/architecture.md` references this document. Items tagged M1/M3/M4/M5/M6 remain proposed for their milestones. Revised 2026-07-10 per `consolidated-revision-directive.md`.

Everything **untagged** lands in migration `0001_init` (Milestone 0). Tables and columns tagged **M1/M3/M4/M5** land in the additive migration for that milestone, under the revised sequence: M0 engine skeleton, M1 harness adapter, M2 minimal UI (no migration), M3 local-business workflow, M4 professional + imported workflows, M5 contact enrichment + MiniMax assistance, M6 personal VPS / managed beta (credentials/auth sketch only). Nothing post-0001 requires a rewrite or backfill of typed data.

This model was produced from the Milestone 0 design plan, then adversarially audited by four independent reviews (contact-validation semantics, approvals/idempotency, identity/provenance, Postgres engineering) against `docs/product-requirements.md`, `docs/architecture.md`, `docs/workflows.md`, and `docs/implementation-plan.md`. All 26 findings were accepted; the resolution table is at the end. Revised 2026-07-10 per the consolidated revision directive: milestone re-tags, a `needs_review` step status, an extended `attempt_costs` entry shape, softened double-spend claims, and renumbered migration staging. The audit content otherwise stands.

## Design rules

1. **Typed columns + small JSONB.** Canonical facts get ordinary typed columns. JSONB is reserved for small, bounded, documented-shape metadata. No entity/attribute system; a repository-layer size guard (~8 KB) and a test keep raw provider payloads out of `run_items.snapshot` and `run_item_steps.result`.
2. **`text` + `CHECK`, never Postgres enums.** Vocabularies match the requirements documents exactly; extending one is a cheap `CHECK` swap, not `ALTER TYPE`.
3. **Append-only history.** `contact_point_checks`, `runs.approvals` entries, `run_item_steps.attempt_costs`, and `generated_outputs` are never updated or deleted — with one carve-out: reconciling an ambiguous `attempt_costs` entry fills that entry's `classification`/`reconciledAt` (§9), the single permitted amendment. "Current best" is denormalized with per-signal freshness and attribution, never by overwriting history. Suppression release is a column update, never a `DELETE`.
4. **PG16-compatible SQL only** (`gen_random_uuid()`, partial unique indexes, `ON CONFLICT`), so PGlite (embedded) and the compose Postgres 16 run identical DDL.
5. **`uuid` PKs, `timestamptz` for all times, `numeric(12,4)` for credits, `numeric(5,4)` for confidences.**
6. **Identity lives on `leads`, agency-scoped.** Strong identifiers get partial unique indexes; weak identifiers (domain, phone+locality) get **non-unique** lookup indexes resolved in code to `new | matched | conflict`, because hard uniqueness on a shared line or shared website would force-merge distinct businesses, which the docs prohibit. Conflicts are flagged, never auto-merged, never merged on name alone.
7. **Idempotency is structural — internally.** Every retryable write path has a unique constraint or stored key that makes replay an upsert/no-op, and every paid attempt is costed even when it fails. Internal idempotency does not guarantee provider-side idempotency; each paid adapter documents its own provider-side contract (§9).
8. **Deletes.** Run/audit-bearing rows use `ON DELETE RESTRICT` (runs are not deleted in the MVP). Lead-owned detail (`lead_sources`, `contact_points`, `contact_point_checks`, `generated_outputs`) cascades from `leads`, which is the data-deletion control; run history keeps `SET NULL` references.

---

## 1. `agencies`

Minimal owner/team boundary. No billing, RBAC, or SSO. Milestone 0 seeds one fixed-UUID default agency.

```sql
CREATE TABLE agencies (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  metadata    jsonb NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
```

Indexes: PK only.

---

## 2. `users` — **M1**

Operator identity, introduced with authenticated transports. M0 records actors as free text (`'cli'`, later `'mcp:<client>'`); M1 promotes attribution to this table without reinterpreting M0 data.

```sql
CREATE TABLE users (                                            -- M1
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id     uuid NOT NULL REFERENCES agencies(id) ON DELETE RESTRICT,
  email         text NOT NULL,
  display_name  text NULL,
  role          text NOT NULL DEFAULT 'owner'
                CHECK (role IN ('owner','member')),
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX users_email_uq ON users (lower(email));
-- WHY: one operator identity per address; case-insensitive login key.
```

---

## 3. `workflows`

Workflow identity and its editable draft. Versions are separate and immutable.

```sql
CREATE TABLE workflows (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id        uuid NOT NULL REFERENCES agencies(id) ON DELETE RESTRICT,
  slug             text NOT NULL,          -- human-readable CLI/MCP handle, e.g. 'local-service-leads'
  name             text NOT NULL,
  description      text NULL,
  draft_definition jsonb NOT NULL DEFAULT '{}',
  archived_at      timestamptz NULL,
  created_by       uuid NULL REFERENCES users(id) ON DELETE SET NULL,   -- M1
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX workflows_agency_slug_uq
  ON workflows (agency_id, slug) WHERE archived_at IS NULL;
-- WHY: one active workflow per handle; archiving frees the handle without renaming history.
```

---

## 4. `workflow_versions`

Immutable validated configuration. Step types are validated at the application layer against the allowlist (`source`, `normalize`, `dedupe`, `enrich`, `filter`, `research`, `score`, `generate`, `review_gate`, `export`); a run pins one version forever. Immutability is by construction: the repository exposes no UPDATE (tested).

```sql
CREATE TABLE workflow_versions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id uuid NOT NULL REFERENCES workflows(id) ON DELETE RESTRICT,
  version     integer NOT NULL CHECK (version >= 1),
  definition  jsonb NOT NULL,
  checksum    text NOT NULL,
  created_by  uuid NULL REFERENCES users(id) ON DELETE SET NULL,        -- M1
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workflow_id, version)
);
-- WHY unique: version numbering is the immutability contract; re-validating the
-- same draft targets the same version, never forks it.
```

---

## 5. `leads`

Canonical business/person record and the **only** home of identity keys. A business with no owner, contact, or Apollo match is a complete, valid row. Identity uniqueness is agency-scoped (two agencies may independently hold the same CEO).

```sql
CREATE TABLE leads (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id               uuid NOT NULL REFERENCES agencies(id) ON DELETE RESTRICT,
  kind                    text NOT NULL CHECK (kind IN ('business','person')),
  display_name            text NOT NULL,
  first_name              text NULL,
  last_name               text NULL,
  title                   text NULL,
  employer_lead_id        uuid NULL REFERENCES leads(id) ON DELETE SET NULL,
  category                text NULL,
  website_url             text NULL,
  address_line            text NULL,
  locality                text NULL,
  region                  text NULL,
  country                 text NULL,
  timezone                text NULL,                                    -- M3 (IANA id, e.g. 'America/Chicago')
  normalized_domain       text NULL,
  normalized_phone        text NULL
                          CHECK (normalized_phone IS NULL
                                 OR normalized_phone ~ '^\+[1-9][0-9]{1,14}$'),
  source_provider         text NULL,
  source_provider_id      text NULL,
  place_id                text NULL,                                    -- M3
  apollo_person_id        text NULL,                                    -- M4
  apollo_organization_id  text NULL,                                    -- M4
  normalized_linkedin_url text NULL,                                    -- M4
  verified_email          text NULL,                                    -- M4 (set ONLY when a check returned 'valid')
  metadata                jsonb NOT NULL DEFAULT '{}',
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);
```

Notes:

- `source_provider` / `source_provider_id` is the **provider-neutral discovery identity** — which provider first produced this lead and under what stable ID. It works unchanged for the M0 fake provider, Places, and Apollo. The provider-specific typed columns (`place_id`, `apollo_*`) are **cross-provider identity keys** added when their adapters land, so one lead can later hold both a Places ID and an Apollo organization ID.
- `employer_lead_id` links a person to their `kind = 'business'` employer from M0, so the M4 executive workflow never needs a lossy re-key. The kind restriction is enforced at the repository layer and by test (a DB trigger is optional hardening; cross-row `CHECK` cannot express it).
- Rating/review metadata from local-business sources is **not** a typed column here: it lives in `lead_sources.snapshot` under the provider's storage policy (M3 expiry applies) and is exported from the latest snapshot.

Indexes / uniques:

```sql
CREATE UNIQUE INDEX leads_source_identity_uq
  ON leads (agency_id, source_provider, source_provider_id)
  WHERE source_provider_id IS NOT NULL;
-- WHY: business identity #1 (provider/place ID). The only hard identity constraint
-- in M0; backs ON CONFLICT replay safety for every source step.

CREATE INDEX leads_domain_ix
  ON leads (agency_id, normalized_domain) WHERE normalized_domain IS NOT NULL;
-- Deliberately NON-unique: multi-location businesses legitimately share one website.
-- Dedupe resolves matches in code to new|matched|conflict.

CREATE INDEX leads_phone_locality_ix
  ON leads (agency_id, normalized_phone, locality) WHERE normalized_phone IS NOT NULL;
-- Deliberately NON-unique: shared lines (franchise call centers, virtual offices,
-- shared reception) must surface as a conflict to flag, not a constraint violation
-- that blocks or merges a legitimate second business.

-- M4:
CREATE UNIQUE INDEX leads_apollo_person_uq
  ON leads (agency_id, apollo_person_id) WHERE apollo_person_id IS NOT NULL;        -- person identity #1
CREATE UNIQUE INDEX leads_linkedin_uq
  ON leads (agency_id, normalized_linkedin_url) WHERE normalized_linkedin_url IS NOT NULL;
  -- person identity #2 (URL supplied by Apollo/import only — never scraped)
CREATE UNIQUE INDEX leads_verified_email_uq
  ON leads (agency_id, verified_email) WHERE verified_email IS NOT NULL;            -- person identity #3
CREATE UNIQUE INDEX leads_apollo_org_uq
  ON leads (agency_id, apollo_organization_id)
  WHERE apollo_organization_id IS NOT NULL AND kind = 'business';

-- M3:
CREATE UNIQUE INDEX leads_place_uq
  ON leads (agency_id, place_id) WHERE place_id IS NOT NULL;
```

Strong identifiers (provider IDs, LinkedIn URL, verified email) are 1:1 by nature, so a collision means "same entity" (match) or a data error (conflict) — the second lead can still exist with the identifier left NULL while the conflict is flagged. Weak identifiers (domain, phone+locality) collide legitimately between distinct entities, so they must never be hard-unique. Verified-email uniqueness is enforced **here**, not on `contact_points`, so multiple providers can each record the same address without overwriting each other.

---

## 6. `runs`

One execution of one immutable workflow version: inputs, profile, overrides, approvals, budget, and state.

```sql
CREATE TABLE runs (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id             uuid NOT NULL REFERENCES agencies(id) ON DELETE RESTRICT,
  workflow_version_id   uuid NOT NULL REFERENCES workflow_versions(id) ON DELETE RESTRICT,
  inputs                jsonb NOT NULL,
  enrichment_profile    text NOT NULL
                        CHECK (enrichment_profile IN ('quick_list','call_ready','full')),
  overrides             jsonb NOT NULL DEFAULT '{}',
  resolved_plan         jsonb NOT NULL,   -- the exact steps/estimates shown at preview
  plan_hash             text NOT NULL,    -- sha256 over (version checksum, inputs, profile,
                                          -- overrides, cap, budget, estimate); the M0 approval value
  status                text NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','running','waiting_review','paused',
                                          'completed','failed','cancelled')),
  pause_reason          text NULL
                        CHECK (pause_reason IN ('credit_cap_reached','rate_limited','operator')),
  resume_at             timestamptz NULL,                               -- M3 (set from Retry-After on 429 pause; lands with the first live rate-limited provider)
  cancel_requested      boolean NOT NULL DEFAULT false,
  paid_record_cap       integer NOT NULL DEFAULT 0
                        CHECK (paid_record_cap BETWEEN 0 AND 100),
  credit_limit          numeric(12,4) NOT NULL DEFAULT 0 CHECK (credit_limit >= 0),
  credits_used          numeric(12,4) NOT NULL DEFAULT 0 CHECK (credits_used >= 0),
  approvals             jsonb NOT NULL DEFAULT '[]',
  step_progress         jsonb NOT NULL DEFAULT '{}',   -- run-scoped step markers (bounded)
  review_gate_passed_at timestamptz NULL,
  review_gate_actor     text NULL,
  lease_token           uuid NULL,
  lease_expires_at      timestamptz NULL,
  last_error            jsonb NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  started_at            timestamptz NULL,
  completed_at          timestamptz NULL
);

CREATE INDEX runs_status_resume_ix ON runs (status, resume_at);  -- M3, with resume_at (due auto-resume / status polling)
CREATE INDEX runs_workflow_version_ix ON runs (workflow_version_id);
```

Semantics:

- `paid_record_cap = 0` is the legal value for profiles enabling no paid steps (quick_list). `credit_limit = 0` means no paid budget; "unlimited" is unrepresentable.
- `approvals` is an **append-only array**; documented entry shape:
  `{id, planHash, profile, overrides, paidRecordCap, creditLimit, estimatedPaidActions: [{stepId, provider, count, costPerRecord}], approvedAt, source, expiresAt, consumedAt}`.
  `id/expiresAt/consumedAt` are nullable in M0 and forward-compatible with the M1 `approval_tokens` model. Engine-side verification at claim time compares profile **and overrides** and cap and budget against the latest entry — changing any of them invalidates the approval and requires a new preview.
- `credits_used` is maintained transactionally and reconcilable against `SUM(run_item_steps.cost_units)`; a test asserts they agree.
- `lease_token`/`lease_expires_at`: single-driver invariant. Claiming a run is one atomic conditional UPDATE; a crashed process leaves a stale lease that `run resume` reclaims.
- Review-gate passage is typed (`review_gate_passed_at`/`review_gate_actor`) from M0 so M1 actor attribution needs no jsonb reinterpretation. The export executor independently asserts it (`REVIEW_REQUIRED`).

---

## 7. `approval_tokens` — **M1**

Durable registry making "missing, expired, changed, or already-consumed" rejections real. Exists **before** any run row (preview precedes `run_start`); consumption is atomic.

```sql
CREATE TABLE approval_tokens (                                   -- M1
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id              uuid NOT NULL REFERENCES agencies(id) ON DELETE RESTRICT,
  workflow_version_id    uuid NOT NULL REFERENCES workflow_versions(id) ON DELETE RESTRICT,
  nonce                  text NOT NULL,
  scope_hash             text NOT NULL,   -- binds preview plan, profile, overrides, cap, budget, estimated actions
  enrichment_profile     text NOT NULL
                         CHECK (enrichment_profile IN ('quick_list','call_ready','full')),
  overrides              jsonb NOT NULL DEFAULT '{}',
  paid_record_cap        integer NOT NULL CHECK (paid_record_cap BETWEEN 0 AND 100),
  credit_limit           numeric(12,4) NOT NULL DEFAULT 0 CHECK (credit_limit >= 0),
  estimated_paid_actions jsonb NOT NULL DEFAULT '[]',
  issued_by              uuid NULL REFERENCES users(id) ON DELETE SET NULL,
  issued_at              timestamptz NOT NULL DEFAULT now(),
  expires_at             timestamptz NOT NULL,
  consumed_at            timestamptz NULL,
  consumed_by_run_id     uuid NULL REFERENCES runs(id) ON DELETE SET NULL,
  UNIQUE (nonce)
);
-- Consumption: UPDATE ... SET consumed_at = now(), consumed_by_run_id = $run
--   WHERE nonce = $n AND consumed_at IS NULL AND expires_at > now();
-- zero rows updated => reject. Changing profile/overrides/cap/budget changes
-- scope_hash, invalidating the token. A Quick List approval can never start Call-Ready.
```

---

## 8. `run_items`

Per-lead membership and state within a run. The same lead attaches to many runs; per-run state never clobbers another run's state.

```sql
CREATE TABLE run_items (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id                 uuid NOT NULL REFERENCES runs(id) ON DELETE RESTRICT,
  lead_id                uuid NULL REFERENCES leads(id) ON DELETE SET NULL,
  source_key             text NOT NULL,   -- provider-stable key of the sourced record
  position               integer NOT NULL CHECK (position >= 1),
  status                 text NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending','in_progress','completed','failed','skipped')),
  skip_reason            text NULL
                         CHECK (skip_reason IN ('filtered','identity_conflict')),
  dedupe_status          text NULL
                         CHECK (dedupe_status IN ('new','matched','conflict')),
  current_step_id        text NULL,
  score                  numeric(6,2) NULL,
  review_status          text NOT NULL DEFAULT 'unreviewed'
                         CHECK (review_status IN ('unreviewed','approved','rejected','regenerate')),
  reviewed_at            timestamptz NULL,
  review_actor           text NULL,
  call_readiness_status  text NULL
                         CHECK (call_readiness_status IN
                                ('ready','uncertain','invalid','suppressed','unchecked')),   -- M5
  call_readiness_reason  text NULL,                                                          -- M5
  snapshot               jsonb NOT NULL DEFAULT '{}',   -- bounded in-flight working data ONLY
  last_error             jsonb NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, source_key),
  UNIQUE (run_id, position)
);

CREATE UNIQUE INDEX run_items_run_lead_uq
  ON run_items (run_id, lead_id) WHERE lead_id IS NOT NULL;
-- WHY: "Duplicate -> attach the existing lead to the new run" is an idempotent
-- upsert; a retried dedupe step cannot attach the same lead twice.

CREATE INDEX run_items_run_status_ix ON run_items (run_id, status);
CREATE INDEX run_items_run_review_ix ON run_items (run_id, review_status);
```

Semantics:

- `UNIQUE (run_id, source_key)` is the crash-replay guard: re-running a partially committed source step upserts via `ON CONFLICT`, never duplicates.
- `position` is assigned from a per-run monotonic counter inside the insert transaction (safe under the single-lease writer), **never** from provider ordinal — shifted provider pagination on resume cannot collide. Results order by `(position, id)`.
- Canonical facts live on `leads`/`contact_points`; `snapshot` holds only bounded working data (size-guarded, tested).
- `call_readiness_status` (M5): `NULL` = the contact-check policy step never ran; `'unchecked'` = it ran but the requested compliance review was not performed. The two are never conflated, and neither is ever rendered as cleared.
- `updated_at` is maintained on every review write — it feeds export staleness detection (§16).

---

## 9. `run_item_steps`

Per-(item, step) execution ledger: attempts, idempotency key, and the **complete** cost record including charged-but-failed attempts. `request_key` is the engine's **internal replay guard** — necessary but not sufficient. Provider-side idempotency is a separate, per-adapter documented contract (below), and a possibly-completed paid call is never auto-retried.

```sql
CREATE TABLE run_item_steps (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_item_id     uuid NOT NULL REFERENCES run_items(id) ON DELETE RESTRICT,
  step_id         text NOT NULL,
  status          text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','running','completed','failed',
                                    'needs_review','skipped')),
  skip_reason     text NULL,               -- e.g. 'model_provider_not_configured', 'profile_excluded'
  attempts        integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  request_key     text NOT NULL,
  cost_units      numeric(12,4) NOT NULL DEFAULT 0 CHECK (cost_units >= 0),
  attempt_costs   jsonb NOT NULL DEFAULT '[]',
                  -- append-only; entry shape: {attempt, requestKey, providerRequestId,
                  -- cost, at, outcome, classification, reconciledAt} with classification
                  -- IN (completed, failed_charged, failed_uncharged, ambiguous)
  result          jsonb NOT NULL DEFAULT '{}',   -- references/summaries only, never raw payloads
  last_error      jsonb NULL,
  next_attempt_at timestamptz NULL,                                    -- M3
  started_at      timestamptz NULL,
  completed_at    timestamptz NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_item_id, step_id),
  UNIQUE (request_key)
);

CREATE INDEX run_item_steps_due_ix ON run_item_steps (status, next_attempt_at);  -- M3
```

Semantics:

- `UNIQUE (run_item_id, step_id)`: one ledger row per item-step; retries mutate this row, never fork it. Claim = `INSERT ... ON CONFLICT DO NOTHING` + guarded UPDATE (`status IN ('pending','failed') AND attempts < max`). `needs_review` is deliberately not claimable. Completion, cost, and domain effects commit in one transaction.
- `request_key` is **attempt-scoped and persisted at claim time** (`{runId}:{stepId}:{itemId}:{attempt}`): crash-resume reuses the **stored** value, so the same attempt dedupes at the provider *where the provider supports it*; an explicit `failed -> pending` requeue rotates it, so a genuine retry after a recorded failure is never served from a stale cache. Whether a provider actually honors the key is documented per adapter (below), not assumed.
- **Cost protocol:** every charged provider call appends to `attempt_costs` and accumulates `cost_units` on the `running -> completed`, `running -> failed`, **and** `running -> needs_review` transitions (an ambiguous attempt is provisionally costed at its estimate until reconciliation records the actual charge). The budget gate (`credits_used + next_estimated_cost <= credit_limit`, checked before each paid item) therefore includes failed and ambiguous spend — "stop before the next paid item, keep partial results" holds against real spend, and the run pauses with `pause_reason = 'credit_cap_reached'` before committing an over-budget charge.
- **`needs_review` (ambiguous provider outcome):** when a paid request may have completed but the provider cannot confirm the outcome (send-side timeout, ambiguous error), the step moves `running -> needs_review` with an `attempt_costs` entry of `classification = 'ambiguous'`. It is **never auto-retried** — retrying a possibly-completed paid call risks paying twice. Reconciliation (operator or provider-status check) fills that entry's `classification`/`reconciledAt` — the single permitted amendment to the otherwise append-only ledger — then completes the step or requeues it `failed -> pending`, rotating `request_key`.
- **Per-adapter provider-side contract (documented with the first paid adapters, M3/M4):** for every paid provider adapter, document whether it accepts an idempotency key, whether it returns a stable request ID, whether ambiguous requests can be reconciled, whether failures consume credits, which errors are retryable, and which outcomes land in `needs_review`.

---

## 10. `lead_sources`

Provider retrieval provenance: durable identifier, request ID, and the policy-scoped snapshot. The durable identifier is a **typed column outside the purgeable payload**, so provider cache-expiry purges (M3, Google Places policy) never destroy identity or indexability.

```sql
CREATE TABLE lead_sources (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id             uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  run_id              uuid NULL REFERENCES runs(id) ON DELETE SET NULL,
  run_item_id         uuid NULL REFERENCES run_items(id) ON DELETE SET NULL,
  provider            text NOT NULL,
  provider_record_id  text NULL,
  request_id          text NULL,           -- provider request ID for support/audit
  retrieved_at        timestamptz NOT NULL DEFAULT now(),
  snapshot            jsonb NOT NULL DEFAULT '{}',   -- permitted source fields only
  snapshot_expires_at timestamptz NULL,                                 -- M3 (policy-driven; NULL = no expiry)
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX lead_sources_provider_record_uq
  ON lead_sources (provider, provider_record_id, lead_id)
  WHERE provider_record_id IS NOT NULL;
-- WHY: a re-fetch of the same provider record for the same lead upserts
-- (refreshes snapshot/retrieved_at/request_id) instead of duplicating rows —
-- and satisfies provider freshness/storage policies by not hoarding stale copies.

CREATE INDEX lead_sources_lead_ix ON lead_sources (lead_id);
```

The M3 compliance job purges/refreshes expired `snapshot` content **without touching** `provider`, `provider_record_id`, or `retrieved_at`; `place_id` is mirrored onto `leads.place_id` for identity. Rating/review metadata lives here (policy-scoped), not as typed lead columns.

---

## 11. `contact_points`

Every discovered phone/email with role, source, and **per-signal** current-best status. One provider's result never overwrites another's — the same value from a second provider is a second row.

```sql
CREATE TABLE contact_points (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id                   uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  type                      text NOT NULL CHECK (type IN ('phone','email')),
  role                      text NOT NULL,
  raw_value                 text NOT NULL,
  normalized_value          text NULL,
  source_provider           text NOT NULL,
  source_run_item_id        uuid NULL REFERENCES run_items(id) ON DELETE SET NULL,
  source_metadata           jsonb NOT NULL DEFAULT '{}',
  confidence                numeric(5,4) NULL CHECK (confidence BETWEEN 0 AND 1),
  -- shared syntax signal (phone parse / email syntax) — NOT deliverability, NOT reachability
  format_valid              boolean NULL,
  format_checked_at         timestamptz NULL,
  -- phone-only current-best signals, each with its own freshness + attribution
  line_type                 text NULL
                            CHECK (line_type IN ('landline','mobile','voip','toll_free','unknown')),
  line_type_checked_at      timestamptz NULL,
  line_type_provider        text NULL,
  line_status               text NULL
                            CHECK (line_status IN ('active','inactive','unreachable','unknown')),
  line_status_checked_at    timestamptz NULL,
  line_status_provider      text NULL,
  identity_match            text NULL
                            CHECK (identity_match IN ('business_match','person_match','mismatch','unknown')),
  identity_match_checked_at timestamptz NULL,
  identity_match_provider   text NULL,
  -- email-only current-best signal
  email_status              text NULL
                            CHECK (email_status IN ('valid','invalid','catch_all','unknown',
                                                    'role_based','not_checked')),
  email_status_checked_at   timestamptz NULL,
  email_status_provider     text NULL,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT contact_points_role_by_type_ck CHECK (
    (type = 'phone' AND role IN ('business_main','direct','mobile','toll_free','unknown'))
    OR (type = 'email' AND role IN ('work','personal','unknown'))
  ),
  CONSTRAINT contact_points_signals_by_type_ck CHECK (
    (type = 'phone'
      AND email_status IS NULL AND email_status_checked_at IS NULL AND email_status_provider IS NULL)
    OR
    (type = 'email'
      AND email_status IS NOT NULL
      AND line_type IS NULL AND line_type_checked_at IS NULL AND line_type_provider IS NULL
      AND line_status IS NULL AND line_status_checked_at IS NULL AND line_status_provider IS NULL
      AND identity_match IS NULL AND identity_match_checked_at IS NULL AND identity_match_provider IS NULL)
  ),
  CONSTRAINT contact_points_phone_e164_ck CHECK (
    type <> 'phone' OR normalized_value IS NULL OR normalized_value ~ '^\+[1-9][0-9]{1,14}$'
  ),
  CONSTRAINT contact_points_email_norm_ck CHECK (
    type <> 'email' OR normalized_value IS NULL OR normalized_value = lower(btrim(normalized_value))
  ),
  CONSTRAINT contact_points_format_pair_ck CHECK (
    (format_valid IS NULL) = (format_checked_at IS NULL)),
  CONSTRAINT contact_points_line_type_pair_ck CHECK (
    (line_type IS NULL) = (line_type_checked_at IS NULL)
    AND (line_type IS NULL) = (line_type_provider IS NULL)),
  CONSTRAINT contact_points_line_status_pair_ck CHECK (
    (line_status IS NULL) = (line_status_checked_at IS NULL)
    AND (line_status IS NULL) = (line_status_provider IS NULL)),
  CONSTRAINT contact_points_identity_pair_ck CHECK (
    (identity_match IS NULL) = (identity_match_checked_at IS NULL)
    AND (identity_match IS NULL) = (identity_match_provider IS NULL)),
  CONSTRAINT contact_points_email_not_checked_ck CHECK (
    email_status IS NULL OR ((email_status = 'not_checked') = (email_status_checked_at IS NULL))
  )
);

CREATE UNIQUE INDEX contact_points_value_per_provider_uq
  ON contact_points (lead_id, type, normalized_value, source_provider)
  WHERE normalized_value IS NOT NULL;
-- WHY: retried enrichment steps upsert instead of duplicating, while different
-- providers may each hold the same value as separate rows (never-overwrite rule).
-- Deliberately NOT unique on value alone.

CREATE INDEX contact_points_lead_ix ON contact_points (lead_id, type, role);
```

Semantics:

- `normalized_value`: **phone = E.164** (constraint-enforced; dedupe and M5 suppression matching key on this guaranteed form), **email = lowercased/trimmed**. Email rows are inserted with `email_status = 'not_checked'` — the single representation of "unchecked" (the type-scoped CHECK makes it NOT NULL for email rows).
- `format_valid` is a **syntax** signal for both types: a parseable phone or well-formed address. It never implies deliverability, reachability, or identity. Deliverability lives in `email_status`/`line_status`, each with its own provider and timestamp.
- Each signal carries its own `*_checked_at` (+ `*_provider` for provider-performed checks) — a January format check and a June line-type check are never blended into one misleading timestamp. **No export may print a signal without its own checked-at and provider.** A row with only `format_valid = true` is never labeled "verified".
- `line_type = 'landline'` with `role = 'business_main'` expresses the PRD's "business landline": role carries business-ness, line type carries the carrier-level fact.
- The Places main number arrives as `role = 'business_main'`, `source_provider = 'places'`; later Call-Ready checks add signal values and check rows **without replacing the original source value** — the Quick List → Call-Ready continuation is additive by construction.
- M0 writes only `format_valid`/`format_checked_at` (engine check); all other signals stay NULL until M5 validation adapters run.

---

## 12. `contact_point_checks`

Append-only validation history: exactly what was checked, by whom, when, at what cost. Never updated, never deleted (the repository exposes no UPDATE/DELETE; tested).

```sql
CREATE TABLE contact_point_checks (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_point_id  uuid NOT NULL REFERENCES contact_points(id) ON DELETE CASCADE,
  method            text NOT NULL
                    CHECK (method IN ('format','line_type','line_status',
                                      'identity_match','email_deliverability')),
  provider          text NOT NULL,
  result            text NOT NULL,        -- normalized vocabulary of the corresponding signal column
  detail            jsonb NOT NULL DEFAULT '{}',   -- raw provider values live here, never in contact_points
  confidence        numeric(5,4) NULL CHECK (confidence BETWEEN 0 AND 1),
  request_id        text NULL,
  run_item_step_id  uuid NULL REFERENCES run_item_steps(id) ON DELETE SET NULL,
  cost_units        numeric(12,4) NOT NULL DEFAULT 0 CHECK (cost_units >= 0),
  checked_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX cpc_contact_point_ix
  ON contact_point_checks (contact_point_id, method, checked_at DESC);
-- WHY: "latest row per method" is the authoritative definition of current-best;
-- the denormalized contact_points signals are a projection of this query and are
-- reconcilable against it (tested).
```

M0's only writer is the normalize step's `method = 'format'` engine check, structurally locking in "format-checked is never verified" before any real validation provider exists.

---

## 13. `identity_conflicts` — **M4**

Durable record for "flag, do not merge automatically". Designed now; lands with the first real cross-provider dedupe (Apollo, M4). In M0, conflicts are flagged on `run_items` (`dedupe_status = 'conflict'`, `skip_reason = 'identity_conflict'`) with the offending identifiers in the bounded `snapshot`.

```sql
CREATE TABLE identity_conflicts (                                -- M4
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id_a        uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  lead_id_b        uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  identifier_type  text NOT NULL
                   CHECK (identifier_type IN ('source_provider_id','apollo_person_id',
                                              'apollo_organization_id','normalized_linkedin_url',
                                              'verified_email','place_id','normalized_domain',
                                              'normalized_phone_locality')),
  identifier_value text NOT NULL,
  run_id           uuid NULL REFERENCES runs(id) ON DELETE SET NULL,
  detected_at      timestamptz NOT NULL DEFAULT now(),
  status           text NOT NULL DEFAULT 'open'
                   CHECK (status IN ('open','resolved_merged','resolved_distinct')),
  resolved_by      text NULL,
  resolved_at      timestamptz NULL,
  CONSTRAINT identity_conflicts_ordered_ck CHECK (lead_id_a < lead_id_b),
  UNIQUE (lead_id_a, lead_id_b, identifier_type, identifier_value)
);
-- WHY unique: a retried enrich/dedupe step re-raises the same conflict as a
-- no-op, never a duplicate flag (lead_id_a < lead_id_b canonicalizes the pair).
```

---

## 14. `suppressions` — **M5**

Entity-specific do-not-contact list, agency-scoped, durable across lead deletion (it stores normalized values, not FKs). Applied before **every** call-ready export. Release preserves the row.

```sql
CREATE TABLE suppressions (                                      -- M5
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id        uuid NOT NULL REFERENCES agencies(id) ON DELETE RESTRICT,
  scope            text NOT NULL CHECK (scope IN ('phone','email','domain','lead')),
  normalized_value text NOT NULL,   -- E.164 / lowercased email / normalized domain / lead uuid as text
  reason           text NOT NULL,
  requested_by     text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  released_at      timestamptz NULL,
  released_by      text NULL,
  CONSTRAINT suppressions_release_pair_ck CHECK ((released_at IS NULL) = (released_by IS NULL))
);

CREATE UNIQUE INDEX suppressions_active_uq
  ON suppressions (agency_id, scope, normalized_value) WHERE released_at IS NULL;
-- WHY: makes "applied before every export" a cheap deterministic join on the same
-- normalized forms contact_points guarantees (E.164 / lowercase). Re-suppressing
-- after a release creates a new row, preserving the audit trail. Releases are
-- UPDATE, never DELETE.
```

---

## 15. `generated_outputs`

Append-only structured scoring/AI outputs with prompt version and evidence references. Regeneration appends; latest wins by `created_at`.

```sql
CREATE TABLE generated_outputs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id         uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  run_id          uuid NOT NULL REFERENCES runs(id) ON DELETE RESTRICT,
  run_item_id     uuid NULL REFERENCES run_items(id) ON DELETE SET NULL,
  kind            text NOT NULL
                  CHECK (kind IN ('score_rationale','fit_summary','opener')),
  prompt_version  text NOT NULL,
  model_provider  text NULL,        -- NULL for deterministic score rationale; 'minimax'/'openai'/'anthropic' in M5
  model           text NULL,
  content         jsonb NOT NULL,
  evidence        jsonb NOT NULL DEFAULT '[]',  -- [{leadSourceId|contactPointId, field}] — persisted fields only
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX generated_outputs_latest_ix
  ON generated_outputs (run_id, lead_id, kind, created_at DESC);
```

`score_rationale` holds the deterministic scoring explanation from M0 (the score itself lives on `run_items.score`); `fit_summary`/`opener` arrive with the M5 model providers. Evidence entries must reference persisted rows; the generate step validates this before accepting output (grounding rule — unsupported claims cannot enter outputs).

---

## 16. `exports`

CSV (later CRM) materialization with request-level identity **and** result-set-level correctness.

```sql
CREATE TABLE exports (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id           uuid NOT NULL REFERENCES runs(id) ON DELETE RESTRICT,
  kind             text NOT NULL CHECK (kind IN ('csv')),
  filters          jsonb NOT NULL DEFAULT '{}',
  filters_checksum text NOT NULL,
  dataset_checksum text NULL,      -- sha256 over the ordered selected row set (see below)
  content_checksum text NULL,      -- sha256 of the materialized file
  file_path        text NULL,
  row_count        integer NULL CHECK (row_count >= 0),
  status           text NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','completed','failed')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  completed_at     timestamptz NULL,
  UNIQUE (run_id, kind, filters_checksum)
);
-- WHY unique: request identity — a repeated command targets the same row instead
-- of forking files.
```

**Correctness rule (deliberately not the unique constraint):** `dataset_checksum` covers `(run_item.id, review_status, selected contact-point values and their signal states, active-suppression evaluation)`. On every invocation the engine recomputes it — suppression evaluation runs **before** the no-op decision on every call-ready export — and the export is a no-op only when the recomputed `dataset_checksum` matches the stored one **and** the on-disk file matches `content_checksum`. Otherwise it re-materializes and updates the row. A new review approval or a new suppression therefore always produces a fresh file; `--force` is a manual override, never the correctness mechanism.

**M5 call-ready selection rule (specified now):** exclude suppressed and `line_status IN ('inactive','unreachable')` rows first, prefer rows meeting the campaign acceptance rule, then oldest-first tiebreak (oldest-first alone is correct only for the M0 quick-list export). Reserved per-phone column groups: `<role>_phone_e164`, `<role>_line_type`, `<role>_validation_level`, `<role>_validation_result`, `<role>_last_checked_at`, plus `timezone`, `call_readiness_status`, `call_readiness_reason`, `suppression_status`. A public business main line, a direct number, and a mobile number are always distinct column groups — never conflated.

### Computed at export time vs stored

| Value | Where |
|---|---|
| Contact-point signals + per-signal checked-at/provider | **Stored** (`contact_points`; history in `contact_point_checks`) |
| `call_readiness_status` / `reason` | **Stored** on `run_items` (M5) — outcome of the run's contact-check policy step, campaign-scoped by construction |
| `suppression_status` (`'cleared'`,`'suppressed'`,`'unchecked'`) | **Computed at export time, never stored** — suppressions change after the run; default is `'unchecked'`, and `'unchecked'` is never rendered as cleared |
| Default call-ready row filter (exclude invalid/suppressed) | **Computed at export time** |
| `timezone` | **Stored** on `leads` (M3); NULL exports as unknown, never guessed |

---

## Migration staging

**`0001_init` (M0)** — everything untagged above (**12 domain tables**, plus the migration tool's `schema_migrations`): `agencies` (+ seeded default row), `workflows`, `workflow_versions`, `leads` (base columns incl. `employer_lead_id`, the `(source_provider, source_provider_id)` identity unique, non-unique domain and phone+locality lookup indexes), `runs`, `run_items`, `run_item_steps`, `lead_sources`, `contact_points` (full per-signal design and all CHECKs), `contact_point_checks`, `generated_outputs`, `exports` (incl. `dataset_checksum`) — minus every column tagged M1/M3/M4/M5. Migration notes must document: the `dataset_checksum` basis, the `approvals` entry shape, `normalized_value` semantics per type, the `position` counter rule, the bounded-jsonb rule, and the deferral registry below so later adapters do not drop source data.

**M0 table necessity review (directive §12):** all 12 tables stay in `0001_init`; each has an M0 writer and test — `agencies` (seed), `workflows`/`workflow_versions` (create/validate/version), `leads` (fake source), `runs`/`run_items`/`run_item_steps` (persistent fake run), `lead_sources` (fake-provider provenance), `contact_points`/`contact_point_checks` (engine format checks), `generated_outputs` (deterministic `score_rationale`), `exports` (CSV). None is safely deferrable without cutting an M0 acceptance path.

**`0002` (M1)** — `users`; `approval_tokens`; `created_by` on `workflows`/`workflow_versions`.

**M2 (minimal UI)** — no migration; the UI calls the same application services.

**`0003` (M3, applied 2026-07-12 as `0003_m3`)** — `leads.place_id` + partial unique; `leads.timezone`; `lead_sources.snapshot_expires_at` (column only — NO purge job: snapshot expiry was a Places-API caching term; SerpAPI/Firecrawl impose none, see ADR-024); `runs.resume_at` + `(status, resume_at)` index; `run_item_steps.next_attempt_at` + due index; **plus `run_source_requests`** — the M3-planning answer to "exact columns at M3 planning": a durable per-request ledger for the PAID, MULTI-REQUEST source step (`run_id`/`step_id`/`request_index` unique, `descriptor`, `status` incl. `needs_review`, `attempts`, `request_key`, `provider_request_id`, `cost_units`, `records_inserted`, `coverage_note`, `last_error`), mirroring `run_item_steps`' credit-safety design at run scope so a crash/429/credit pause never re-pays a completed search. The credits invariant becomes `runs.credits_used = SUM(run_item_steps.cost_units) + SUM(run_source_requests.cost_units)`. Retry/pause scheduling lands here rather than with Apollo because, under the revised milestone order, the local-business provider is the first live rate-limited provider.

**`0004` (M4)** — `leads.apollo_person_id`, `apollo_organization_id`, `normalized_linkedin_url`, `verified_email` + their partial unique indexes; `identity_conflicts`.

**`0005` (M5)** — `suppressions`; `run_items.call_readiness_status` + `call_readiness_reason`; call-ready CSV column groups and export-time suppression evaluation wired into the §16 no-op rule. **Applied 2026-07-13** with two additions beyond this document: `generated_outputs.kind` gained `'call_notes'` (grounded cold-call notes are an M5 generation kind) and `runs.pause_reason` gained `'awaiting_provider'` (submit-then-poll async vendors park the run until the earliest poll is due — ADR-029).

**`0006` (M6, sketch only)** — per-workspace encrypted `provider_credentials` (server-side only, write-only after entry, rotatable/deletable, never exposed to models or support diagnostics) and authentication columns. Designed at M6; not part of this proposal's DDL.

All post-0001 migrations are strictly additive (new tables, nullable columns, partial indexes); no backfill rewrites typed data because identifiers were never parked in JSONB.

### Deviations from `docs/architecture.md`

- Already recorded: `run_item_steps`, `approval_tokens`, and `identity_conflicts` (refinements of `run_items`' step-status responsibility, the signed-approval registry, and the flag-don't-merge rule respectively) were added to architecture.md's data-model table in the 2026-07-10 revision; no longer pending.
- Still to record on M0 acceptance: architecture.md's table carries no milestone tags — `users` lands M1 and `suppressions` lands M5, with the rationale above — and its `run_items` row does not note that the numeric score lives there (the score explanation lives in `generated_outputs`, as architecture.md assigns it).

---

## Audit findings resolution

Four adversarial reviews produced 26 findings (3 blocker, 14 major, 9 minor). All were accepted; none rebutted.

| # | Finding (severity) | What changed |
|---|---|---|
| 1 | Export no-op ignored suppression state (blocker) | `exports.dataset_checksum` from 0001, computed over the post-suppression selected row set; no-op conditional on recomputed match; M5 runs suppression evaluation on every call-ready export before the no-op decision (§16). |
| 2 | No home for the call-readiness verdict (major) | `run_items.call_readiness_status/reason` (M5) with the exact `ready/uncertain/invalid/suppressed/unchecked` vocabulary; `NULL` ≠ `'unchecked'` documented (§8). |
| 3 | `suppressions` had no target shape (major) | Full DDL (§14): agency-scoped, scope CHECK, partial unique on active rows, release-as-update audit path; export `suppression_status` defined as computed-at-export (§16); lands M5. |
| 4 | Timezone missing from the target model (major) | `leads.timezone` (M3, IANA id) populated at source time; call-ready CSV renders NULL as unknown (§5, §16). |
| 5 | One `status_checked_at` for five signals (major) | Per-signal `*_checked_at` + `*_provider` pairs from 0001 with paired-NULL CHECKs; latest-per-method in `contact_point_checks` stays authoritative (§11–12). |
| 6 | No approval-token persistence for M1 "missing/expired/changed/consumed" (major) | `approval_tokens` (M1) with nonce UNIQUE, expiry, atomic single consumption; M0 `approvals` entries carry `id/expiresAt/consumedAt` for lossless promotion (§6–7). |
| 7 | Approval entries omitted overrides + paid-action estimates (major) | Entry shape includes `overrides` and per-step `estimatedPaidActions`; claim re-verification compares overrides too (§6). |
| 8 | `UNIQUE(run_id, position)` broke crash-resume under shifted provider pagination (major) | `position` from a per-run monotonic counter inside the insert transaction, never provider ordinal (§8). |
| 9 | Cost ledger lost charged-but-failed attempts (major) | `cost_units` accumulates on completed **and** failed transitions; append-only `attempt_costs`; budget gate includes failed spend (§9). |
| 10 | Static `request_key` conflated crash-replay with genuine retry (major) | Attempt-scoped key persisted at claim time; reused on crash-resume, rotated on explicit requeue; per-adapter provider-side contract documented with the first paid adapters, M3/M4 (§9). |
| 11 | Export idempotency keyed on request went stale after review changes (major) | Folded into `dataset_checksum` (includes `review_status`); `run_items.updated_at` maintained on review writes; `--force` demoted to manual override (§16). |
| 12 | No person↔company link for M4 executives (major) | `leads.employer_lead_id` self-FK from M0; no separate companies table needed through M5 (§5). |
| 13 | Identifier uniqueness shape under-specified; domain/phone over-merge risk (major) | Strong identifiers = agency-scoped partial uniques on `leads`; weak identifiers (domain, phone+locality) = non-unique lookup indexes resolved to `new/matched/conflict` in code; verified-email uniqueness at lead level only (§5). |
| 14 | No durable identity-conflict record (major) | `identity_conflicts` (M4) with canonical pair ordering and idempotent re-flagging; M0 flags on `run_items` (§13). |
| 15 | Google Places policy trap in `lead_sources` (major) | Typed `provider`/`provider_record_id`/`retrieved_at` outside the purgeable snapshot from 0001; `snapshot_expires_at` (M3); upsert unique per (provider, record, lead); `place_id` mirrored to `leads` (§10). |
| 16 | The audit itself received no schema text (blocker ×2, orchestration bug) | This document is now the materialized, authoritative target model, committed in-repo so any future audit reads it directly. |
| 17 | Minor findings (9): `line_status`/`identity_match` CHECK vocabularies; single `not_checked` representation + type-scoped signal CHECKs; E.164 CHECK on normalized phone; validation-aware M5 CSV flattening + per-phone column groups; `pause_reason` CHECK + `resume_at`/`next_attempt_at` scheduling; bounded `snapshot`/`result` with size guard + test; `paid_record_cap` 0–100 and `credit_limit NOT NULL DEFAULT 0`; typed review-gate columns; `UNIQUE(run_id, lead_id)` duplicate attachment | All landed as specified (§6, §8, §9, §11, §16). |

### Post-synthesis corrections (merge with the base design)

The audit's synthesis draft dropped several base-plan columns that remain required; they are restored above: `runs.resolved_plan`, `runs.lease_token`/`lease_expires_at`/`cancel_requested`; `run_items.dedupe_status`/`skip_reason`/`score`/`current_step_id`; `run_item_steps.skip_reason`; `workflows.slug`/`description`; `contact_points.confidence`/`source_run_item_id`; `leads.source_provider`/`source_provider_id` + its M0 identity unique (the provider-neutral discovery identity the fake provider needs before `place_id`/`apollo_*` exist); `lead_sources.run_item_id`. Two synthesis choices were reversed: phone+locality is a **non-unique** lookup index (a hard unique would block or merge a legitimate second business on a shared line), and email `format_valid` is permitted (syntax ≠ deliverability; the honesty split stays explicit).
