import type { ColumnType, Generated } from "kysely";

/**
 * Kysely table typings for the 0001_init schema.
 *
 * Conventions:
 * - jsonb columns are ALWAYS written as JSON strings (`JSON.stringify`) so the
 *   pg driver never misinterprets a JS array as a Postgres array literal;
 *   drivers parse them back to objects on read. Hence ColumnType<T, string, string>.
 * - numeric columns come back as strings from pg (and may be numbers from
 *   PGlite); normalize with `num()` at the domain boundary.
 * - timestamptz columns may be Date (pg, PGlite) — normalize with `iso()`.
 */
type JsonColumn<T> = ColumnType<T, string, string>;
/** jsonb with a SQL default: optional on insert, still written as a JSON string. */
type JsonColumnOpt<T> = ColumnType<T, string | undefined, string>;
type NumericColumn = ColumnType<string | number, number | string, number | string>;
type NumericColumnOpt = ColumnType<string | number, number | string | undefined, number | string>;
type TimestampColumn = ColumnType<Date | string, Date | string, Date | string>;
type GeneratedTimestamp = ColumnType<Date | string, Date | string | undefined, Date | string>;
/** Column with a SQL default whose select type is a union (Generated<> breaks on unions of ColumnType). */
type WithDefault<T> = ColumnType<T, T | undefined, T>;

export type JsonObject = Record<string, unknown>;

export interface AgenciesTable {
  id: Generated<string>;
  name: string;
  metadata: JsonColumn<JsonObject>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface WorkflowsTable {
  id: Generated<string>;
  agency_id: string;
  slug: string;
  name: string;
  description: string | null;
  draft_definition: JsonColumn<JsonObject>;
  archived_at: TimestampColumn | null;
  created_by: string | null;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface WorkflowVersionsTable {
  id: Generated<string>;
  workflow_id: string;
  version: number;
  definition: JsonColumn<JsonObject>;
  checksum: string;
  created_by: string | null;
  created_at: GeneratedTimestamp;
}

export interface UsersTable {
  id: Generated<string>;
  agency_id: string;
  email: string;
  display_name: string | null;
  role: WithDefault<"owner" | "member">;
  created_at: GeneratedTimestamp;
}

/**
 * Engine-level approval registry (0002_m1). The nonce IS the token handed to
 * the harness/CLI; consumption is a single atomic UPDATE guarded by
 * consumed_at IS NULL AND expires_at > now(), so a token can start exactly
 * one run and a scope change (different plan hash) invalidates it.
 */
export interface ApprovalTokensTable {
  id: Generated<string>;
  agency_id: string;
  workflow_version_id: string;
  nonce: string;
  scope_hash: string;
  enrichment_profile: EnrichmentProfile;
  overrides: JsonColumnOpt<JsonObject>;
  paid_record_cap: number;
  credit_limit: NumericColumnOpt;
  estimated_paid_actions: JsonColumnOpt<EstimatedPaidAction[]>;
  issued_by: string | null;
  issued_at: GeneratedTimestamp;
  expires_at: TimestampColumn;
  consumed_at: TimestampColumn | null;
  consumed_by_run_id: string | null;
}

export interface LeadsTable {
  id: Generated<string>;
  agency_id: string;
  kind: "business" | "person";
  display_name: string;
  first_name: string | null;
  last_name: string | null;
  title: string | null;
  employer_lead_id: string | null;
  category: string | null;
  website_url: string | null;
  address_line: string | null;
  locality: string | null;
  region: string | null;
  country: string | null;
  normalized_domain: string | null;
  normalized_phone: string | null;
  source_provider: string | null;
  source_provider_id: string | null;
  metadata: JsonColumn<JsonObject>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export type RunStatus =
  | "pending"
  | "running"
  | "waiting_review"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";
export type PauseReason = "credit_cap_reached" | "rate_limited" | "operator";
export type EnrichmentProfile = "quick_list" | "call_ready" | "full";

export interface RunsTable {
  id: Generated<string>;
  agency_id: string;
  workflow_version_id: string;
  inputs: JsonColumn<JsonObject>;
  enrichment_profile: EnrichmentProfile;
  overrides: JsonColumn<JsonObject>;
  resolved_plan: JsonColumn<JsonObject>;
  plan_hash: string;
  status: WithDefault<RunStatus>;
  pause_reason: PauseReason | null;
  cancel_requested: WithDefault<boolean>;
  paid_record_cap: WithDefault<number>;
  credit_limit: NumericColumnOpt;
  credits_used: NumericColumnOpt;
  approvals: JsonColumnOpt<ApprovalEntry[]>;
  step_progress: JsonColumnOpt<Record<string, string>>;
  review_gate_passed_at: TimestampColumn | null;
  review_gate_actor: string | null;
  lease_token: string | null;
  lease_expires_at: TimestampColumn | null;
  last_error: JsonColumn<JsonObject> | null;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
  started_at: TimestampColumn | null;
  completed_at: TimestampColumn | null;
}

/** Documented approvals[] entry shape (schema doc §6); id/expiresAt/consumedAt nullable in M0. */
export interface ApprovalEntry {
  id: string | null;
  planHash: string;
  profile: EnrichmentProfile;
  overrides: JsonObject;
  paidRecordCap: number;
  creditLimit: number;
  estimatedPaidActions: EstimatedPaidAction[];
  approvedAt: string;
  source: string;
  expiresAt: string | null;
  consumedAt: string | null;
}

export interface EstimatedPaidAction {
  stepId: string;
  provider: string;
  count: number;
  costPerRecord: number;
}

export type RunItemStatus = "pending" | "in_progress" | "completed" | "failed" | "skipped";
export type SkipReason = "filtered" | "identity_conflict";
export type DedupeStatus = "new" | "matched" | "conflict";
export type ReviewStatus = "unreviewed" | "approved" | "rejected" | "regenerate";

export interface RunItemsTable {
  id: Generated<string>;
  run_id: string;
  lead_id: string | null;
  source_key: string;
  position: number;
  status: WithDefault<RunItemStatus>;
  skip_reason: SkipReason | null;
  dedupe_status: DedupeStatus | null;
  current_step_id: string | null;
  score: NumericColumn | null;
  review_status: WithDefault<ReviewStatus>;
  reviewed_at: TimestampColumn | null;
  review_actor: string | null;
  snapshot: JsonColumn<JsonObject>;
  last_error: JsonColumn<JsonObject> | null;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export type StepStatus = "pending" | "running" | "completed" | "failed" | "needs_review" | "skipped";
export type AttemptClassification = "completed" | "failed_charged" | "failed_uncharged" | "ambiguous";

/** Documented attempt_costs[] entry shape (schema doc §9). */
export interface AttemptCostEntry {
  attempt: number;
  requestKey: string;
  providerRequestId: string | null;
  cost: number;
  at: string;
  outcome: string;
  classification: AttemptClassification;
  reconciledAt: string | null;
}

export interface RunItemStepsTable {
  id: Generated<string>;
  run_item_id: string;
  step_id: string;
  status: WithDefault<StepStatus>;
  skip_reason: string | null;
  attempts: WithDefault<number>;
  request_key: string;
  cost_units: NumericColumnOpt;
  attempt_costs: JsonColumnOpt<AttemptCostEntry[]>;
  result: JsonColumnOpt<JsonObject>;
  last_error: JsonColumn<JsonObject> | null;
  started_at: TimestampColumn | null;
  completed_at: TimestampColumn | null;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface LeadSourcesTable {
  id: Generated<string>;
  lead_id: string;
  run_id: string | null;
  run_item_id: string | null;
  provider: string;
  provider_record_id: string | null;
  request_id: string | null;
  retrieved_at: GeneratedTimestamp;
  snapshot: JsonColumn<JsonObject>;
  created_at: GeneratedTimestamp;
}

export type ContactPointType = "phone" | "email";
export type PhoneRole = "business_main" | "direct" | "mobile" | "toll_free" | "unknown";
export type EmailRole = "work" | "personal" | "unknown";
export type LineType = "landline" | "mobile" | "voip" | "toll_free" | "unknown";
export type LineStatus = "active" | "inactive" | "unreachable" | "unknown";
export type IdentityMatch = "business_match" | "person_match" | "mismatch" | "unknown";
export type EmailStatus = "valid" | "invalid" | "catch_all" | "unknown" | "role_based" | "not_checked";

export interface ContactPointsTable {
  id: Generated<string>;
  lead_id: string;
  type: ContactPointType;
  role: PhoneRole | EmailRole;
  raw_value: string;
  normalized_value: string | null;
  source_provider: string;
  source_run_item_id: string | null;
  source_metadata: JsonColumn<JsonObject>;
  confidence: NumericColumn | null;
  format_valid: boolean | null;
  format_checked_at: TimestampColumn | null;
  line_type: LineType | null;
  line_type_checked_at: TimestampColumn | null;
  line_type_provider: string | null;
  line_status: LineStatus | null;
  line_status_checked_at: TimestampColumn | null;
  line_status_provider: string | null;
  identity_match: IdentityMatch | null;
  identity_match_checked_at: TimestampColumn | null;
  identity_match_provider: string | null;
  email_status: EmailStatus | null;
  email_status_checked_at: TimestampColumn | null;
  email_status_provider: string | null;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export type CheckMethod = "format" | "line_type" | "line_status" | "identity_match" | "email_deliverability";

export interface ContactPointChecksTable {
  id: Generated<string>;
  contact_point_id: string;
  method: CheckMethod;
  provider: string;
  result: string;
  detail: JsonColumn<JsonObject>;
  confidence: NumericColumn | null;
  request_id: string | null;
  run_item_step_id: string | null;
  cost_units: NumericColumnOpt;
  checked_at: GeneratedTimestamp;
}

export type OutputKind = "score_rationale" | "fit_summary" | "opener";

export interface GeneratedOutputsTable {
  id: Generated<string>;
  lead_id: string;
  run_id: string;
  run_item_id: string | null;
  kind: OutputKind;
  prompt_version: string;
  model_provider: string | null;
  model: string | null;
  content: JsonColumn<JsonObject>;
  evidence: JsonColumnOpt<EvidenceRef[]>;
  created_at: GeneratedTimestamp;
}

/** Evidence entries must reference persisted rows (grounding rule). */
export interface EvidenceRef {
  leadSourceId?: string;
  contactPointId?: string;
  field: string;
}

export type ExportStatus = "pending" | "completed" | "failed";

export interface ExportsTable {
  id: Generated<string>;
  run_id: string;
  kind: "csv";
  filters: JsonColumn<JsonObject>;
  filters_checksum: string;
  dataset_checksum: string | null;
  content_checksum: string | null;
  file_path: string | null;
  row_count: number | null;
  status: WithDefault<ExportStatus>;
  created_at: GeneratedTimestamp;
  completed_at: TimestampColumn | null;
}

export interface SchemaMigrationsTable {
  id: string;
  checksum: string;
  applied_at: GeneratedTimestamp;
}

export interface Database {
  agencies: AgenciesTable;
  users: UsersTable;
  approval_tokens: ApprovalTokensTable;
  workflows: WorkflowsTable;
  workflow_versions: WorkflowVersionsTable;
  leads: LeadsTable;
  runs: RunsTable;
  run_items: RunItemsTable;
  run_item_steps: RunItemStepsTable;
  lead_sources: LeadSourcesTable;
  contact_points: ContactPointsTable;
  contact_point_checks: ContactPointChecksTable;
  generated_outputs: GeneratedOutputsTable;
  exports: ExportsTable;
  schema_migrations: SchemaMigrationsTable;
}

/** Normalize a numeric column value (string from pg, number from PGlite) to a JS number. */
export function num(value: string | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  return typeof value === "number" ? value : Number(value);
}

/** Round to the numeric(12,4) precision used for credits. */
export function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}
