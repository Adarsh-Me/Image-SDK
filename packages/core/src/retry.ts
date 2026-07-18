export type RetryBackoff = "exponential";

export interface RetryPolicy {
  retries?: number;
  backoff?: RetryBackoff;
  initialDelayMs?: number;
  maxDelayMs?: number;
}

export interface NormalizedRetryPolicy {
  retries: number;
  backoff: RetryBackoff;
  initialDelayMs: number;
  maxDelayMs: number;
}

export type FailureDisposition = "retry" | "fallback" | "fail";

export interface FailureClassification {
  disposition: FailureDisposition;
  reason:
    | "cancelled"
    | "moderated"
    | "invalid-request"
    | "configuration"
    | "authentication"
    | "transient-status"
    | "transient-network"
    | "provider-terminal"
    | "unknown";
}

export const DEFAULT_RETRY_POLICY: NormalizedRetryPolicy = {
  retries: 0,
  backoff: "exponential",
  initialDelayMs: 250,
  maxDelayMs: 4_000
};

const TRANSIENT_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
const AUTHENTICATION_STATUSES = new Set([401, 403]);
const TRANSIENT_NETWORK_CODES = new Set([
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EAI_AGAIN",
  "ENETUNREACH",
  "ENOTFOUND",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT"
]);

/**
 * Normalizes the eventual public retry configuration without coupling it to the
 * image-client contract while Phase 3 is in flight.
 */
export function normalizeRetryPolicy(policy: RetryPolicy = {}): NormalizedRetryPolicy {
  const retries = policy.retries ?? DEFAULT_RETRY_POLICY.retries;
  const backoff = policy.backoff ?? DEFAULT_RETRY_POLICY.backoff;
  const initialDelayMs = policy.initialDelayMs ?? DEFAULT_RETRY_POLICY.initialDelayMs;
  const maxDelayMs = policy.maxDelayMs ?? DEFAULT_RETRY_POLICY.maxDelayMs;

  if (!Number.isInteger(retries) || retries < 0) {
    throw new RangeError("retry.retries must be a non-negative integer.");
  }

  if (backoff !== "exponential") {
    throw new RangeError("retry.backoff must be \"exponential\".");
  }

  if (!Number.isFinite(initialDelayMs) || initialDelayMs < 0) {
    throw new RangeError("retry.initialDelayMs must be a non-negative finite number.");
  }

  if (!Number.isFinite(maxDelayMs) || maxDelayMs < initialDelayMs) {
    throw new RangeError("retry.maxDelayMs must be a finite number greater than or equal to retry.initialDelayMs.");
  }

  return { retries, backoff, initialDelayMs, maxDelayMs };
}

/**
 * Returns the delay before retry number `retryOrdinal`, where the first retry is 1.
 * Delays deliberately contain no jitter so retry behavior is reproducible in tests.
 */
export function getRetryDelayMs(retryOrdinal: number, policy: RetryPolicy = {}): number {
  if (!Number.isInteger(retryOrdinal) || retryOrdinal < 1) {
    throw new RangeError("retryOrdinal must be a positive integer.");
  }

  const normalized = normalizeRetryPolicy(policy);
  return Math.min(normalized.initialDelayMs * 2 ** (retryOrdinal - 1), normalized.maxDelayMs);
}

/**
 * Classifies failures without importing the mutable public error hierarchy. The
 * structural checks allow Phase 3's moderation/capability errors to participate
 * as soon as they expose a stable `code` or HTTP `status`.
 */
export function classifyGenerationFailure(error: unknown): FailureClassification {
  const code = getStringProperty(error, "code")?.toUpperCase();
  const status = getNumberProperty(error, "status");

  if (code === "GENERATION_CANCELLED") {
    return { disposition: "fail", reason: "cancelled" };
  }

  if (code?.includes("MODERAT") || code?.includes("SAFETY") || code?.includes("CONTENT_POLICY")) {
    return { disposition: "fail", reason: "moderated" };
  }

  if (code === "INVALID_REQUEST" || code?.includes("UNSUPPORTED_CAPABILITY") || code?.includes("BUDGET")) {
    return { disposition: "fail", reason: "invalid-request" };
  }

  if (code === "CONFIGURATION_ERROR") {
    return { disposition: "fail", reason: "configuration" };
  }

  if (code === "GENERATION_TIMEOUT" || TRANSIENT_NETWORK_CODES.has(code ?? "") || isNetworkTypeError(error)) {
    return { disposition: "retry", reason: code === "GENERATION_TIMEOUT" ? "transient-status" : "transient-network" };
  }

  if (status !== undefined) {
    if (AUTHENTICATION_STATUSES.has(status)) {
      return { disposition: "fail", reason: "authentication" };
    }

    if (TRANSIENT_STATUSES.has(status)) {
      return { disposition: "retry", reason: "transient-status" };
    }

    return { disposition: "fallback", reason: "provider-terminal" };
  }

  if (code === "PROVIDER_ERROR") {
    return { disposition: "fallback", reason: "provider-terminal" };
  }

  return { disposition: "fail", reason: "unknown" };
}

function getStringProperty(value: unknown, key: string): string | undefined {
  if (!isRecord(value) || typeof value[key] !== "string") {
    return undefined;
  }

  return value[key] as string;
}

function getNumberProperty(value: unknown, key: string): number | undefined {
  if (!isRecord(value) || typeof value[key] !== "number") {
    return undefined;
  }

  return value[key] as number;
}

function isNetworkTypeError(error: unknown): boolean {
  return error instanceof TypeError && /(?:fetch|network|socket|connect)/i.test(error.message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
