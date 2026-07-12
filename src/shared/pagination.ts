import { AppError } from "./errors.js";

/**
 * Opaque offset cursors shared by the MCP `run_results` tool and the web API's
 * results route so both interfaces page identically. The encoding is part of
 * the M1 MCP contract — do not change the wire format.
 */
export function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ offset }), "utf8").toString("base64url");
}

export function decodeCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { offset?: unknown };
    if (typeof parsed.offset === "number" && Number.isInteger(parsed.offset) && parsed.offset >= 0) {
      return parsed.offset;
    }
  } catch {
    // fall through to the validation error
  }
  throw new AppError("VALIDATION_FAILED", "Invalid cursor; pass the nextCursor from the previous run_results page.", {});
}
