import type { Kysely, Selectable } from "kysely";

import type {
  CheckMethod,
  ContactPointsTable,
  Database,
  EmailRole,
  EmailStatus,
  LeadsTable,
  LeadSourcesTable,
  PhoneRole,
} from "../database-types.js";
import { toJson } from "./repo-util.js";

export type LeadRow = Selectable<LeadsTable>;
export type ContactPointRow = Selectable<ContactPointsTable>;
export type LeadSourceRow = Selectable<LeadSourcesTable>;

export interface NewLead {
  agencyId: string;
  kind: "business" | "person";
  displayName: string;
  firstName?: string | null;
  lastName?: string | null;
  title?: string | null;
  employerLeadId?: string | null;
  category?: string | null;
  websiteUrl?: string | null;
  addressLine?: string | null;
  locality?: string | null;
  region?: string | null;
  country?: string | null;
  normalizedDomain?: string | null;
  normalizedPhone?: string | null;
  sourceProvider?: string | null;
  sourceProviderId?: string | null;
}

/** Identity lookup #1: provider-neutral discovery identity (hard unique). */
export async function findLeadBySourceIdentity(
  db: Kysely<Database>,
  agencyId: string,
  provider: string,
  providerId: string,
): Promise<LeadRow | undefined> {
  return await db
    .selectFrom("leads")
    .selectAll()
    .where("agency_id", "=", agencyId)
    .where("source_provider", "=", provider)
    .where("source_provider_id", "=", providerId)
    .executeTakeFirst();
}

/** Weak-identifier lookup (deliberately non-unique): normalized domain. */
export async function findLeadsByDomain(
  db: Kysely<Database>,
  agencyId: string,
  normalizedDomain: string,
): Promise<LeadRow[]> {
  return await db
    .selectFrom("leads")
    .selectAll()
    .where("agency_id", "=", agencyId)
    .where("normalized_domain", "=", normalizedDomain)
    .execute();
}

/** Weak-identifier lookup (deliberately non-unique): phone + locality. */
export async function findLeadsByPhoneLocality(
  db: Kysely<Database>,
  agencyId: string,
  normalizedPhone: string,
  locality: string | null,
): Promise<LeadRow[]> {
  let query = db
    .selectFrom("leads")
    .selectAll()
    .where("agency_id", "=", agencyId)
    .where("normalized_phone", "=", normalizedPhone);
  query = locality === null ? query.where("locality", "is", null) : query.where("locality", "=", locality);
  return await query.execute();
}

/**
 * Insert a lead; a replayed source/dedupe step hitting the source-identity
 * unique upserts (DO NOTHING + re-select) instead of duplicating.
 */
export async function insertLead(db: Kysely<Database>, lead: NewLead): Promise<LeadRow> {
  const inserted = await db
    .insertInto("leads")
    .values({
      agency_id: lead.agencyId,
      kind: lead.kind,
      display_name: lead.displayName,
      first_name: lead.firstName ?? null,
      last_name: lead.lastName ?? null,
      title: lead.title ?? null,
      employer_lead_id: lead.employerLeadId ?? null,
      category: lead.category ?? null,
      website_url: lead.websiteUrl ?? null,
      address_line: lead.addressLine ?? null,
      locality: lead.locality ?? null,
      region: lead.region ?? null,
      country: lead.country ?? null,
      normalized_domain: lead.normalizedDomain ?? null,
      normalized_phone: lead.normalizedPhone ?? null,
      source_provider: lead.sourceProvider ?? null,
      source_provider_id: lead.sourceProviderId ?? null,
      metadata: toJson({}),
    })
    .onConflict((oc) => oc.doNothing())
    .returningAll()
    .executeTakeFirst();
  if (inserted) return inserted;
  const existing =
    lead.sourceProvider && lead.sourceProviderId
      ? await findLeadBySourceIdentity(db, lead.agencyId, lead.sourceProvider, lead.sourceProviderId)
      : undefined;
  if (!existing) throw new Error("insertLead conflict without resolvable source identity");
  return existing;
}

export async function getLead(db: Kysely<Database>, leadId: string): Promise<LeadRow | undefined> {
  return await db.selectFrom("leads").selectAll().where("id", "=", leadId).executeTakeFirst();
}

/**
 * Provenance upsert: a re-fetch of the same provider record for the same lead
 * refreshes snapshot/retrieved_at/request_id instead of duplicating rows.
 */
export async function upsertLeadSource(
  db: Kysely<Database>,
  input: {
    leadId: string;
    runId?: string | null;
    runItemId?: string | null;
    provider: string;
    providerRecordId?: string | null;
    requestId?: string | null;
    snapshot: unknown;
    retrievedAt?: Date;
  },
): Promise<LeadSourceRow> {
  const inserted = await db
    .insertInto("lead_sources")
    .values({
      lead_id: input.leadId,
      run_id: input.runId ?? null,
      run_item_id: input.runItemId ?? null,
      provider: input.provider,
      provider_record_id: input.providerRecordId ?? null,
      request_id: input.requestId ?? null,
      snapshot: toJson(input.snapshot),
      ...(input.retrievedAt ? { retrieved_at: input.retrievedAt } : {}),
    })
    .onConflict((oc) =>
      oc
        .columns(["provider", "provider_record_id", "lead_id"])
        .where("provider_record_id", "is not", null)
        .doUpdateSet({
          snapshot: toJson(input.snapshot),
          request_id: input.requestId ?? null,
          retrieved_at: input.retrievedAt ?? new Date(),
          run_id: input.runId ?? null,
          run_item_id: input.runItemId ?? null,
        }),
    )
    .returningAll()
    .executeTakeFirst();
  if (inserted) return inserted;
  throw new Error("upsertLeadSource returned no row");
}

export interface NewContactPoint {
  leadId: string;
  type: "phone" | "email";
  role: PhoneRole | EmailRole;
  rawValue: string;
  normalizedValue: string | null;
  sourceProvider: string;
  sourceRunItemId?: string | null;
  sourceMetadata?: Record<string, unknown>;
  confidence?: number | null;
  formatValid?: boolean | null;
  formatCheckedAt?: Date | null;
  /** Email rows are always inserted with an email_status ('not_checked' unless verified). */
  emailStatus?: EmailStatus;
  emailStatusCheckedAt?: Date | null;
  emailStatusProvider?: string | null;
}

/**
 * One provider's result never overwrites another's: the partial unique index
 * (lead, type, normalized_value, source_provider) makes a replayed step an
 * upsert while distinct providers keep separate rows. Existing rows are NOT
 * updated here — validation history is append-only via contact_point_checks.
 */
export async function insertContactPoint(db: Kysely<Database>, cp: NewContactPoint): Promise<ContactPointRow> {
  const emailFields =
    cp.type === "email"
      ? {
          email_status: cp.emailStatus ?? ("not_checked" as const),
          email_status_checked_at: cp.emailStatusCheckedAt ?? null,
          email_status_provider: cp.emailStatusProvider ?? null,
        }
      : {};
  const inserted = await db
    .insertInto("contact_points")
    .values({
      lead_id: cp.leadId,
      type: cp.type,
      role: cp.role,
      raw_value: cp.rawValue,
      normalized_value: cp.normalizedValue,
      source_provider: cp.sourceProvider,
      source_run_item_id: cp.sourceRunItemId ?? null,
      source_metadata: toJson(cp.sourceMetadata ?? {}),
      confidence: cp.confidence ?? null,
      format_valid: cp.formatValid ?? null,
      format_checked_at: cp.formatCheckedAt ?? null,
      ...emailFields,
    })
    .onConflict((oc) => oc.doNothing())
    .returningAll()
    .executeTakeFirst();
  if (inserted) return inserted;
  const existing = await db
    .selectFrom("contact_points")
    .selectAll()
    .where("lead_id", "=", cp.leadId)
    .where("type", "=", cp.type)
    .where("normalized_value", "=", cp.normalizedValue)
    .where("source_provider", "=", cp.sourceProvider)
    .executeTakeFirst();
  if (!existing) throw new Error("insertContactPoint conflict without resolvable row");
  return existing;
}

export async function listContactPoints(db: Kysely<Database>, leadId: string): Promise<ContactPointRow[]> {
  return await db
    .selectFrom("contact_points")
    .selectAll()
    .where("lead_id", "=", leadId)
    .orderBy("created_at")
    .execute();
}

/** Append-only validation history. This repository exposes no UPDATE or DELETE for checks. */
export async function appendContactPointCheck(
  db: Kysely<Database>,
  check: {
    contactPointId: string;
    method: CheckMethod;
    provider: string;
    result: string;
    detail?: Record<string, unknown>;
    confidence?: number | null;
    requestId?: string | null;
    runItemStepId?: string | null;
    costUnits?: number;
    checkedAt?: Date;
  },
): Promise<void> {
  await db
    .insertInto("contact_point_checks")
    .values({
      contact_point_id: check.contactPointId,
      method: check.method,
      provider: check.provider,
      result: check.result,
      detail: toJson(check.detail ?? {}),
      confidence: check.confidence ?? null,
      request_id: check.requestId ?? null,
      run_item_step_id: check.runItemStepId ?? null,
      cost_units: check.costUnits ?? 0,
      ...(check.checkedAt ? { checked_at: check.checkedAt } : {}),
    })
    .execute();
}

export async function listContactPointChecks(
  db: Kysely<Database>,
  contactPointId: string,
): Promise<Selectable<Database["contact_point_checks"]>[]> {
  return await db
    .selectFrom("contact_point_checks")
    .selectAll()
    .where("contact_point_id", "=", contactPointId)
    .orderBy("checked_at", "desc")
    .execute();
}
