/**
 * Migration 0003 (Milestone 3) — strictly additive, per
 * docs/proposals/database-schema.md §M3. Two concerns:
 *
 * 1. Local-business identity + call-prep: leads.place_id (Google place_id;
 *    numeric CID kept in lead_sources.snapshot), leads.timezone (IANA id; NULL
 *    means unknown, never guessed), lead_sources.snapshot_expires_at (column
 *    lands now, but there is NO purge job at M3 — that was a Places-API caching
 *    term; the SerpAPI/Firecrawl vendors impose none, see ADR-023/024).
 *
 * 2. Rate-limit scheduling for the first live rate-limited provider:
 *    runs.resume_at + run_item_steps.next_attempt_at (with their due-index
 *    partners), and run_source_requests — a durable per-request ledger for the
 *    PAID, MULTI-REQUEST source step that mirrors run_item_steps' credit-safety
 *    design at run scope, so a crash / 429 / credit pause resumes WITHOUT
 *    re-paying for a completed search.
 *
 * All columns are nullable — no backfill.
 */
export const MIGRATION_0003_M3 = String.raw`
ALTER TABLE leads ADD COLUMN place_id text NULL;
ALTER TABLE leads ADD COLUMN timezone text NULL;
CREATE UNIQUE INDEX leads_place_id_uq ON leads (agency_id, place_id) WHERE place_id IS NOT NULL;

ALTER TABLE lead_sources ADD COLUMN snapshot_expires_at timestamptz NULL;

ALTER TABLE runs ADD COLUMN resume_at timestamptz NULL;
CREATE INDEX runs_status_resume_ix ON runs (status, resume_at);

ALTER TABLE run_item_steps ADD COLUMN next_attempt_at timestamptz NULL;
CREATE INDEX run_item_steps_due_ix ON run_item_steps (status, next_attempt_at);

CREATE TABLE run_source_requests (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id              uuid NOT NULL REFERENCES runs(id) ON DELETE RESTRICT,
  step_id             text NOT NULL,
  request_index       integer NOT NULL CHECK (request_index >= 0),
  descriptor          text NOT NULL,
  status              text NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','running','completed','failed','needs_review')),
  attempts            integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  request_key         text NOT NULL,
  provider_request_id text NULL,
  cost_units          numeric(12,4) NOT NULL DEFAULT 0 CHECK (cost_units >= 0),
  records_inserted    integer NULL CHECK (records_inserted IS NULL OR records_inserted >= 0),
  coverage_note       text NULL,
  last_error          jsonb NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, step_id, request_index)
);
`;
