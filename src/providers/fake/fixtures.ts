import type { EnrichPerson, SourceRecord } from "../types.js";

/**
 * Deterministic fake dataset (~15 businesses) covering the M0 plan's required
 * cases: shared-domain, shared-phone, conflicting-identifier (within-run
 * duplicate), no-match-survivor, flaky, always-broken (charged failure),
 * ambiguous-outcome, website-unavailable, filtered-out, and format-invalid
 * phones. No real businesses, people, or reachable endpoints.
 */
export type EnrichBehavior = "match" | "no_match" | "flaky" | "always_broken_charged" | "ambiguous";

export interface FixtureBusiness extends SourceRecord {
  enrichBehavior: EnrichBehavior;
  researchUnavailable?: boolean;
  person?: EnrichPerson;
}

export const FIXTURE_BUSINESSES: readonly FixtureBusiness[] = [
  {
    sourceKey: "fx-001",
    name: "Austin Roof Pros",
    category: "roofing contractor",
    address: "101 Congress Ave",
    locality: "Austin",
    region: "TX",
    country: "US",
    phone: "(512) 555-0101",
    website: "https://www.austinroofpros.com",
    rating: 4.8,
    reviewCount: 120,
    enrichBehavior: "match",
    person: {
      firstName: "Rita",
      lastName: "Vaughn",
      title: "Owner",
      directPhone: "(512) 555-0161",
      workEmail: "rita@austinroofpros.com",
    },
  },
  {
    sourceKey: "fx-002",
    name: "Hill Country Roofing",
    category: "roofing contractor",
    address: "88 Ranch Rd",
    locality: "Dripping Springs",
    region: "TX",
    country: "US",
    phone: "(512) 555-0102",
    rating: 4.2,
    reviewCount: 30,
    // No website and no enrichment match: must remain a valid business lead.
    enrichBehavior: "no_match",
  },
  {
    sourceKey: "fx-003",
    name: "ATX Plumbing Co",
    category: "plumber",
    address: "9 Barton Springs Rd",
    locality: "Austin",
    region: "TX",
    country: "US",
    phone: "(512) 555-0103",
    website: "https://www.sharedplumbing.com/atx",
    rating: 4.5,
    reviewCount: 64,
    enrichBehavior: "no_match",
  },
  {
    sourceKey: "fx-004",
    name: "Round Rock Plumbing Group",
    category: "plumber",
    address: "42 Main St",
    locality: "Round Rock",
    region: "TX",
    country: "US",
    phone: "(512) 555-0104",
    // SAME registrable domain as fx-003 with a different name → weak-identifier
    // conflict: flag, never merge.
    website: "https://www.sharedplumbing.com/roundrock",
    rating: 4.1,
    reviewCount: 22,
    enrichBehavior: "no_match",
  },
  {
    sourceKey: "fx-005",
    name: "Iron Works Gym",
    category: "gym",
    address: "500 Lamar Blvd",
    locality: "Austin",
    region: "TX",
    country: "US",
    phone: "(512) 555-0105",
    website: "https://www.ironworksgymatx.com",
    rating: 4.6,
    reviewCount: 210,
    enrichBehavior: "no_match",
  },
  {
    sourceKey: "fx-006",
    name: "Lakeside Fitness Studio",
    category: "gym",
    address: "500 Lamar Blvd Suite B",
    locality: "Austin",
    region: "TX",
    country: "US",
    // SAME phone + locality as fx-005 with a different name (shared reception
    // line) → weak-identifier conflict: flag, never merge.
    phone: "(512) 555-0105",
    rating: 4.0,
    reviewCount: 15,
    enrichBehavior: "no_match",
  },
  {
    sourceKey: "fx-007",
    name: "Austin Roof Pros",
    category: "roofing contractor",
    address: "101 Congress Ave (duplicate listing)",
    locality: "Austin",
    region: "TX",
    country: "US",
    phone: "(512) 555-0101",
    // Same domain AND same name as fx-001 under a second source key → the
    // same lead surfacing twice within one run (conflicting identifiers).
    website: "https://austinroofpros.com/contact",
    rating: 4.8,
    reviewCount: 118,
    enrichBehavior: "no_match",
  },
  {
    sourceKey: "fx-008",
    name: "Bee Cave Roofing",
    category: "roofing contractor",
    address: "77 Bee Cave Pkwy",
    locality: "Bee Cave",
    region: "TX",
    country: "US",
    phone: "(512) 555-0108",
    website: "https://www.beecaveroofing.com",
    rating: 4.4,
    reviewCount: 41,
    enrichBehavior: "no_match",
  },
  {
    sourceKey: "fx-009",
    name: "Flaky Gutters LLC",
    category: "gutter service",
    address: "12 Rainy Ln",
    locality: "Austin",
    region: "TX",
    country: "US",
    phone: "(512) 555-0109",
    website: "https://www.flakygutters.com",
    rating: 4.3,
    reviewCount: 37,
    // First enrichment call fails retryably (uncharged); the bounded retry succeeds.
    enrichBehavior: "flaky",
    person: {
      firstName: "Gus",
      lastName: "Trench",
      title: "Owner",
      directPhone: "(512) 555-0169",
      workEmail: "gus@flakygutters.com",
    },
  },
  {
    sourceKey: "fx-010",
    name: "Broken Data Roofing",
    category: "roofing contractor",
    address: "404 Nowhere St",
    locality: "Austin",
    region: "TX",
    country: "US",
    phone: "(512) 555-0110",
    website: "https://www.brokendataroofing.com",
    rating: 3.9,
    reviewCount: 12,
    // Every call fails retryably; the FIRST failed attempt still consumes a
    // credit (charged-but-failed protocol) and the item exhausts its attempts.
    enrichBehavior: "always_broken_charged",
  },
  {
    sourceKey: "fx-011",
    name: "Ambiguous Analytics Roofing",
    category: "roofing contractor",
    address: "50 Schroedinger Way",
    locality: "Austin",
    region: "TX",
    country: "US",
    phone: "(512) 555-0111",
    website: "https://www.ambiguousroofing.com",
    rating: 4.0,
    reviewCount: 19,
    // The provider may have completed (and charged) but cannot confirm:
    // the step must land in needs_review and never auto-retry.
    enrichBehavior: "ambiguous",
  },
  {
    sourceKey: "fx-012",
    name: "Ghost Site Renovations",
    category: "general contractor",
    address: "13 Phantom Rd",
    locality: "Pflugerville",
    region: "TX",
    country: "US",
    phone: "(512) 555-0112",
    website: "https://www.ghostsiterenovations.com",
    rating: 4.1,
    reviewCount: 26,
    enrichBehavior: "no_match",
    // Website research is unavailable: continue with source data, mark incomplete.
    researchUnavailable: true,
  },
  {
    sourceKey: "fx-013",
    name: "Cash Only Handyman",
    category: "handyman",
    address: "1 Alley Way",
    locality: "Austin",
    region: "TX",
    country: "US",
    // No website AND an unparseable phone → the demo filter drops it.
    phone: "call us maybe",
    rating: 2.1,
    reviewCount: 2,
    enrichBehavior: "no_match",
  },
  {
    sourceKey: "fx-014",
    name: "Premier HVAC Solutions",
    category: "hvac contractor",
    address: "900 Industrial Blvd",
    locality: "Cedar Park",
    region: "TX",
    country: "US",
    phone: "(512) 555-0114",
    website: "https://www.premierhvacsolutions.com",
    rating: 4.9,
    reviewCount: 302,
    enrichBehavior: "match",
    person: {
      firstName: "Dana",
      lastName: "Whitfield",
      title: "General Manager",
      directPhone: "(512) 555-0164",
      workEmail: "dana.whitfield@premierhvacsolutions.com",
    },
  },
  {
    sourceKey: "fx-015",
    name: "Bluebonnet Landscaping",
    category: "landscaper",
    address: "230 Wildflower Dr",
    locality: "Georgetown",
    region: "TX",
    country: "US",
    // Format-invalid vanity phone: kept, labeled format_valid=false, never
    // upgraded to "verified" by anything in M0.
    phone: "512-555-BLUE",
    website: "https://www.bluebonnetlandscaping.com",
    rating: 4.7,
    reviewCount: 88,
    enrichBehavior: "no_match",
  },
];
