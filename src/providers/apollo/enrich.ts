import type { EnrichOutcome, EnrichProvider, EnrichRequest } from "../types.js";
import type { ApolloClient, ApolloPerson } from "./client.js";
import { apolloPersonSchema } from "./client.js";

/** Apollo returns this placeholder when an email exists but was not unlocked — it is NOT an address. */
const LOCKED_EMAIL_RE = /^email_not_unlocked@/i;

export interface ApolloEnrichOptions {
  client: ApolloClient;
  costPerRecord?: number;
}

/**
 * Person enrichment over Apollo people/match, behind the provider-neutral
 * `person-enrichment` name (ADR-028). Consumes ~1 credit when data is
 * returned; a 200 without a person is a free no_match (the lead remains
 * valid). Match inputs prefer stable identifiers over name matching:
 * apollo person id → linkedin url → name + employer domain/name.
 *
 * idempotentReplay is FALSE: Apollo accepts no idempotency key and has no
 * per-request ledger to reconcile against, so the runner books any crash
 * replay of an interrupted paid attempt as ambiguous → needs_review instead
 * of calling again (see the client docblock for the full contract).
 *
 * Contact-data honesty: the returned work email is discovery, not
 * verification — the engine stores it as email_status='not_checked' and keeps
 * Apollo's own claim only as data (emailStatusClaim). Phone reveal requires
 * Apollo's async webhook flow and is deferred to M5; this adapter never
 * returns phones.
 */
export class ApolloEnrichProvider implements EnrichProvider {
  readonly name = "person-enrichment";
  readonly costPerRecord: number;
  readonly idempotentReplay = false;
  private readonly client: ApolloClient;

  constructor(opts: ApolloEnrichOptions) {
    this.client = opts.client;
    this.costPerRecord = opts.costPerRecord ?? 1;
  }

  async enrich(request: EnrichRequest): Promise<EnrichOutcome> {
    const response = await this.client.matchPerson({
      apolloPersonId: request.apolloPersonId,
      linkedinUrl: request.normalizedLinkedinUrl ? `https://www.${request.normalizedLinkedinUrl}` : null,
      firstName: request.firstName,
      lastName: request.lastName,
      // For a business lead (local/imported) the display name is the company;
      // only pass it as the person name when the record IS a person.
      name: request.kind === "person" ? request.name : null,
      organizationName: request.employerName ?? (request.kind === "person" ? null : request.name),
      domain: request.employerDomain ?? request.normalizedDomain,
    });

    const parsed = response.person ? apolloPersonSchema.safeParse(response.person) : null;
    if (!parsed || !parsed.success) {
      // 200 without a usable person: Apollo charges only when data is returned.
      return { kind: "no_match", cost: 0, providerRequestId: request.requestKey };
    }
    const person: ApolloPerson = parsed.data;
    const rawEmail = person.email ?? undefined;
    const workEmail = rawEmail && !LOCKED_EMAIL_RE.test(rawEmail) ? rawEmail : undefined;

    return {
      kind: "match",
      cost: this.costPerRecord,
      // No provider request id exists; the engine request key is the fallback.
      providerRequestId: request.requestKey,
      person: {
        firstName: person.first_name ?? "",
        lastName: person.last_name ?? "",
        title: person.title ?? "",
        ...(workEmail ? { workEmail } : {}),
        ...(person.email_status && workEmail ? { emailStatusClaim: person.email_status } : {}),
        apolloPersonId: person.id,
        ...(person.organization?.id ? { apolloOrganizationId: person.organization.id } : {}),
        ...(person.linkedin_url ? { linkedinUrl: person.linkedin_url } : {}),
      },
    };
  }
}
