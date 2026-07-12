/**
 * SerpAPI Google Maps probe — DEV ONLY, never CI.
 *
 * Verifies the adapter's Zod schema and field mapping against LIVE SerpAPI
 * responses and writes SANITIZED fixture drafts for human review. Spends one
 * SerpAPI search per location (bill-only-successful; free tier = 250/month).
 *
 * Guardrails (CLAUDE.md: no credit-consuming call without explicit approval):
 *   - refuses to run without SERPAPI_API_KEY;
 *   - prints the exact search count and refuses without --yes;
 *   - at most 3 locations per invocation.
 *
 * Usage:
 *   SERPAPI_API_KEY=... pnpm probe:serpapi -- --business "roofing contractor" \
 *     --locations "Austin, TX" --yes
 *
 * Drafts land in test/fixtures/serpapi/drafts/ (names/phones/urls scrubbed);
 * review before committing as fixtures.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { SerpApiClient, serpApiLocalResultSchema } from "../src/providers/serpapi/client.js";
import { extractSourceKey, parseUsAddress } from "../src/providers/serpapi/identity.js";

interface Args {
  business: string;
  locations: string[];
  yes: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { business: "roofing contractor", locations: [], yes: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--business" && argv[i + 1]) args.business = argv[++i] as string;
    else if (a === "--locations" && argv[i + 1]) args.locations.push(argv[++i] as string);
    else if (a === "--yes") args.yes = true;
  }
  if (args.locations.length === 0) args.locations = ["Austin, TX"];
  return args;
}

function sanitize(value: unknown, seed: { n: number }): unknown {
  if (Array.isArray(value)) return value.map((v) => sanitize(v, seed));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = sanitizeField(k, v, seed);
    return out;
  }
  return value;
}

function sanitizeField(key: string, value: unknown, seed: { n: number }): unknown {
  // Real-business GPS coordinates identify the business as surely as its name.
  if (key === "gps_coordinates") {
    seed.n += 1;
    return { latitude: 30.0 + seed.n / 1000, longitude: -97.0 - seed.n / 1000 };
  }
  if (typeof value !== "string") return sanitize(value, seed);
  seed.n += 1;
  switch (key) {
    case "title":
      return `Sanitized Business ${seed.n}`;
    case "phone":
      return `+1 512-555-0${String(100 + (seed.n % 100)).slice(0, 3)}`;
    case "address":
      return `${100 + seed.n} Sample St, Austin, TX 78701, United States`;
    case "website":
      return `https://sanitized-${seed.n}.example`;
    case "place_id":
      return `ChIJsanitized${seed.n}`;
    case "data_cid":
      return String(1_000_000_000_000_000_000 + seed.n);
    case "data_id":
      return `0x0:0x${seed.n.toString(16)}`;
    default:
      // Unknown fields: scrub URLs and any identifier-shaped value (5+ digit
      // runs cover CIDs, phones, plus codes) — drafts must never carry real
      // business identifiers even in fields this probe does not model.
      if (/https?:\/\//.test(value)) return `https://sanitized-${seed.n}.example`;
      if (/\d{5,}/.test(value)) return `sanitized-${seed.n}`;
      return value;
  }
}

async function main(): Promise<void> {
  const apiKey = process.env["SERPAPI_API_KEY"];
  const args = parseArgs(process.argv.slice(2));

  if (!apiKey) {
    process.stderr.write("SERPAPI_API_KEY is not set. This probe spends live searches and refuses to run without it.\n");
    process.exitCode = 1;
    return;
  }
  if (args.locations.length > 3) {
    process.stderr.write("At most 3 locations per probe (one paid search each).\n");
    process.exitCode = 1;
    return;
  }
  if (!args.yes) {
    process.stderr.write(
      `This will spend ${args.locations.length} SerpAPI search(es) (~free-tier allowance 250/month) for ` +
        `"${args.business}" in: ${args.locations.join("; ")}.\nRe-run with --yes to approve the spend.\n`,
    );
    process.exitCode = 1;
    return;
  }

  const client = new SerpApiClient({ apiKey, maxRequestsPerMinute: 10 });
  const usage = await client.creditUsage();
  process.stdout.write(`Connected. Searches left this month: ${usage.totalSearchesLeft ?? "unknown"}.\n`);

  const draftsDir = path.resolve("test/fixtures/serpapi/drafts");
  mkdirSync(draftsDir, { recursive: true });

  for (const location of args.locations) {
    const q = `${args.business} ${location}`;
    process.stdout.write(`\n=== Searching: "${q}" ===\n`);
    const response = await client.searchMaps({ q });
    const listings = response.local_results ?? [];
    process.stdout.write(`local_results: ${listings.length}\n`);

    let mapped = 0;
    for (const raw of listings) {
      // Same per-item tolerance as the adapter: one odd listing must not
      // invalidate the probe.
      const item = serpApiLocalResultSchema.safeParse(raw);
      if (!item.success) {
        process.stdout.write(`  MISS <listing failed schema: ${item.error.issues[0]?.message ?? "?"}>\n`);
        continue;
      }
      const listing = item.data;
      const key = extractSourceKey(listing);
      const parsed = parseUsAddress(listing.address);
      mapped += 1;
      process.stdout.write(
        `  OK  ${key.slice(0, 28).padEnd(28)} phone=${listing.phone ? "y" : "n"} website=${listing.website ? "y" : "n"} rating=${listing.rating ?? "-"} reviews=${listing.reviews ?? "-"} region=${parsed.region ?? "-"}\n`,
      );
    }
    process.stdout.write(`Mapped ${mapped}/${listings.length} listings.\n`);

    const seed = { n: 0 };
    const draftPath = path.join(draftsDir, `maps-${location.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.draft.json`);
    writeFileSync(draftPath, `${JSON.stringify(sanitize(response, seed), null, 2)}\n`, "utf8");
    process.stdout.write(`Sanitized draft written: ${draftPath} (review before committing).\n`);
  }
}

main().catch((err: unknown) => {
  console.error("Probe failed:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
