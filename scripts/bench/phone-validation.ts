/**
 * ADR-009 phone-validation benchmark (Twilio Lookup) — DEV ONLY, never CI.
 *
 * Input CSV columns: phone[,expected_line_type][,expected_status][,business_name]
 * Mix numbers from a real prior run export with a small owner-known ground
 * truth set (own mobile, office landline, a VoIP number, a disconnected one).
 *
 * Usage:
 *   TWILIO_ACCOUNT_SID=... TWILIO_AUTH_TOKEN=... \
 *   pnpm bench:phone -- --input ./my-phones.csv --limit 50 --confirm
 *
 * Spend: ~2 signal packages per lookup (line type + line status) at roughly
 * $0.01 combined → under $2 for 50 numbers. Interface neutrality is proven by
 * the shared capability contract tests (fake + Twilio); this benchmark
 * measures ACCURACY and reliability for the ADR-009 decision.
 */
import "dotenv/config";

import { parseEnv } from "../../src/config/env.js";
import { TwilioPhoneValidation } from "../../src/providers/twilio/phone-validation.js";
import { loadCsvRows, maskPhone, mdTable, parseBenchArgs, percentile, refuseCi, requireConfirm, writeReports } from "./shared.js";

const args = parseBenchArgs(process.argv.slice(2));
refuseCi("bench:phone");
const env = parseEnv();
if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN) {
  console.error("Set TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN to benchmark Twilio Lookup.");
  process.exit(1);
}
if (!args.input) {
  console.error("Pass --input <csv> (columns: phone[,expected_line_type][,expected_status][,business_name]).");
  process.exit(1);
}

const rows = loadCsvRows(args.input, args.limit);
requireConfirm(args, `${rows.length} lookups × 2 signal packages ≈ $${(rows.length * 0.01).toFixed(2)} on the Twilio account.`);

const provider = new TwilioPhoneValidation({
  accountSid: env.TWILIO_ACCOUNT_SID,
  authToken: env.TWILIO_AUTH_TOKEN,
  baseUrl: env.TWILIO_LOOKUP_BASE_URL,
  maxRequestsPerMinute: env.TWILIO_MAX_RPM,
  defaultRetryAfterSeconds: env.TWILIO_DEFAULT_RETRY_AFTER_SECONDS,
  identityMatchEnabled: env.TWILIO_IDENTITY_MATCH_ENABLED,
});

interface Row {
  phone: string;
  lineType: string | null;
  lineStatus: string | null;
  identity: string | null;
  latencyMs: number;
  outcome: "ok" | "invalid_number" | "error" | "ambiguous";
  expectedLineType: string | null;
  expectedStatus: string | null;
  error?: string;
}

const results: Row[] = [];
for (const [index, row] of rows.entries()) {
  const phone = row["phone"] ?? "";
  const started = Date.now();
  try {
    const result = await provider.validate({
      requestKey: `bench-phone-${index}`,
      phoneE164: phone,
      signals: ["line_type", "line_status", ...(row["business_name"] ? (["identity_match"] as const) : [])],
      ...(row["business_name"] ? { identityHint: { kind: "business" as const, name: row["business_name"] } } : {}),
    });
    results.push({
      phone,
      lineType: result.lineType?.value ?? null,
      lineStatus: result.lineStatus?.value ?? null,
      identity: result.identityMatch?.value ?? null,
      latencyMs: Date.now() - started,
      outcome: result.formatValid ? "ok" : "invalid_number",
      expectedLineType: row["expected_line_type"] || null,
      expectedStatus: row["expected_status"] || null,
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : "Error";
    results.push({
      phone,
      lineType: null,
      lineStatus: null,
      identity: null,
      latencyMs: Date.now() - started,
      outcome: name === "AmbiguousOutcomeError" ? "ambiguous" : "error",
      expectedLineType: row["expected_line_type"] || null,
      expectedStatus: row["expected_status"] || null,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  console.log(`${index + 1}/${rows.length} ${maskPhone(phone)} → ${results[results.length - 1]!.outcome}`);
}

const ok = results.filter((r) => r.outcome === "ok");
const withExpectedType = results.filter((r) => r.expectedLineType && r.lineType);
const typeCorrect = withExpectedType.filter((r) => r.lineType === r.expectedLineType);
const latencies = results.map((r) => r.latencyMs);
const markdown = [
  `# ADR-009 phone-validation benchmark — twilio-lookup (${new Date().toISOString().slice(0, 10)})`,
  "",
  `Input: ${rows.length} numbers (owner-supplied). Outcomes: ${ok.length} ok, ${results.filter((r) => r.outcome === "invalid_number").length} invalid-number, ${results.filter((r) => r.outcome === "ambiguous").length} ambiguous, ${results.filter((r) => r.outcome === "error").length} errors.`,
  "",
  mdTable(
    ["metric", "value"],
    [
      ["line_type coverage", `${results.filter((r) => r.lineType && r.lineType !== "unknown").length}/${results.length}`],
      ["line_type accuracy (ground truth)", withExpectedType.length ? `${typeCorrect.length}/${withExpectedType.length}` : "no ground truth"],
      ["line_status active", results.filter((r) => r.lineStatus === "active").length],
      ["line_status unknown", results.filter((r) => r.lineStatus === "unknown").length],
      ["business identity match", results.filter((r) => r.identity === "business_match").length],
      ["latency p50/p95 (ms)", `${percentile(latencies, 50)}/${percentile(latencies, 95)}`],
      ["est. cost", `$${(ok.length * 0.01).toFixed(2)}`],
    ],
  ),
  "",
  "Sample (masked):",
  mdTable(
    ["phone", "line_type", "line_status", "identity", "outcome"],
    results.slice(0, 15).map((r) => [maskPhone(r.phone), r.lineType, r.lineStatus, r.identity, r.outcome]),
  ),
  "",
  "**Owner decision:** _pending — record in ADR-009 (accuracy, ambiguity rate, cost per usable signal)._",
  "",
].join("\n");

writeReports("phone-validation", results, markdown);
