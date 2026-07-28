export type RetryOptions = {
  maxAttempts?: number;
  /** Base delay in ms before the first retry (doubles each attempt). */
  baseDelayMs?: number;
  label?: string;
  isRetryable?: (error: unknown) => boolean;
  sleep?: (ms: number) => Promise<void>;
};

const DEFAULT_RETRYABLE_PATTERNS = [
  /timeout/i,
  /timed out/i,
  /econnreset/i,
  /econnrefused/i,
  /enotfound/i,
  /socket hang up/i,
  /network/i,
  /503/,
  /502/,
  /429/,
  /rate limit/i,
  /nonce too low/i,
  /replacement transaction underpriced/i,
  /already known/i,
  /server error/i,
  /gateway/i,
];

/**
 * Returns true when an RPC / mempool error is worth retrying (VOTAR-385 UAT-02).
 */
export const isRetryableRpcError = (error: unknown): boolean => {
  const message =
    error instanceof Error
      ? `${error.name}: ${error.message}`
      : String(error);
  return DEFAULT_RETRYABLE_PATTERNS.some((pattern) => pattern.test(message));
};

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Retries an async operation with exponential backoff on transient RPC failures.
 */
export const withRetry = async <T>(
  fn: (attempt: number) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> => {
  const maxAttempts = options.maxAttempts ?? 5;
  const baseDelayMs = options.baseDelayMs ?? 1_000;
  const label = options.label ?? "operation";
  const isRetryable = options.isRetryable ?? isRetryableRpcError;
  const sleep = options.sleep ?? defaultSleep;

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      const retryable = isRetryable(error);
      if (!retryable || attempt === maxAttempts) {
        throw error;
      }
      const delayMs = baseDelayMs * 2 ** (attempt - 1);
      const message = error instanceof Error ? error.message : String(error);
      console.warn(
        `[retry] ${label} failed (attempt ${attempt}/${maxAttempts}): ${message}`,
      );
      console.warn(`[retry] Waiting ${delayMs}ms before next attempt...`);
      await sleep(delayMs);
    }
  }
  throw lastError;
};
