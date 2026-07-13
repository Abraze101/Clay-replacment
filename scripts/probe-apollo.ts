/**
 * Apollo REST probe — DEV ONLY, never CI.
 *
 * Verifies the adapter's Zod schemas and field mapping against LIVE Apollo
 * responses and writes SANITIZED fixture drafts for human review. The default
 * action is ONE people-search page — credit-FREE (but rate-limited; a free
 * key works, with partially obfuscated last names). Enrichment is a separate,
 * doubly-gated action because it consumes ~1 Apollo credit.
 *
 * Guardrails (CLAUDE.md: no credit-consuming call without explicit approval):
 *   - refuses to run without APOLLO_API_KEY (a MASTER key; a regular key
 *     403s on people search);
 *   - the free search still requires --yes (rate-limit + data-handling
 *     symmetry with the SerpAPI probe);
 *   - enrichment runs ONLY with --enrich-one AND --yes-spend, matches exactly
 *     ONE person from the search results, and prints the cost first.
 *
 * Usage:
 *   APOLLO_API_KEY=... pnpm probe:apollo -- --titles "CEO" --locations "Austin, TX" --yes
 *   APOLLO_API_KEY=... pnpm probe:apollo -- --titles "CEO" --locations "Austin, TX" --yes --enrich-one --yes-spend
 *
 * Drafts land in test/fixtures/apollo/drafts/ (names/emails/ids/urls
 * scrubbed); review before committing as fixtures.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import "dotenv/config";

import { ApolloClient, apolloPersonSchema } from "../src/providers/apollo/client.js";

interface Args {
  titles: string[];
  locations: string[];
  keywords?: string;
  yes: boolean;
  enrichOne: boolean;
  yesSpend: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { titles: [], locations: [], yes: false, enrichOne: false, yesSpend: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--titles" && argv[i + 1]) args.titles.push(argv[++i] as string);
    else if (a === "--locations" && argv[i + 1]) args.locations.push(argv[++i] as string);
    else if (a === "--keywords" && argv[i + 1]) args.keywords = argv[++i];
    else if (a === "--yes") args.yes = true;
    else if (a === "--enrich-one") args.enrichOne = true;
    else if (a === "--yes-spend") args.yesSpend = true;
  }
  if (args.titles.length === 0) args.titles = ["CEO"];
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
  if (typeof value !== "string") return sanitize(value, seed);
  seed.n += 1;
  switch (key) {
    case "id":
    case "organization_id":
      return `sanitized-id-${seed.n}`;
    case "first_name":
      return `First${seed.n}`;
    case "last_name":
      return `Last${seed.n}`;
    case "name":
      return `First${seed.n} Last${seed.n}`;
    case "email":
      return `person${seed.n}@sanitized-${seed.n}.example`;
    case "linkedin_url":
      return `https://www.linkedin.com/in/sanitized-person-${seed.n}`;
    case "title":
      return value; // titles alone are not identifying and matter for mapping review
    case "website_url":
    case "primary_domain":
      return key === "primary_domain" ? `sanitized-${seed.n}.example` : `https://sanitized-${seed.n}.example`;
    default:
      // Unknown fields: scrub URLs, emails, phone-shaped digit runs, and any
      // identifier-shaped value — drafts must never carry a real person.
      if (/https?:\/\//.test(value)) return `https://sanitized-${seed.n}.example`;
      if (/@/.test(value)) return `person${seed.n}@sanitized-${seed.n}.example`;
      if (/\d{5,}/.test(value)) return `sanitized-${seed.n}`;
      return value;
  }
}

async function main(): Promise<void> {
  const apiKey = process.env["APOLLO_API_KEY"];
  const args = parseArgs(process.argv.slice(2));

  if (!apiKey) {
    process.stderr.write(
      "APOLLO_API_KEY is not set. This probe calls live Apollo (search is free; enrichment costs credits) and refuses to run without it.\n",
    );
    process.exitCode = 1;
    return;
  }
  if (!args.yes) {
    process.stderr.write(
      `This will run 1 Apollo people-search page (credit-FREE, rate-limited) for titles [${args.titles.join(", ")}] in ` +
        `[${args.locations.join("; ")}].\nRe-run with --yes to approve.` +
        `${args.enrichOne ? " Enrichment additionally needs --yes-spend (~1 credit)." : ""}\n`,
    );
    process.exitCode = 1;
    return;
  }
  if (args.enrichOne && !args.yesSpend) {
    process.stderr.write("--enrich-one consumes ~1 Apollo credit; re-run with BOTH --enrich-one and --yes-spend.\n");
    process.exitCode = 1;
    return;
  }

  const client = new ApolloClient({ apiKey, maxRequestsPerMinute: 30 });
  const health = await client.healthCheck();
  process.stdout.write(`Connected (zero-cost key check): ${health.ok ? "OK" : "NOT LOGGED IN — is this a master key?"}\n`);

  const draftsDir = path.resolve("test/fixtures/apollo/drafts");
  mkdirSync(draftsDir, { recursive: true });

  process.stdout.write(`\n=== People search (page 1, free): titles=[${args.titles.join(", ")}] ===\n`);
  const search = await client.searchPeople({
    personTitles: args.titles,
    personLocations: args.locations,
    qKeywords: args.keywords,
    page: 1,
    perPage: 25,
  });
  const hits = [...(search.people ?? []), ...(search.contacts ?? [])];
  process.stdout.write(`people+contacts: ${hits.length} (of ~${search.pagination?.total_entries ?? "?"} total)\n`);

  let firstPersonId: string | null = null;
  let mapped = 0;
  for (const raw of hits) {
    const item = apolloPersonSchema.safeParse(raw);
    if (!item.success) {
      process.stdout.write(`  MISS <hit failed schema: ${item.error.issues[0]?.message ?? "?"}>\n`);
      continue;
    }
    const person = item.data;
    firstPersonId ??= person.id;
    mapped += 1;
    process.stdout.write(
      `  OK  title=${(person.title ?? "-").slice(0, 30).padEnd(30)} linkedin=${person.linkedin_url ? "y" : "n"} org=${person.organization?.name ? "y" : "n"} domain=${person.organization?.primary_domain ? "y" : "n"} email=${person.email ? "PRESENT(!)" : "none (expected)"}\n`,
    );
  }
  process.stdout.write(`Mapped ${mapped}/${hits.length} hits. Search returns no emails/phones by design.\n`);

  const seed = { n: 0 };
  const searchDraft = path.join(draftsDir, "people-search.draft.json");
  writeFileSync(searchDraft, `${JSON.stringify(sanitize(search, seed), null, 2)}\n`, "utf8");
  process.stdout.write(`Sanitized draft written: ${searchDraft} (review before committing).\n`);

  if (args.enrichOne && args.yesSpend) {
    if (!firstPersonId) {
      process.stderr.write("No person id available from the search to enrich.\n");
      process.exitCode = 1;
      return;
    }
    process.stdout.write(`\n=== Enriching ONE person (~1 credit) ===\n`);
    const match = await client.matchPerson({ apolloPersonId: firstPersonId });
    const person = match.person ? apolloPersonSchema.safeParse(match.person) : null;
    if (person?.success) {
      const email = person.data.email ?? null;
      process.stdout.write(
        `Match: email=${email ? (/^email_not_unlocked@/i.test(email) ? "LOCKED placeholder" : "revealed") : "none"} ` +
          `claimed_status=${person.data.email_status ?? "-"} linkedin=${person.data.linkedin_url ? "y" : "n"}\n`,
      );
    } else {
      process.stdout.write("No match (a 200 without data consumes no credit).\n");
    }
    const matchDraft = path.join(draftsDir, "people-match.draft.json");
    writeFileSync(matchDraft, `${JSON.stringify(sanitize(match, { n: 1000 }), null, 2)}\n`, "utf8");
    process.stdout.write(`Sanitized draft written: ${matchDraft} (review before committing).\n`);
  }
}

main().catch((err: unknown) => {
  console.error("Probe failed:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
