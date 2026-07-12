import { checksumOf } from "../../shared/checksum.js";
import type { SourceProvider, SourceQuery, SourceRecord } from "../types.js";
import { FIXTURE_BUSINESSES } from "./fixtures.js";

/**
 * Places-like fake source: deterministic, offline, free. Returns the fixture
 * businesses up to `limit` with a stable per-query request id.
 */
export class FakeSourceProvider implements SourceProvider {
  readonly name = "fake-places";

  search(query: SourceQuery): Promise<{ records: SourceRecord[]; requestId: string; coverageNote?: string }> {
    const records = FIXTURE_BUSINESSES.slice(0, query.limit).map((f) => ({
      sourceKey: f.sourceKey,
      name: f.name,
      category: f.category,
      address: f.address,
      locality: f.locality,
      region: f.region,
      country: f.country,
      phone: f.phone,
      website: f.website,
      rating: f.rating,
      reviewCount: f.reviewCount,
    }));
    return Promise.resolve({
      records,
      requestId: `fake-places-${checksumOf(query).slice(0, 12)}`,
      coverageNote: `fixture dataset (${FIXTURE_BUSINESSES.length} businesses); one provider never equals complete market coverage`,
    });
  }
}
