import type { ApiEnvelope } from "./types.js";

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(code: string, message: string, status: number, details?: Record<string, unknown>) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export interface ApiResult<T> {
  data: T;
  warnings: string[];
}

async function request<T>(path: string, init?: RequestInit): Promise<ApiResult<T>> {
  let response: Response;
  try {
    response = await fetch(path, init);
  } catch {
    throw new ApiError("NETWORK", "Could not reach the lead engine server.", 0);
  }
  let envelope: ApiEnvelope<T>;
  try {
    envelope = (await response.json()) as ApiEnvelope<T>;
  } catch {
    throw new ApiError("BAD_RESPONSE", `Unexpected non-JSON response (HTTP ${response.status}).`, response.status);
  }
  if (!envelope.ok) {
    throw new ApiError(envelope.error.code, envelope.error.message, response.status, envelope.error.details);
  }
  return { data: envelope.data, warnings: envelope.warnings };
}

export async function apiGet<T>(path: string): Promise<ApiResult<T>> {
  return await request<T>(path);
}

export async function apiPost<T>(path: string, body: unknown = {}): Promise<ApiResult<T>> {
  return await request<T>(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return `${err.message} (${err.code})`;
  return err instanceof Error ? err.message : String(err);
}
