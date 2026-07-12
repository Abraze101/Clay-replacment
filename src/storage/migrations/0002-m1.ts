/**
 * Migration 0002 (Milestone 1) — strictly additive, per
 * docs/proposals/database-schema.md §2 (users) and §7 (approval_tokens), plus
 * the created_by attribution columns. No backfill: M0 rows keep free-text
 * actor attribution ('cli'), which M1 extends with 'mcp:<client>'.
 */
export const MIGRATION_0002_M1 = String.raw`
CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id     uuid NOT NULL REFERENCES agencies(id) ON DELETE RESTRICT,
  email         text NOT NULL,
  display_name  text NULL,
  role          text NOT NULL DEFAULT 'owner'
                CHECK (role IN ('owner','member')),
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX users_email_uq ON users (lower(email));

CREATE TABLE approval_tokens (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id              uuid NOT NULL REFERENCES agencies(id) ON DELETE RESTRICT,
  workflow_version_id    uuid NOT NULL REFERENCES workflow_versions(id) ON DELETE RESTRICT,
  nonce                  text NOT NULL,
  scope_hash             text NOT NULL,
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

ALTER TABLE workflows
  ADD COLUMN created_by uuid NULL REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE workflow_versions
  ADD COLUMN created_by uuid NULL REFERENCES users(id) ON DELETE SET NULL;
`;
