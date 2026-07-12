import type { IncomingMessage, ServerResponse } from "node:http";

import type { ZodType } from "zod";

import type { ErrorCode } from "../shared/errors.js";
import { AppError, isAppError } from "../shared/errors.js";

/** Transport-level failures (oversized body, malformed JSON) that are not AppErrors. */
export class HttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
  }
}

const MAX_BODY_BYTES = 1024 * 1024;

export async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "PAYLOAD_TOO_LARGE", "Request body exceeds 1 MB.");
    chunks.push(buf);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new AppError("VALIDATION_FAILED", "Request body is not valid JSON.", {});
  }
}

/** Parse with a contracts schema, converting Zod issues to a VALIDATION_FAILED envelope. */
export function parseBody<T>(schema: ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new AppError("VALIDATION_FAILED", "Request payload is invalid.", {
      issues: result.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }
  return result.data;
}

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  VALIDATION_FAILED: 400,
  NOT_FOUND: 404,
  CONFLICT: 409,
  APPROVAL_REQUIRED: 409,
  APPROVAL_MISMATCH: 409,
  APPROVAL_EXPIRED: 409,
  APPROVAL_CONSUMED: 409,
  REVIEW_REQUIRED: 409,
  RUN_NOT_RUNNABLE: 409,
  LEASE_HELD: 409,
  PROVIDER_ERROR: 502,
  PROVIDER_AMBIGUOUS_OUTCOME: 502,
  EXPORT_FAILED: 500,
  MIGRATION_CHECKSUM_MISMATCH: 500,
  INTERNAL: 500,
};

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(payload);
}

/**
 * Map any thrown value to the failure envelope. AppErrors keep their code and
 * message (they are written for operators); anything else becomes a generic
 * INTERNAL error — stack traces and internal messages never cross the wire.
 */
export function sendError(res: ServerResponse, err: unknown, requestId: string): void {
  if (err instanceof HttpError) {
    sendJson(res, err.status, {
      ok: false,
      error: { code: err.code, message: err.message },
      requestId,
    });
    return;
  }
  if (isAppError(err)) {
    sendJson(res, STATUS_BY_CODE[err.code], {
      ok: false,
      error: {
        code: err.code,
        message: err.message,
        ...(Object.keys(err.details).length > 0 ? { details: err.details } : {}),
      },
      requestId,
    });
    return;
  }
  sendJson(res, 500, {
    ok: false,
    error: { code: "INTERNAL", message: "Internal server error." },
    requestId,
  });
}
