export const RPC_FAILOVER_TIMEOUT_MS = 800;
export const RPC_MAX_BLOCK_SKEW = 5;

export type RpcFailoverReason =
  | "timeout"
  | "rate_limit"
  | "auth"
  | "unavailable"
  | "network";

export const parseRpcUrls = (
  primary?: string | null,
  fallbacks?: string | null
): string[] => {
  const collected = [primary, ...(fallbacks ?? "").split(",")]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));
  return [...new Set(collected)];
};

export const sanitizeRpcUrl = (url: string): string => {
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split("/");
    const last = segments[segments.length - 1];
    if (last && last.length > 8) {
      segments[segments.length - 1] = `${last.slice(0, 4)}...`;
    }
    return `${parsed.origin}${segments.join("/")}`;
  } catch {
    return "(invalid-url)";
  }
};

const errorText = (error: unknown): string =>
  error instanceof Error ? `${error.name} ${error.message}` : String(error);

export const classifyRpcFailoverReason = (
  error: unknown
): RpcFailoverReason | null => {
  const text = errorText(error);
  if (/429|too many requests|rate limit|-32005/i.test(text)) {
    return "rate_limit";
  }
  if (/401|403|unauthorized|forbidden|api key/i.test(text)) {
    return "auth";
  }
  if (/timeout|timed out|aborted/i.test(text)) {
    return "timeout";
  }
  if (/502|503|504|gateway/i.test(text)) {
    return "unavailable";
  }
  if (/econnreset|econnrefused|enotfound|fetch failed|network/i.test(text)) {
    return "network";
  }
  return null;
};

export const isRpcFailoverError = (error: unknown): boolean =>
  classifyRpcFailoverReason(error) != null;

export const isBlockSkewAcceptable = (
  referenceBlock: number,
  candidateBlock: number,
  maxSkew: number
): boolean => Math.abs(referenceBlock - candidateBlock) <= maxSkew;

export const resolveSepoliaRpcUrls = (
  env: NodeJS.Dict<string> = process.env
): string[] => parseRpcUrls(env.SEPOLIA_RPC_URL, env.SEPOLIA_RPC_FALLBACK_URLS);

export const withRpcFailover = async <T>(
  urls: readonly string[],
  fn: (url: string) => Promise<T>,
  log: (message: string) => void = console.warn
): Promise<T> => {
  if (urls.length === 0) {
    throw new Error("SEPOLIA_RPC_URL is required");
  }
  let lastError: unknown;
  for (let index = 0; index < urls.length; index += 1) {
    const url = urls[index];
    const backup = urls[index + 1];
    try {
      return await fn(url);
    } catch (error) {
      lastError = error;
      if (!backup || !isRpcFailoverError(error)) {
        throw error;
      }
      const reason = classifyRpcFailoverReason(error) ?? "network";
      log(
        `[VOTAR rpc-failover] at=${new Date().toISOString()} reason=${reason} failed=${sanitizeRpcUrl(
          url
        )} backup=${sanitizeRpcUrl(backup)} message=${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }
  throw lastError;
};
