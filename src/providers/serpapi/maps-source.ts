import { AppError } from "../../shared/errors.js";
import type { PagedPaidSource, SourceQuery, SourceRecord, SourceRequestSpec } from "../types.js";
import type { SerpApiClient, SerpApiLocalResult, SerpApiMapsResponse } from "./client.js";
import { serpApiLocalResultSchema } from "./client.js";
import { extractSourceKey, parseUsAddress } from "./identity.js";

const RESULTS_PER_PAGE = 20;

export interface SerpApiSourceOptions {
  client: SerpApiClient;
  /** Billing unit per search; SerpAPI is a flat one-search-per-request. */
  creditsPerRequest?: number;
  /** Page ceiling for the coordinate (`ll`) pagination path. */
  maxPagesPerQuery?: number;
}

interface ResolvedRequest {
  spec: SourceRequestSpec;
  q: string;
  ll?: string;
  start?: number;
  location: string | undefined;
}

/**
 * SerpAPI's documented `ll` form is exactly `@lat,lon,zoomz` (e.g.
 * `@30.26,-97.74,12z`). Anything looser (missing zoom, missing `z`) would be
 * forwarded verbatim and rejected by the vendor at execution — AFTER approval —
 * so near-miss coordinate forms deliberately fall back to named-location
 * handling, which always works.
 */
function asCoordinate(location: string | undefined): string | null {
  if (!location) return null;
  return /^@-?\d{1,2}(\.\d+)?,-?\d{1,3}(\.\d+)?,\d{1,2}(\.\d+)?z$/.test(location.trim()) ? location.trim() : null;
}

/**
 * Local-business discovery over SerpAPI's Google Maps engine, behind the
 * provider-neutral `local-business` name (ADR-024). One request per location by
 * default — a plain place name only yields page 1 (~20 listings) because
 * SerpAPI needs `ll` (GPS coords) to paginate; a location given in coordinate
 * form `@lat,lon,zoom` is paginated up to the page ceiling. Volume otherwise
 * scales by adding locations. A future name→coordinate geocoder would enable
 * deep per-metro pagination (M3+).
 */
export class SerpApiLocalBusinessSource implements PagedPaidSource {
  readonly name = "local-business";
  private readonly client: SerpApiClient;
  private readonly creditsPerRequest: number;
  private readonly maxPagesPerQuery: number;

  constructor(opts: SerpApiSourceOptions) {
    this.client = opts.client;
    this.creditsPerRequest = opts.creditsPerRequest ?? 1;
    this.maxPagesPerQuery = Math.max(1, opts.maxPagesPerQuery ?? 6);
  }

  private resolveRequests(query: SourceQuery): ResolvedRequest[] {
    const businessType = (query.businessType ?? "").trim();
    const locations = query.locations && query.locations.length > 0 ? query.locations : [undefined];
    const share = Math.ceil(query.limit / Math.max(1, locations.length));
    const out: ResolvedRequest[] = [];
    let index = 0;
    for (const location of locations) {
      const coord = asCoordinate(location);
      if (coord) {
        const pages = Math.min(this.maxPagesPerQuery, Math.max(1, Math.ceil(share / RESULTS_PER_PAGE)));
        for (let page = 0; page < pages; page += 1) {
          out.push({
            spec: { index, descriptor: `maps:${businessType}:${coord}:p${page}`, estimatedCost: this.creditsPerRequest },
            q: businessType,
            ll: coord,
            start: page * RESULTS_PER_PAGE,
            location,
          });
          index += 1;
        }
      } else {
        const q = location ? `${businessType} ${location}`.trim() : businessType;
        out.push({
          spec: { index, descriptor: `maps:${businessType}:${location ?? "(none)"}:p0`, estimatedCost: this.creditsPerRequest },
          q,
          location,
        });
        index += 1;
      }
    }
    return out;
  }

  planSearchRequests(query: SourceQuery): SourceRequestSpec[] {
    return this.resolveRequests(query).map((r) => r.spec);
  }

  estimateSearchCost(query: SourceQuery): { requests: number; creditsPerRequest: number } {
    return { requests: this.resolveRequests(query).length, creditsPerRequest: this.creditsPerRequest };
  }

  async executeSearchRequest(
    spec: SourceRequestSpec,
    query: SourceQuery,
    opts: { requestKey: string },
  ): Promise<{ records: SourceRecord[]; providerRequestId: string; cost: number; coverageNote: string }> {
    const resolved = this.resolveRequests(query).find((r) => r.spec.index === spec.index);
    if (!resolved) throw new AppError("INTERNAL", `No SerpAPI request planned for index ${spec.index}.`, { index: spec.index });

    const response = await this.client.searchMaps({ q: resolved.q, ll: resolved.ll, start: resolved.start });
    // Per-item validation: a charged 200 with one odd listing keeps its other
    // records (dropped listings are counted into the coverage note). A very
    // specific query may answer with a single place_results object instead.
    const rawListings = response.local_results ?? (response.place_results ? [response.place_results] : []);
    const records: SourceRecord[] = [];
    let dropped = 0;
    for (const raw of rawListings) {
      const parsed = serpApiLocalResultSchema.safeParse(raw);
      const record = parsed.success ? toRecord(parsed.data) : null;
      if (record) records.push(record);
      else dropped += 1;
    }

    return {
      records,
      providerRequestId: response.search_metadata?.id ?? opts.requestKey,
      cost: this.creditsPerRequest,
      coverageNote: coverageNote(resolved, records.length, dropped, response),
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

function toRecord(listing: SerpApiLocalResult): SourceRecord | null {
  if (!listing.title) return null;
  const parsed = parseUsAddress(listing.address);
  const sourceUrl = listing.data_cid
    ? `https://www.google.com/maps?cid=${listing.data_cid}`
    : listing.place_id
      ? `https://www.google.com/maps/place/?q=place_id:${listing.place_id}`
      : undefined;
  return {
    sourceKey: extractSourceKey(listing),
    name: listing.title,
    category: listing.type ?? listing.types?.[0],
    address: parsed.addressLine ?? listing.address,
    locality: parsed.locality ?? undefined,
    region: parsed.region ?? undefined,
    country: parsed.country ?? undefined,
    phone: listing.phone,
    website: listing.website,
    rating: listing.rating,
    reviewCount: listing.reviews,
    sourceUrl,
  };
}

function coverageNote(resolved: ResolvedRequest, kept: number, dropped: number, response: SerpApiMapsResponse): string {
  const near = resolved.location ? ` near '${resolved.location}'` : "";
  const page = resolved.ll ? "" : " (page 1 only — supply coordinates to paginate)";
  const droppedNote = dropped > 0 ? ` ${dropped} listing(s) dropped as unparseable.` : "";
  const emptyNote = response.error ? ` Provider note: ${response.error.slice(0, 120)}` : "";
  return `Google Maps via SerpAPI for '${resolved.q}'${near}: ${kept} listing(s)${page}. Google ranking; one provider is not complete coverage.${droppedNote}${emptyNote}`;
}
