/**
 * Migration 0001_init — the untagged (Milestone 0) DDL from
 * docs/proposals/database-schema.md: 12 domain tables. Columns/tables tagged
 * M1/M3/M4/M5 in that document are deliberately absent and arrive in later
 * additive migrations (0002 M1, 0003 M3, 0004 M4, 0005 M5).
 *
 * Notes locked in by the schema document:
 * - `text` + CHECK vocabularies, never Postgres enums.
 * - Append-only history: contact_point_checks, runs.approvals entries,
 *   run_item_steps.attempt_costs (single amendment: reconciling an ambiguous
 *   entry fills classification/reconciledAt), generated_outputs.
 * - runs.approvals entry shape: {id, planHash, profile, overrides,
 *   paidRecordCap, creditLimit, estimatedPaidActions, approvedAt, source,
 *   expiresAt, consumedAt} (id/expiresAt/consumedAt nullable in M0).
 * - run_item_steps.attempt_costs entry shape: {attempt, requestKey,
 *   providerRequestId, cost, at, outcome, classification, reconciledAt},
 *   classification IN (completed, failed_charged, failed_uncharged, ambiguous).
 * - contact_points.normalized_value: phone = E.164 (CHECK), email = lower/trim.
 * - run_items.position comes from a per-run monotonic counter inside the
 *   insert transaction, never from provider ordinal.
 * - Bounded jsonb only in run_items.snapshot / run_item_steps.result
 *   (repository size guard ~8 KB, tested).
 * - exports.dataset_checksum covers the ordered selected row set
 *   (run_item id, review_status, selected contact-point values and signal
 *   states); the no-op rule recomputes it on every invocation.
 */
export const MIGRATION_0001_INIT = String.raw`
CREATE TABLE agencies (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  metadata    jsonb NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE workflows (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id        uuid NOT NULL REFERENCES agencies(id) ON DELETE RESTRICT,
  slug             text NOT NULL,
  name             text NOT NULL,
  description      text NULL,
  draft_definition jsonb NOT NULL DEFAULT '{}',
  archived_at      timestamptz NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX workflows_agency_slug_uq
  ON workflows (agency_id, slug) WHERE archived_at IS NULL;

CREATE TABLE workflow_versions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id uuid NOT NULL REFERENCES workflows(id) ON DELETE RESTRICT,
  version     integer NOT NULL CHECK (version >= 1),
  definition  jsonb NOT NULL,
  checksum    text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workflow_id, version)
);

CREATE TABLE leads (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id          uuid NOT NULL REFERENCES agencies(id) ON DELETE RESTRICT,
  kind               text NOT NULL CHECK (kind IN ('business','person')),
  display_name       text NOT NULL,
  first_name         text NULL,
  last_name          text NULL,
  title              text NULL,
  employer_lead_id   uuid NULL REFERENCES leads(id) ON DELETE SET NULL,
  category           text NULL,
  website_url        text NULL,
  address_line       text NULL,
  locality           text NULL,
  region             text NULL,
  country            text NULL,
  normalized_domain  text NULL,
  normalized_phone   text NULL
                     CHECK (normalized_phone IS NULL
                            OR normalized_phone ~ '^\+[1-9][0-9]{1,14}$'),
  source_provider    text NULL,
  source_provider_id text NULL,
  metadata           jsonb NOT NULL DEFAULT '{}',
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX leads_source_identity_uq
  ON leads (agency_id, source_provider, source_provider_id)
  WHERE source_provider_id IS NOT NULL;

CREATE INDEX leads_domain_ix
  ON leads (agency_id, normalized_domain) WHERE normalized_domain IS NOT NULL;

CREATE INDEX leads_phone_locality_ix
  ON leads (agency_id, normalized_phone, locality) WHERE normalized_phone IS NOT NULL;

CREATE TABLE runs (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id             uuid NOT NULL REFERENCES agencies(id) ON DELETE RESTRICT,
  workflow_version_id   uuid NOT NULL REFERENCES workflow_versions(id) ON DELETE RESTRICT,
  inputs                jsonb NOT NULL,
  enrichment_profile    text NOT NULL
                        CHECK (enrichment_profile IN ('quick_list','call_ready','full')),
  overrides             jsonb NOT NULL DEFAULT '{}',
  resolved_plan         jsonb NOT NULL,
  plan_hash             text NOT NULL,
  status                text NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','running','waiting_review','paused',
                                          'completed','failed','cancelled')),
  pause_reason          text NULL
                        CHECK (pause_reason IN ('credit_cap_reached','rate_limited','operator')),
  cancel_requested      boolean NOT NULL DEFAULT false,
  paid_record_cap       integer NOT NULL DEFAULT 0
                        CHECK (paid_record_cap BETWEEN 0 AND 100),
  credit_limit          numeric(12,4) NOT NULL DEFAULT 0 CHECK (credit_limit >= 0),
  credits_used          numeric(12,4) NOT NULL DEFAULT 0 CHECK (credits_used >= 0),
  approvals             jsonb NOT NULL DEFAULT '[]',
  step_progress         jsonb NOT NULL DEFAULT '{}',
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

CREATE INDEX runs_workflow_version_ix ON runs (workflow_version_id);

CREATE TABLE run_items (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id                 uuid NOT NULL REFERENCES runs(id) ON DELETE RESTRICT,
  lead_id                uuid NULL REFERENCES leads(id) ON DELETE SET NULL,
  source_key             text NOT NULL,
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
  snapshot               jsonb NOT NULL DEFAULT '{}',
  last_error             jsonb NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, source_key),
  UNIQUE (run_id, position)
);

CREATE UNIQUE INDEX run_items_run_lead_uq
  ON run_items (run_id, lead_id) WHERE lead_id IS NOT NULL;

CREATE INDEX run_items_run_status_ix ON run_items (run_id, status);
CREATE INDEX run_items_run_review_ix ON run_items (run_id, review_status);

CREATE TABLE run_item_steps (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_item_id     uuid NOT NULL REFERENCES run_items(id) ON DELETE RESTRICT,
  step_id         text NOT NULL,
  status          text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','running','completed','failed',
                                    'needs_review','skipped')),
  skip_reason     text NULL,
  attempts        integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  request_key     text NOT NULL,
  cost_units      numeric(12,4) NOT NULL DEFAULT 0 CHECK (cost_units >= 0),
  attempt_costs   jsonb NOT NULL DEFAULT '[]',
  result          jsonb NOT NULL DEFAULT '{}',
  last_error      jsonb NULL,
  started_at      timestamptz NULL,
  completed_at    timestamptz NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_item_id, step_id),
  UNIQUE (request_key)
);

CREATE TABLE lead_sources (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id             uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  run_id              uuid NULL REFERENCES runs(id) ON DELETE SET NULL,
  run_item_id         uuid NULL REFERENCES run_items(id) ON DELETE SET NULL,
  provider            text NOT NULL,
  provider_record_id  text NULL,
  request_id          text NULL,
  retrieved_at        timestamptz NOT NULL DEFAULT now(),
  snapshot            jsonb NOT NULL DEFAULT '{}',
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX lead_sources_provider_record_uq
  ON lead_sources (provider, provider_record_id, lead_id)
  WHERE provider_record_id IS NOT NULL;

CREATE INDEX lead_sources_lead_ix ON lead_sources (lead_id);

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
  format_valid              boolean NULL,
  format_checked_at         timestamptz NULL,
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

CREATE INDEX contact_points_lead_ix ON contact_points (lead_id, type, role);

CREATE TABLE contact_point_checks (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_point_id  uuid NOT NULL REFERENCES contact_points(id) ON DELETE CASCADE,
  method            text NOT NULL
                    CHECK (method IN ('format','line_type','line_status',
                                      'identity_match','email_deliverability')),
  provider          text NOT NULL,
  result            text NOT NULL,
  detail            jsonb NOT NULL DEFAULT '{}',
  confidence        numeric(5,4) NULL CHECK (confidence BETWEEN 0 AND 1),
  request_id        text NULL,
  run_item_step_id  uuid NULL REFERENCES run_item_steps(id) ON DELETE SET NULL,
  cost_units        numeric(12,4) NOT NULL DEFAULT 0 CHECK (cost_units >= 0),
  checked_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX cpc_contact_point_ix
  ON contact_point_checks (contact_point_id, method, checked_at DESC);

CREATE TABLE generated_outputs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id         uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  run_id          uuid NOT NULL REFERENCES runs(id) ON DELETE RESTRICT,
  run_item_id     uuid NULL REFERENCES run_items(id) ON DELETE SET NULL,
  kind            text NOT NULL
                  CHECK (kind IN ('score_rationale','fit_summary','opener')),
  prompt_version  text NOT NULL,
  model_provider  text NULL,
  model           text NULL,
  content         jsonb NOT NULL,
  evidence        jsonb NOT NULL DEFAULT '[]',
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX generated_outputs_latest_ix
  ON generated_outputs (run_id, lead_id, kind, created_at DESC);

CREATE TABLE exports (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id           uuid NOT NULL REFERENCES runs(id) ON DELETE RESTRICT,
  kind             text NOT NULL CHECK (kind IN ('csv')),
  filters          jsonb NOT NULL DEFAULT '{}',
  filters_checksum text NOT NULL,
  dataset_checksum text NULL,
  content_checksum text NULL,
  file_path        text NULL,
  row_count        integer NULL CHECK (row_count >= 0),
  status           text NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','completed','failed')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  completed_at     timestamptz NULL,
  UNIQUE (run_id, kind, filters_checksum)
);

-- Milestone 0 seeds one fixed-UUID default agency (schema doc §1).
INSERT INTO agencies (id, name)
VALUES ('00000000-0000-0000-0000-000000000001', 'Default agency')
ON CONFLICT (id) DO NOTHING;
`;
