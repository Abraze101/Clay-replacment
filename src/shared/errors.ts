/**
 * Application errors carry a stable machine-readable code so the CLI (and the
 * M1 MCP layer) can map failures without parsing prose.
 */
export type ErrorCode =
  | "VALIDATION_FAILED"
  | "NOT_FOUND"
  | "CONFLICT"
  | "APPROVAL_REQUIRED"
  | "APPROVAL_MISMATCH"
  | "APPROVAL_EXPIRED"
  | "APPROVAL_CONSUMED"
  | "REVIEW_REQUIRED"
  | "RUN_NOT_RUNNABLE"
  | "LEASE_HELD"
  | "MIGRATION_CHECKSUM_MISMATCH"
  | "PROVIDER_ERROR"
  | "PROVIDER_AMBIGUOUS_OUTCOME"
  | "PROVIDER_RATE_LIMITED"
  | "EXPORT_FAILED"
  | "INTERNAL";

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.details = details;
  }
}

/** A provider call failed in a way that is safe to retry (no charge recorded or provider dedupes). */
export class RetryableProviderError extends AppError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super("PROVIDER_ERROR", message, details);
    this.name = "RetryableProviderError";
  }
}

/**
 * The provider rejected the request because of rate limiting (HTTP 429). By
 * definition uncharged and NOT a spent attempt: the run pauses
 * (pause_reason='rate_limited'), records resume_at, and reschedules. Carries
 * the delay to wait before retrying (from a Retry-After header when present, or
 * a provider-specific default otherwise).
 */
export class RateLimitError extends AppError {
  readonly retryAfterSeconds: number;

  constructor(message: string, retryAfterSeconds: number, details: Record<string, unknown> = {}) {
    super("PROVIDER_RATE_LIMITED", message, details);
    this.name = "RateLimitError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/**
 * An async submit-then-poll vendor accepted a job that is not finished yet
 * (M5, ADR-029). Not a failure and NOT a spent attempt: the runner persists
 * the job id, defers the step to `next_attempt_at`, keeps sweeping other
 * items, and pauses the run `awaiting_provider` until the earliest poll is
 * due. Crash replay with a persisted job id re-polls — never re-submits.
 */
export class PendingProviderJobError extends AppError {
  readonly jobId: string;
  readonly retryAfterSeconds: number;

  constructor(message: string, jobId: string, retryAfterSeconds: number, details: Record<string, unknown> = {}) {
    super("PROVIDER_ERROR", message, details);
    this.name = "PendingProviderJobError";
    this.jobId = jobId;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/**
 * The provider may have completed (and charged) the request but its outcome
 * cannot be confirmed. Never auto-retried; the step lands in `needs_review`.
 */
export class AmbiguousOutcomeError extends AppError {
  /** Cost that may have been charged; provisionally booked until reconciled. */
  readonly possibleCost: number;

  constructor(message: string, possibleCost: number, details: Record<string, unknown> = {}) {
    super("PROVIDER_AMBIGUOUS_OUTCOME", message, details);
    this.name = "AmbiguousOutcomeError";
    this.possibleCost = possibleCost;
  }
}

export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}
