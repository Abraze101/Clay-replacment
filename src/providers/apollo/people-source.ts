import { AppError } from "../../shared/errors.js";
import type { PagedPaidSource, SourceQuery, SourceRecord, SourceRequestSpec } from "../types.js";
import type { ApolloClient, ApolloPerson } from "./client.js";
import { apolloPersonSchema } from "./client.js";

const RESULTS_PER_PAGE = 100;

export interface ApolloPeopleSourceOptions {
  client: ApolloClient;
  /** Page ceiling per query (100 hits/page; inputs.limit ≤ 500 → ≤ 5 pages). */
  maxPagesPerQuery?: number;
}

interface ResolvedRequest {
  spec: SourceRequestSpec;
  page: number;
}

/**
 * Professional-contact discovery over Apollo people search, behind the
 * provider-neutral `professional-contacts` name (ADR-028). Implemented as a
 * ZERO-COST PagedPaidSource: the search endpoint consumes no Apollo credits,
 * but the durable run_source_requests ledger still buys crash replay,
 * per-request coverage notes, and — critically — the 429 → resume_at pause
 * path that Apollo's tight per-minute/per-day limits need.
 *
 * Search returns NO emails or phone numbers (none are fabricated), and free
 * plans may obfuscate last names — both stated in the coverage note. Titles
 * and locations travel in ONE query body; volume scales by pagination.
 */
export class ApolloPeopleSource implements PagedPaidSource {
  readonly name = "professional-contacts";
  private readonly client: ApolloClient;
  private readonly maxPagesPerQuery: number;

  constructor(opts: ApolloPeopleSourceOptions) {
    this.client = opts.client;
    this.maxPagesPerQuery = Math.max(1, opts.maxPagesPerQuery ?? 5);
  }

  private resolveRequests(query: SourceQuery): ResolvedRequest[] {
    const titles = (query.personTitles ?? []).join("|") || "(any)";
    const locations = (query.locations ?? []).join("|") || "(any)";
    const keywords = (query.businessType ?? "").trim();
    const pages = Math.min(this.maxPagesPerQuery, Math.max(1, Math.ceil(query.limit / RESULTS_PER_PAGE)));
    return Array.from({ length: pages }, (_unused, page) => ({
      spec: {
        index: page,
        descriptor: `apollo:people:${keywords || "(none)"}:${titles}:${locations}:p${page + 1}`,
        estimatedCost: 0,
      },
      page: page + 1,
    }));
  }

  planSearchRequests(query: SourceQuery): SourceRequestSpec[] {
    return this.resolveRequests(query).map((r) => r.spec);
  }

  estimateSearchCost(query: SourceQuery): { requests: number; creditsPerRequest: number } {
    return { requests: this.resolveRequests(query).length, creditsPerRequest: 0 };
  }

  async executeSearchRequest(
    spec: SourceRequestSpec,
    query: SourceQuery,
    opts: { requestKey: string },
  ): Promise<{ records: SourceRecord[]; providerRequestId: string; cost: number; coverageNote: string }> {
    const resolved = this.resolveRequests(query).find((r) => r.spec.index === spec.index);
    if (!resolved) throw new AppError("INTERNAL", `No Apollo request planned for index ${spec.index}.`, { index: spec.index });

    const response = await this.client.searchPeople({
      personTitles: query.personTitles,
      personLocations: query.locations,
      qKeywords: query.businessType?.trim() || undefined,
      page: resolved.page,
      perPage: RESULTS_PER_PAGE,
    });

    // Per-item validation: one malformed hit keeps the response's other
    // records (dropped hits are counted into the coverage note).
    const rawHits = [...(response.people ?? []), ...(response.contacts ?? [])];
    const records: SourceRecord[] = [];
    let dropped = 0;
    for (const raw of rawHits) {
      const parsed = apolloPersonSchema.safeParse(raw);
      const record = parsed.success ? toRecord(parsed.data) : null;
      if (record) records.push(record);
      else dropped += 1;
    }

    const totalPages = response.pagination?.total_pages;
    const totalEntries = response.pagination?.total_entries;
    return {
      records,
      // Apollo returns no request id; the engine's request key is the fallback.
      providerRequestId: opts.requestKey,
      cost: 0,
      coverageNote:
        `Apollo people search page ${resolved.page}${totalPages ? ` of ${totalPages}` : ""}` +
        `${totalEntries !== undefined ? ` (~${totalEntries} total match the filters)` : ""}: ${records.length} people.` +
        ` No contact data at search time; last names may be partial on free plans.` +
        ` One provider is not complete market coverage.` +
        (dropped > 0 ? ` ${dropped} hit(s) dropped as unparseable.` : ""),
    };
  }

  /** Base contract — provided for symmetry; the runner uses the paged path. */
  async search(query: SourceQuery): Promise<{ records: SourceRecord[]; requestId: string; coverageNote?: string }> {
    const specs = this.planSearchRequests(query);
    const records: SourceRecord[] = [];
    let requestId = "";
    let note = "";
    for (const spec of specs) {
      const r = await this.executeSearchRequest(spec, query, { requestKey: `direct:${spec.index}` });
      records.push(...r.records);
      requestId = r.providerRequestId;
      note = r.coverageNote;
    }
    return { records, requestId, coverageNote: note };
  }
}

function toRecord(person: ApolloPerson): SourceRecord | null {
  const name = person.name ?? [person.first_name, person.last_name].filter(Boolean).join(" ");
  if (!name) return null;
  const organization = person.organization ?? undefined;
  return {
    sourceKey: person.id,
    name,
    kind: "person",
    title: person.title ?? undefined,
    locality: person.city ?? undefined,
    region: person.state ?? undefined,
    country: person.country ?? undefined,
    // Search returns NO emails/phones — nothing contact-shaped is emitted.
    linkedinUrl: person.linkedin_url ?? undefined,
    sourceUrl: person.linkedin_url ?? undefined,
    person: {
      firstName: person.first_name ?? undefined,
      lastName: person.last_name ?? undefined,
      apolloPersonId: person.id,
      ...(organization
        ? {
            employer: {
              name: organization.name ?? undefined,
              websiteUrl: organization.website_url ?? undefined,
              domain: organization.primary_domain ?? undefined,
              apolloOrganizationId: organization.id ?? undefined,
            },
          }
        : {}),
    },
  };
}
