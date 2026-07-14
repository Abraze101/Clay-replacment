/**
 * ADR-010 email-verification benchmark (ZeroBounce vs MillionVerifier) —
 * DEV ONLY, never CI. Runs the SAME list through every configured verifier
 * and reports the agreement matrix, accuracy on the owner-known subset,
 * unknown rate (drives real cost — both vendors refund unknowns), and cost.
 *
 * Input CSV columns: email[,expected]  (expected ∈ valid|invalid|catch_all|role_based)
 * Mix owner-known-good addresses, fabricated ones at real domains, role
 * addresses (info@), a known catch-all domain, and discovered emails from the
 * discovery benchmark.
 *
 * Usage:
 *   ZEROBOUNCE_API_KEY=... MILLIONVERIFIER_API_KEY=... \
 *   pnpm bench:email -- --input ./my-emails.csv --limit 50 --confirm
 *
 * Spend: 1 credit per verification per vendor (~$0.008–0.01) → $1–2 for 50
 * emails across both vendors.
 */
import "dotenv/config";

import { parseEnv } from "../../src/config/env.js";
import type { EmailVerificationProvider } from "../../src/providers/capabilities.js";
import { MillionVerifierEmailVerification } from "../../src/providers/millionverifier/email-verification.js";
import { ZeroBounceEmailVerification } from "../../src/providers/zerobounce/email-verification.js";
import { loadCsvRows, maskEmail, mdTable, parseBenchArgs, percentile, refuseCi, requireConfirm, writeReports } from "./shared.js";

const args = parseBenchArgs(process.argv.slice(2));
refuseCi("bench:email");
const env = parseEnv();

const verifiers: EmailVerificationProvider[] = [];
if (env.ZEROBOUNCE_API_KEY) {
  verifiers.push(
    new ZeroBounceEmailVerification({
      apiKey: env.ZEROBOUNCE_API_KEY,
      baseUrl: env.ZEROBOUNCE_BASE_URL,
      maxRequestsPerMinute: env.ZEROBOUNCE_MAX_RPM,
    }),
  );
}
if (env.MILLIONVERIFIER_API_KEY) {
  verifiers.push(
    new MillionVerifierEmailVerification({
      apiKey: env.MILLIONVERIFIER_API_KEY,
      baseUrl: env.MILLIONVERIFIER_BASE_URL,
      maxRequestsPerMinute: env.MILLIONVERIFIER_MAX_RPM,
      vendorTimeoutSeconds: env.MILLIONVERIFIER_VENDOR_TIMEOUT_SECONDS,
    }),
  );
}
if (verifiers.length === 0) {
  console.error("Set ZEROBOUNCE_API_KEY and/or MILLIONVERIFIER_API_KEY to benchmark email verification.");
  process.exit(1);
}
if (!args.input) {
  console.error("Pass --input <csv> (columns: email[,expected]).");
  process.exit(1);
}

const rows = loadCsvRows(args.input, args.limit);
requireConfirm(
  args,
  `${rows.length} emails × ${verifiers.length} vendor(s) = ${rows.length * verifiers.length} verifications ≈ $${(rows.length * verifiers.length * 0.01).toFixed(2)}.`,
);

interface Verdict {
  email: string;
  expected: string | null;
  byVendor: Record<string, { status: string; subStatus: string | null; latencyMs: number; cost: number } | { error: string }>;
}

const verdicts: Verdict[] = [];
for (const [index, row] of rows.entries()) {
  const email = row["email"] ?? "";
  const verdict: Verdict = { email, expected: row["expected"] || null, byVendor: {} };
  for (const verifier of verifiers) {
    const started = Date.now();
    try {
      const result = await verifier.verify({ requestKey: `bench-email-${index}`, email });
      verdict.byVendor[verifier.name] = {
        status: result.status,
        subStatus: result.subStatus ?? null,
        latencyMs: Date.now() - started,
        cost: result.cost,
      };
    } catch (err) {
      verdict.byVendor[verifier.name] = { error: err instanceof Error ? err.message : String(err) };
    }
  }
  verdicts.push(verdict);
  console.log(
    `${index + 1}/${rows.length} ${maskEmail(email)} → ${Object.entries(verdict.byVendor)
      .map(([vendor, v]) => `${vendor}:${"status" in v ? v.status : "ERROR"}`)
      .join(" ")}`,
  );
}

const vendorNames = verifiers.map((v) => v.name);
const summaryRows = vendorNames.map((vendor) => {
  const outcomes = verdicts.map((v) => v.byVendor[vendor]).filter((v): v is Exclude<typeof v, undefined> => v !== undefined);
  const ok = outcomes.filter((o): o is Extract<typeof o, { status: string }> => "status" in o);
  const withExpected = verdicts.filter((v) => v.expected && v.byVendor[vendor] && "status" in v.byVendor[vendor]);
  const correct = withExpected.filter((v) => (v.byVendor[vendor] as { status: string }).status === v.expected);
  return [
    vendor,
    `${ok.length}/${outcomes.length}`,
    ok.filter((o) => o.status === "unknown").length,
    withExpected.length ? `${correct.length}/${withExpected.length}` : "no ground truth",
    `${percentile(ok.map((o) => o.latencyMs), 50)}/${percentile(ok.map((o) => o.latencyMs), 95)}`,
    ok.reduce((sum, o) => sum + o.cost, 0),
  ];
});

const both = vendorNames.length === 2 ? verdicts.filter((v) => vendorNames.every((n) => v.byVendor[n] && "status" in v.byVendor[n])) : [];
const agree = both.filter(
  (v) => (v.byVendor[vendorNames[0]!] as { status: string }).status === (v.byVendor[vendorNames[1]!] as { status: string }).status,
);

const markdown = [
  `# ADR-010 email-verification benchmark (${new Date().toISOString().slice(0, 10)})`,
  "",
  `Input: ${rows.length} emails (owner-supplied), vendors: ${vendorNames.join(", ")}.`,
  "",
  mdTable(["vendor", "answered", "unknowns (refunded)", "accuracy (ground truth)", "latency p50/p95 ms", "credits charged"], summaryRows),
  "",
  vendorNames.length === 2 ? `Vendor agreement: ${agree.length}/${both.length} identical statuses.` : "",
  "",
  "Sample (masked):",
  mdTable(
    ["email", "expected", ...vendorNames],
    verdicts.slice(0, 15).map((v) => [
      maskEmail(v.email),
      v.expected,
      ...vendorNames.map((n) => {
        const o = v.byVendor[n];
        return o && "status" in o ? o.status : "ERROR";
      }),
    ]),
  ),
  "",
  "**Owner decision:** _pending — record in ADR-010 (status fidelity vs the engine vocabulary, unknown rate, cost per definitive answer)._",
  "",
].join("\n");

writeReports("email-verification", verdicts, markdown);
