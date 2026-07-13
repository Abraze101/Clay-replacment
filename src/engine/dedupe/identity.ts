import type { Kysely } from "kysely";

import type { Database } from "../../storage/database-types.js";
import {
  findLeadByApolloPersonId,
  findLeadByLinkedinUrl,
  findLeadBySourceIdentity,
  findLeadsByDomain,
  findLeadsByPhoneLocality,
} from "../../storage/repositories/lead-repo.js";
import { nameKey } from "../records/normalize.js";

/**
 * Stable identity resolution (schema doc §5):
 * - Hard identity: (agency, source_provider, source_provider_id) — a match is
 *   the same record re-sourced.
 * - Person hard identity (M4): apollo_person_id — a provider-stable id matches
 *   unconditionally, like the source identity.
 * - Weak identifiers collide legitimately, so they resolve in code: same
 *   identifier + same normalized name → matched; same identifier + different
 *   name → CONFLICT (flag, never merge, never merge on name alone). For
 *   businesses these are normalized domain and phone+locality; for persons the
 *   canonical LinkedIn URL. Persons deliberately SKIP the business weak
 *   identifiers — colleagues sharing an employer domain are not duplicates.
 */
export type IdentityResolution =
  | { kind: "new" }
  | {
      kind: "matched";
      leadId: string;
      via: "source_identity" | "apollo_person_id" | "linkedin" | "domain" | "phone_locality";
    }
  | {
      kind: "conflict";
      leadId: string;
      identifier: "normalized_domain" | "normalized_phone_locality" | "normalized_linkedin_url";
      value: string;
    };

export interface IdentityCandidate {
  agencyId: string;
  kind: "business" | "person";
  sourceProvider: string;
  sourceProviderId: string;
  displayName: string;
  normalizedDomain: string | null;
  normalizedPhone: string | null;
  locality: string | null;
  apolloPersonId?: string | null;
  normalizedLinkedinUrl?: string | null;
}

export async function resolveIdentity(db: Kysely<Database>, candidate: IdentityCandidate): Promise<IdentityResolution> {
  const bySource = await findLeadBySourceIdentity(
    db,
    candidate.agencyId,
    candidate.sourceProvider,
    candidate.sourceProviderId,
  );
  if (bySource) return { kind: "matched", leadId: bySource.id, via: "source_identity" };

  const candidateName = nameKey(candidate.displayName);

  if (candidate.kind === "person") {
    if (candidate.apolloPersonId) {
      const byApollo = await findLeadByApolloPersonId(db, candidate.agencyId, candidate.apolloPersonId);
      if (byApollo) return { kind: "matched", leadId: byApollo.id, via: "apollo_person_id" };
    }
    if (candidate.normalizedLinkedinUrl) {
      const byLinkedin = await findLeadByLinkedinUrl(db, candidate.agencyId, candidate.normalizedLinkedinUrl);
      if (byLinkedin) {
        if (nameKey(byLinkedin.display_name) === candidateName) {
          return { kind: "matched", leadId: byLinkedin.id, via: "linkedin" };
        }
        return {
          kind: "conflict",
          leadId: byLinkedin.id,
          identifier: "normalized_linkedin_url",
          value: candidate.normalizedLinkedinUrl,
        };
      }
    }
    return { kind: "new" };
  }

  if (candidate.normalizedDomain) {
    const byDomain = await findLeadsByDomain(db, candidate.agencyId, candidate.normalizedDomain);
    for (const lead of byDomain) {
      if (nameKey(lead.display_name) === candidateName) {
        return { kind: "matched", leadId: lead.id, via: "domain" };
      }
    }
    const first = byDomain[0];
    if (first) {
      return { kind: "conflict", leadId: first.id, identifier: "normalized_domain", value: candidate.normalizedDomain };
    }
  }

  if (candidate.normalizedPhone) {
    const byPhone = await findLeadsByPhoneLocality(
      db,
      candidate.agencyId,
      candidate.normalizedPhone,
      candidate.locality,
    );
    for (const lead of byPhone) {
      if (nameKey(lead.display_name) === candidateName) {
        return { kind: "matched", leadId: lead.id, via: "phone_locality" };
      }
    }
    const first = byPhone[0];
    if (first) {
      return {
        kind: "conflict",
        leadId: first.id,
        identifier: "normalized_phone_locality",
        value: `${candidate.normalizedPhone}@${candidate.locality ?? ""}`,
      };
    }
  }

  return { kind: "new" };
}
