/**
 * Migration 0004 (Milestone 4) — strictly additive, per
 * docs/proposals/database-schema.md §5 (M4 lead columns) and §13
 * (identity_conflicts). Two concerns:
 *
 * 1. Person/cross-provider identity keys on leads: apollo_person_id and
 *    apollo_organization_id (Apollo's stable IDs), normalized_linkedin_url
 *    (supplied by Apollo or an import ONLY — never scraped; canonical
 *    'linkedin.com/in/<slug>' form), and verified_email. verified_email has NO
 *    M4 writer: it is set only when a deliverability check returns 'valid'
 *    (M5); an email Apollo merely found stays on contact_points as
 *    'not_checked'. All four are agency-scoped partial uniques so identity
 *    replay is ON-CONFLICT-safe; the org key is unique only for business
 *    leads (a person lead never owns the org identity).
 *
 * 2. identity_conflicts — the durable "flag, do not merge automatically"
 *    record. The ordered-pair CHECK plus the UNIQUE constraint canonicalize a
 *    conflict so a retried dedupe/enrich step re-raises it as a no-op, never a
 *    duplicate flag.
 *
 * All columns are nullable — no backfill.
 */
export const MIGRATION_0004_M4 = String.raw`
ALTER TABLE leads ADD COLUMN apollo_person_id text NULL;
ALTER TABLE leads ADD COLUMN apollo_organization_id text NULL;
ALTER TABLE leads ADD COLUMN normalized_linkedin_url text NULL;
ALTER TABLE leads ADD COLUMN verified_email text NULL;

CREATE UNIQUE INDEX leads_apollo_person_uq
  ON leads (agency_id, apollo_person_id) WHERE apollo_person_id IS NOT NULL;
CREATE UNIQUE INDEX leads_linkedin_uq
  ON leads (agency_id, normalized_linkedin_url) WHERE normalized_linkedin_url IS NOT NULL;
CREATE UNIQUE INDEX leads_verified_email_uq
  ON leads (agency_id, verified_email) WHERE verified_email IS NOT NULL;
CREATE UNIQUE INDEX leads_apollo_org_uq
  ON leads (agency_id, apollo_organization_id)
  WHERE apollo_organization_id IS NOT NULL AND kind = 'business';

CREATE TABLE identity_conflicts (
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
`;
