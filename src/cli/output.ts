import { isAppError } from "../shared/errors.js";

/**
 * Every command emits the same envelope shape the M1 MCP tools will use:
 * { ok, data, summary, warnings } — plus { error } on failure. `--json`
 * prints it verbatim; human mode prints the summary and warnings.
 */
export interface Envelope {
  ok: boolean;
  data?: unknown;
  summary: string;
  warnings: string[];
  error?: { code: string; message: string; details?: Record<string, unknown> };
}

export interface CommandResult {
  data?: unknown;
  summary: string;
  warnings?: string[];
  /** Extra human-mode lines (tables, hashes, hints). Ignored in --json mode. */
  humanLines?: string[];
}

export function emitResult(json: boolean, result: CommandResult): void {
  const envelope: Envelope = {
    ok: true,
    data: result.data,
    summary: result.summary,
    warnings: result.warnings ?? [],
  };
  if (json) {
    process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${result.summary}\n`);
  for (const line of result.humanLines ?? []) process.stdout.write(`${line}\n`);
  for (const warning of envelope.warnings) process.stdout.write(`warning: ${warning}\n`);
}

export function emitError(json: boolean, err: unknown): void {
  const code = isAppError(err) ? err.code : "INTERNAL";
  const message = err instanceof Error ? err.message : String(err);
  const details = isAppError(err) ? err.details : undefined;
  if (json) {
    const envelope: Envelope = { ok: false, summary: message, warnings: [], error: { code, message, details } };
    process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
  } else {
    process.stderr.write(`error [${code}]: ${message}\n`);
    if (details && Object.keys(details).length > 0) {
      process.stderr.write(`details: ${JSON.stringify(details)}\n`);
    }
  }
  process.exitCode = 1;
}
