import type { Kysely, Selectable } from "kysely";

import type {
  CheckMethod,
  ContactPointsTable,
  Database,
  EmailRole,
  EmailStatus,
  IdentifierType,
  IdentityMatch,
  LeadsTable,
  LeadSourcesTable,
  LineStatus,
  LineType,
  PhoneRole,
} from "../database-types.js";
import { insertIdentityConflict } from "./identity-conflict-repo.js";
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
  placeId?: string | null;
  timezone?: string | null;
  /** M4 identity keys. verified_email is deliberately absent — no M4 writer. */
  apolloPersonId?: string | null;
  apolloOrganizationId?: string | null;
  normalizedLinkedinUrl?: string | null;
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

/** Person identity #1 (M4): Apollo's stable person id (hard unique). */
export async function findLeadByApolloPersonId(
  db: Kysely<Database>,
  agencyId: string,
  apolloPersonId: string,
): Promise<LeadRow | undefined> {
  return await db
    .selectFrom("leads")
    .selectAll()
    .where("agency_id", "=", agencyId)
    .where("apollo_person_id", "=", apolloPersonId)
    .executeTakeFirst();
}

/** Person identity #2 (M4): canonical LinkedIn profile URL (hard unique; approved sources only). */
export async function findLeadByLinkedinUrl(
  db: Kysely<Database>,
  agencyId: string,
  normalizedLinkedinUrl: string,
): Promise<LeadRow | undefined> {
  return await db
    .selectFrom("leads")
    .selectAll()
    .where("agency_id", "=", agencyId)
    .where("normalized_linkedin_url", "=", normalizedLinkedinUrl)
    .executeTakeFirst();
}

/** Business identity (M4): Apollo organization id — unique among kind='business' only. */
export async function findLeadByApolloOrgId(
  db: Kysely<Database>,
  agencyId: string,
  apolloOrganizationId: string,
): Promise<LeadRow | undefined> {
  return await db
    .selectFrom("leads")
    .selectAll()
    .where("agency_id", "=", agencyId)
    .where("apollo_organization_id", "=", apolloOrganizationId)
    .where("kind", "=", "business")
    .executeTakeFirst();
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
      place_id: lead.placeId ?? null,
      timezone: lead.timezone ?? null,
      apollo_person_id: lead.apolloPersonId ?? null,
      apollo_organization_id: lead.apolloOrganizationId ?? null,
      normalized_linkedin_url: lead.normalizedLinkedinUrl ?? null,
      metadata: toJson({}),
    })
    .onConflict((oc) => oc.doNothing())
    .returningAll()
    .executeTakeFirst();
  if (inserted) return inserted;
  // The DO NOTHING may have hit any hard-identity unique; try each key the
  // candidate carries, in identity-ladder order.
  const bySource =
    lead.sourceProvider && lead.sourceProviderId
      ? await findLeadBySourceIdentity(db, lead.agencyId, lead.sourceProvider, lead.sourceProviderId)
      : undefined;
  if (bySource) return bySource;
  const byApolloPerson = lead.apolloPersonId
    ? await findLeadByApolloPersonId(db, lead.agencyId, lead.apolloPersonId)
    : undefined;
  if (byApolloPerson) return byApolloPerson;
  const byLinkedin = lead.normalizedLinkedinUrl
    ? await findLeadByLinkedinUrl(db, lead.agencyId, lead.normalizedLinkedinUrl)
    : undefined;
  if (byLinkedin) return byLinkedin;
  const byOrg =
    lead.kind === "business" && lead.apolloOrganizationId
      ? await findLeadByApolloOrgId(db, lead.agencyId, lead.apolloOrganizationId)
      : undefined;
  if (byOrg) return byOrg;
  throw new Error("insertLead conflict without resolvable identity key");
}

export interface LeadIdentityKeys {
  apolloPersonId?: string | null;
  apolloOrganizationId?: string | null;
  normalizedLinkedinUrl?: string | null;
}

/**
 * Conflict-safe identity backfill (M4): set a hard identity key on a lead
 * only when no other lead already holds it; a held key becomes an
 * identity_conflicts row and the column stays NULL (flag, never merge). An
 * existing DIFFERENT value on the lead itself is kept unchanged — provider
 * drift on one lead is not a two-lead conflict. Select-then-update is
 * driver-portable; the run lease serializes writers, and a cross-run race
 * surfaces as a unique violation that retries into this conflict path.
 */
export async function setLeadIdentityKeys(
  db: Kysely<Database>,
  args: { leadId: string; agencyId: string; runId?: string | null; keys: LeadIdentityKeys },
): Promise<{ conflicts: IdentifierType[] }> {
  const lead = await getLead(db, args.leadId);
  if (!lead) throw new Error(`setLeadIdentityKeys: lead ${args.leadId} not found`);
  const conflicts: IdentifierType[] = [];
  const updates: Partial<Record<"apollo_person_id" | "apollo_organization_id" | "normalized_linkedin_url", string>> = {};

  const consider = async (
    column: "apollo_person_id" | "apollo_organization_id" | "normalized_linkedin_url",
    identifierType: IdentifierType,
    value: string | null | undefined,
    findHolder: (() => Promise<LeadRow | undefined>) | null,
  ) => {
    if (!value) return;
    if (lead[column] !== null) return; // keep the existing value, same or different
    const holder = findHolder ? await findHolder() : undefined;
    if (holder && holder.id !== args.leadId) {
      conflicts.push(identifierType);
      await insertIdentityConflict(db, {
        leadIdA: holder.id,
        leadIdB: args.leadId,
        identifierType,
        identifierValue: value,
        runId: args.runId ?? null,
      });
      return;
    }
    updates[column] = value;
  };

  await consider("apollo_person_id", "apollo_person_id", args.keys.apolloPersonId, () =>
    findLeadByApolloPersonId(db, args.agencyId, args.keys.apolloPersonId!),
  );
  await consider("normalized_linkedin_url", "normalized_linkedin_url", args.keys.normalizedLinkedinUrl, () =>
    findLeadByLinkedinUrl(db, args.agencyId, args.keys.normalizedLinkedinUrl!),
  );
  // The org key is an identity only for business leads; on a person lead it is
  // a non-unique employer reference and needs no holder check.
  await consider(
    "apollo_organization_id",
    "apollo_organization_id",
    args.keys.apolloOrganizationId,
    lead.kind === "business" ? () => findLeadByApolloOrgId(db, args.agencyId, args.keys.apolloOrganizationId!) : null,
  );

  if (Object.keys(updates).length > 0) {
    await db
      .updateTable("leads")
      .set({ ...updates, updated_at: new Date() })
      .where("id", "=", args.leadId)
      .execute();
  }
  return { conflicts };
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

/**
 * The sanctioned "current best signal" denormalization writer (M5): sets a
 * validation signal TOGETHER with its checked_at + provider pair (the paired
 * CHECK constraints make partial writes impossible). History stays append-only
 * in contact_point_checks — this only moves the current-best columns.
 */
export async function updateContactPointSignals(
  db: Kysely<Database>,
  contactPointId: string,
  patch: {
    provider: string;
    checkedAt: Date;
    lineType?: LineType;
    lineStatus?: LineStatus;
    identityMatch?: IdentityMatch;
    emailStatus?: Exclude<EmailStatus, "not_checked">;
    formatValid?: boolean;
    confidence?: number | null;
  },
): Promise<void> {
  await db
    .updateTable("contact_points")
    .set({
      ...(patch.lineType !== undefined
        ? { line_type: patch.lineType, line_type_checked_at: patch.checkedAt, line_type_provider: patch.provider }
        : {}),
      ...(patch.lineStatus !== undefined
        ? { line_status: patch.lineStatus, line_status_checked_at: patch.checkedAt, line_status_provider: patch.provider }
        : {}),
      ...(patch.identityMatch !== undefined
        ? {
            identity_match: patch.identityMatch,
            identity_match_checked_at: patch.checkedAt,
            identity_match_provider: patch.provider,
          }
        : {}),
      ...(patch.emailStatus !== undefined
        ? {
            email_status: patch.emailStatus,
            email_status_checked_at: patch.checkedAt,
            email_status_provider: patch.provider,
          }
        : {}),
      ...(patch.formatValid !== undefined
        ? { format_valid: patch.formatValid, format_checked_at: patch.checkedAt }
        : {}),
      ...(patch.confidence !== undefined ? { confidence: patch.confidence } : {}),
      updated_at: new Date(),
    })
    .where("id", "=", contactPointId)
    .execute();
}

export async function findLeadByVerifiedEmail(
  db: Kysely<Database>,
  agencyId: string,
  email: string,
): Promise<LeadRow | undefined> {
  return await db
    .selectFrom("leads")
    .selectAll()
    .where("agency_id", "=", agencyId)
    .where("verified_email", "=", email)
    .executeTakeFirst();
}

/**
 * The FIRST (and only) writer of leads.verified_email: an email_verification
 * result of 'valid'. Mirrors setLeadIdentityKeys' conflict handling — an
 * existing value on the lead is kept unchanged; another lead already holding
 * the value flags an identity conflict and leaves the column NULL (never an
 * automatic merge).
 */
export async function setVerifiedEmail(
  db: Kysely<Database>,
  args: { leadId: string; agencyId: string; runId?: string | null; email: string },
): Promise<{ set: boolean; conflict: boolean }> {
  const lead = await getLead(db, args.leadId);
  if (!lead) throw new Error(`setVerifiedEmail: lead ${args.leadId} not found`);
  if (lead.verified_email !== null) return { set: lead.verified_email === args.email, conflict: false };
  const holder = await findLeadByVerifiedEmail(db, args.agencyId, args.email);
  if (holder && holder.id !== args.leadId) {
    await insertIdentityConflict(db, {
      leadIdA: holder.id,
      leadIdB: args.leadId,
      identifierType: "verified_email",
      identifierValue: args.email,
      runId: args.runId ?? null,
    });
    return { set: false, conflict: true };
  }
  await db
    .updateTable("leads")
    .set({ verified_email: args.email, updated_at: new Date() })
    .where("id", "=", args.leadId)
    .execute();
  return { set: true, conflict: false };
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
