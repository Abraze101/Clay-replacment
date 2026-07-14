/**
 * ADR-008 contact-discovery benchmark (BetterContact / FullEnrich / LeadMagic)
 * — DEV ONLY, never CI. Runs the SAME person list through every configured
 * vendor (submit-then-poll driven inline) and reports match rates, overlap,
 * latency, ambiguity, and cost per usable result.
 *
 * Input CSV columns: first_name,last_name,company_name,company_domain[,linkedin_url]
 * (typically exported from a real prior professional run).
 *
 * Usage:
 *   BETTERCONTACT_API_KEY=... FULLENRICH_API_KEY=... LEADMAGIC_API_KEY=... \
 *   pnpm bench:discovery -- --input ./my-people.csv --limit 25 --confirm
 *
 * Spend: worst case ≈ 11 credits/record/vendor (email 1 + phone 10) — for 25
 * records × 3 vendors roughly $30–60 depending on plans. The estimate prints
 * before --confirm is honored; use --probe for a single-record dry check.
 */
import { setTimeout as sleep } from "node:timers/promises";

import "dotenv/config";

import { parseEnv } from "../../src/config/env.js";
import type { ContactDiscoveryOutcome, ContactDiscoveryProvider } from "../../src/providers/capabilities.js";
import { discoveryCostPerRecord } from "../../src/providers/capabilities.js";
import { BetterContactDiscovery } from "../../src/providers/bettercontact/contact-discovery.js";
import { FullEnrichDiscovery } from "../../src/providers/fullenrich/contact-discovery.js";
import { LeadMagicDiscovery } from "../../src/providers/leadmagic/contact-discovery.js";
import { loadCsvRows, maskEmail, maskPhone, mdTable, parseBenchArgs, percentile, refuseCi, requireConfirm, writeReports } from "./shared.js";

const args = parseBenchArgs(process.argv.slice(2));
refuseCi("bench:discovery");
const env = parseEnv();

const vendors: ContactDiscoveryProvider[] = [];
if (env.BETTERCONTACT_API_KEY) {
  vendors.push(new BetterContactDiscovery({ apiKey: env.BETTERCONTACT_API_KEY, baseUrl: env.BETTERCONTACT_BASE_URL, maxRequestsPerMinute: env.BETTERCONTACT_MAX_RPM, pollIntervalSeconds: env.BETTERCONTACT_POLL_INTERVAL_SECONDS }));
}
if (env.FULLENRICH_API_KEY) {
  vendors.push(new FullEnrichDiscovery({ apiKey: env.FULLENRICH_API_KEY, baseUrl: env.FULLENRICH_BASE_URL, maxRequestsPerMinute: env.FULLENRICH_MAX_RPM, pollIntervalSeconds: env.FULLENRICH_POLL_INTERVAL_SECONDS }));
}
if (env.LEADMAGIC_API_KEY) {
  vendors.push(new LeadMagicDiscovery({ apiKey: env.LEADMAGIC_API_KEY, baseUrl: env.LEADMAGIC_BASE_URL, maxRequestsPerMinute: env.LEADMAGIC_MAX_RPM }));
}
if (vendors.length === 0) {
  console.error("Set BETTERCONTACT_API_KEY / FULLENRICH_API_KEY / LEADMAGIC_API_KEY to benchmark discovery.");
  process.exit(1);
}
if (!args.input) {
  console.error("Pass --input <csv> (columns: first_name,last_name,company_name,company_domain[,linkedin_url]).");
  process.exit(1);
}

const WANTED = ["work_email", "mobile_phone"] as const;
const rows = loadCsvRows(args.input, args.limit);
const worst = vendors.reduce((sum, v) => sum + discoveryCostPerRecord(v, WANTED) * rows.length, 0);
requireConfirm(args, `${rows.length} records × ${vendors.length} vendor(s), worst case ${worst} vendor credits (roughly $30–60 at 25×3; found-only billing usually lands well below).`);

interface VendorResult {
  email: string | null;
  emailClaim: string | null;
  phone: string | null;
  latencyMs: number;
  polls: number;
  cost: number;
  outcome: "found" | "no_result" | "error" | "ambiguous" | "poll_budget_exceeded";
  error?: string;
}

async function runVendor(vendor: ContactDiscoveryProvider, row: Record<string, string>, index: number): Promise<VendorResult> {
  const request = {
    requestKey: `bench-cd-${vendor.name}-${index}`,
    wanted: WANTED,
    person: {
      firstName: row["first_name"] ?? null,
      lastName: row["last_name"] ?? null,
      linkedinUrl: row["linkedin_url"] || null,
    },
    company: { name: row["company_name"] ?? null, domain: row["company_domain"] ?? null },
  };
  const started = Date.now();
  let polls = 0;
  try {
    let outcome: ContactDiscoveryOutcome = await vendor.discover(request);
    while (outcome.kind === "pending") {
      if (Date.now() - started > (vendor.maxPollSeconds ?? 600) * 1000) {
        return { email: null, emailClaim: null, phone: null, latencyMs: Date.now() - started, polls, cost: 0, outcome: "poll_budget_exceeded" };
      }
      await sleep(outcome.pollAfterSeconds * 1000);
      polls += 1;
      if (!vendor.poll) throw new Error(`${vendor.name} returned pending but has no poll()`);
      outcome = await vendor.poll(outcome.jobId, request);
    }
    if (outcome.kind === "no_result") {
      return { email: null, emailClaim: null, phone: null, latencyMs: Date.now() - started, polls, cost: outcome.cost, outcome: "no_result" };
    }
    const email = outcome.contacts.find((c) => c.type === "email");
    const phone = outcome.contacts.find((c) => c.type === "phone");
    return {
      email: email?.value ?? null,
      emailClaim: email?.vendorStatusClaim ?? null,
      phone: phone?.value ?? null,
      latencyMs: Date.now() - started,
      polls,
      cost: outcome.cost,
      outcome: "found",
    };
  } catch (err) {
    const name = err instanceof Error ? err.name : "Error";
    return {
      email: null,
      emailClaim: null,
      phone: null,
      latencyMs: Date.now() - started,
      polls,
      cost: 0,
      outcome: name === "AmbiguousOutcomeError" ? "ambiguous" : "error",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

const results: { row: Record<string, string>; byVendor: Record<string, VendorResult> }[] = [];
for (const [index, row] of rows.entries()) {
  const byVendor: Record<string, VendorResult> = {};
  for (const vendor of vendors) {
    byVendor[vendor.name] = await runVendor(vendor, row, index);
    console.log(
      `${index + 1}/${rows.length} ${row["first_name"]} @ ${row["company_domain"]} → ${vendor.name}: ${byVendor[vendor.name]!.outcome}`,
    );
  }
  results.push({ row, byVendor });
}

const vendorNames = vendors.map((v) => v.name);
const summary = vendorNames.map((name) => {
  const outcomes = results.map((r) => r.byVendor[name]!).filter(Boolean);
  const emails = outcomes.filter((o) => o.email).length;
  const phones = outcomes.filter((o) => o.phone).length;
  const found = outcomes.filter((o) => o.outcome === "found");
  const credits = outcomes.reduce((sum, o) => sum + o.cost, 0);
  return [
    name,
    `${emails}/${outcomes.length}`,
    `${phones}/${outcomes.length}`,
    outcomes.filter((o) => o.outcome === "ambiguous").length,
    outcomes.filter((o) => o.outcome === "error").length,
    `${percentile(outcomes.map((o) => o.latencyMs), 50)}/${percentile(outcomes.map((o) => o.latencyMs), 95)}`,
    credits,
    found.length > 0 ? (credits / Math.max(1, emails + phones)).toFixed(2) : "—",
  ];
});

// Cross-vendor agreement on found emails (same address from ≥2 vendors).
const emailAgreement = results.filter((r) => {
  const found = vendorNames.map((n) => r.byVendor[n]?.email?.toLowerCase()).filter((e): e is string => Boolean(e));
  return found.length >= 2 && new Set(found).size === 1;
}).length;

const markdown = [
  `# ADR-008 contact-discovery benchmark (${new Date().toISOString().slice(0, 10)})`,
  "",
  `Input: ${rows.length} person records (owner-supplied), wanted: work email + mobile. Vendors: ${vendorNames.join(", ")}.`,
  "",
  mdTable(["vendor", "email match", "phone match", "ambiguous", "errors", "latency p50/p95 ms", "credits", "credits per usable contact"], summary),
  "",
  `Cross-vendor email agreement (same address from ≥2 vendors): ${emailAgreement}/${rows.length}.`,
  "",
  "Sample (masked):",
  mdTable(
    ["person", ...vendorNames.flatMap((n) => [`${n} email`, `${n} phone`])],
    results.slice(0, 10).map((r) => [
      `${r.row["first_name"]} ${(r.row["last_name"] ?? "").slice(0, 1)}. @ ${r.row["company_domain"]}`,
      ...vendorNames.flatMap((n) => {
        const o = r.byVendor[n];
        return [o?.email ? maskEmail(o.email) : o?.outcome ?? "—", o?.phone ? maskPhone(o.phone) : "—"];
      }),
    ]),
  ),
  "",
  "Accuracy note: pipe the found emails through `pnpm bench:email` for a verified-valid rate per vendor (extra spend).",
  "",
  "**Owner decision:** _pending — record in ADR-008 (match rate, cost per usable result, reliability, submit/poll behavior)._",
  "",
].join("\n");

writeReports("contact-discovery", results, markdown);
