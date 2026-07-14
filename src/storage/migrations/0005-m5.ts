/**
 * Migration 0005 (Milestone 5) — contact enrichment, call readiness, and
 * suppressions, per docs/proposals/database-schema.md §14 (suppressions), §8
 * (run_items call-readiness columns), and §16 (export-time suppression rule —
 * no storage here; suppression_status is computed at export, never stored).
 *
 * Beyond the schema doc (noted there with the milestone report):
 * - generated_outputs.kind gains 'call_notes' (grounded cold-call notes are an
 *   M5 generation kind alongside fit_summary/opener).
 * - runs.pause_reason gains 'awaiting_provider' (submit-then-poll async
 *   contact-discovery vendors park the run until the earliest poll is due —
 *   same resume_at machinery as rate-limit pauses; see ADR-029).
 *
 * The two DROP CONSTRAINTs rely on Postgres auto-naming of the 0001 inline
 * column CHECKs (<table>_<column>_check) — identical on PGlite and PG16; the
 * migration test covers fresh and 0001→0005 upgrade paths.
 *
 * call_readiness_status semantics: NULL = no contact-capability step ever ran
 * for the item (e.g. quick_list); 'unchecked' = capability steps ran but the
 * requested checks were not performed for this item. Unknown is never cleared.
 */
export const MIGRATION_0005_M5 = String.raw`
CREATE TABLE suppressions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id        uuid NOT NULL REFERENCES agencies(id) ON DELETE RESTRICT,
  scope            text NOT NULL CHECK (scope IN ('phone','email','domain','lead')),
  normalized_value text NOT NULL,
  reason           text NOT NULL,
  requested_by     text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  released_at      timestamptz NULL,
  released_by      text NULL,
  CONSTRAINT suppressions_release_pair_ck CHECK ((released_at IS NULL) = (released_by IS NULL))
);

CREATE UNIQUE INDEX suppressions_active_uq
  ON suppressions (agency_id, scope, normalized_value) WHERE released_at IS NULL;

ALTER TABLE run_items ADD COLUMN call_readiness_status text NULL
  CHECK (call_readiness_status IN ('ready','uncertain','invalid','suppressed','unchecked'));
ALTER TABLE run_items ADD COLUMN call_readiness_reason text NULL;

ALTER TABLE generated_outputs DROP CONSTRAINT generated_outputs_kind_check;
ALTER TABLE generated_outputs ADD CONSTRAINT generated_outputs_kind_check
  CHECK (kind IN ('score_rationale','fit_summary','opener','call_notes'));

ALTER TABLE runs DROP CONSTRAINT runs_pause_reason_check;
ALTER TABLE runs ADD CONSTRAINT runs_pause_reason_check
  CHECK (pause_reason IN ('credit_cap_reached','rate_limited','operator','awaiting_provider'));
`;
