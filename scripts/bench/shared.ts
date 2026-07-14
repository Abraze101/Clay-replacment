/**
 * Shared harness for the M5 vendor benchmarks (ADR-008/009/010) — DEV ONLY,
 * never CI. The benchmarks run on the OWNER's keys with explicit spend
 * confirmation; final vendor selection is the owner's decision, recorded in
 * the ADRs afterwards.
 *
 * Every benchmark:
 *   - refuses to run in CI and without --confirm after printing the
 *     worst-case spend estimate;
 *   - reads its input CSV (owner-supplied, typically exported from a real
 *     prior run) and caps it with --limit;
 *   - writes an UNSANITIZED working JSON to ./.data/bench/ (gitignored) and a
 *     SANITIZED markdown report (emails/phones masked) to
 *     ./exports/benchmarks/, ready to paste into the ADR.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { parse } from "csv-parse/sync";

export interface BenchArgs {
  input?: string;
  limit: number;
  confirm: boolean;
  probe: boolean;
}

export function parseBenchArgs(argv: string[]): BenchArgs {
  const args: BenchArgs = { limit: 50, confirm: false, probe: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--input" && argv[i + 1]) args.input = argv[++i];
    else if (a === "--limit" && argv[i + 1]) args.limit = Math.max(1, Number(argv[++i]));
    else if (a === "--confirm") args.confirm = true;
    else if (a === "--probe") {
      args.probe = true;
      args.limit = 1;
    }
  }
  return args;
}

export function refuseCi(name: string): void {
  if (process.env["CI"]) {
    console.error(`${name}: benchmarks never run in CI (live keys, real spend).`);
    process.exit(1);
  }
}

export function loadCsvRows(file: string, limit: number): Record<string, string>[] {
  const text = readFileSync(file, "utf8");
  const rows = parse(text, { columns: true, bom: true, trim: true, skip_empty_lines: true }) as unknown as Record<
    string,
    string
  >[];
  return rows.slice(0, limit);
}

export function requireConfirm(args: BenchArgs, spendSummary: string): void {
  console.log(`\nWORST-CASE SPEND ESTIMATE:\n${spendSummary}\n`);
  if (!args.confirm) {
    console.error("Refusing to spend without --confirm (per-run approval is mandatory; use --probe for a 1-record dry check).");
    process.exit(1);
  }
}

export function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!local || !domain) return "***";
  return `${local[0] ?? "*"}***@${domain}`;
}

export function maskPhone(phone: string): string {
  const digits = phone.replace(/[^0-9+]/g, "");
  return digits.length <= 4 ? "***" : `${digits.slice(0, 2)}***${digits.slice(-2)}`;
}

export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)] ?? null;
}

export function writeReports(name: string, rawData: unknown, markdown: string): void {
  const stamp = new Date().toISOString().slice(0, 10);
  const rawDir = path.resolve("./.data/bench");
  const reportDir = path.resolve("./exports/benchmarks");
  mkdirSync(rawDir, { recursive: true });
  mkdirSync(reportDir, { recursive: true });
  const rawPath = path.join(rawDir, `${name}-${stamp}.json`);
  const reportPath = path.join(reportDir, `${name}-${stamp}.md`);
  writeFileSync(rawPath, JSON.stringify(rawData, null, 2), "utf8");
  writeFileSync(reportPath, markdown, "utf8");
  console.log(`\nRaw (UNSANITIZED, gitignored): ${rawPath}`);
  console.log(`Sanitized ADR-ready report:    ${reportPath}`);
}

export function mdTable(headers: string[], rows: (string | number | null)[][]): string {
  const line = (cells: (string | number | null)[]): string => `| ${cells.map((c) => c ?? "—").join(" | ")} |`;
  return [line(headers), `|${headers.map(() => "---").join("|")}|`, ...rows.map(line)].join("\n");
}
