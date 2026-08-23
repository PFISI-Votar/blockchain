export const RPC_FAILOVER_TIMEOUT_MS = 800;
export const RPC_MAX_BLOCK_SKEW = 5;

export type RpcFailoverReason =
  | "timeout"
  | "rate_limit"
  | "auth"
  | "unavailable"
  | "network";

export type WithRpcFailoverOptions = {
  readBlockNumber?: (url: string) => Promise<number>;
  maxBlockSkew?: number;
  lastKnownBlock?: number | null;
  onReferenceBlock?: (block: number) => void;
};

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

export const readEthBlockNumber = async (
  url: string,
  timeoutMs: number = RPC_FAILOVER_TIMEOUT_MS
): Promise<number> => {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_blockNumber",
      params: [],
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const payload = (await response.json()) as {
    result?: string;
    error?: { message?: string };
  };
  if (payload.error?.message) {
    throw new Error(payload.error.message);
  }
  if (!payload.result) {
    throw new Error("missing eth_blockNumber result");
  }
  return Number.parseInt(payload.result, 16);
};

export const withRpcFailover = async <T>(
  urls: readonly string[],
  fn: (url: string) => Promise<T>,
  log: (message: string) => void = console.warn,
  options: WithRpcFailoverOptions = {}
): Promise<T> => {
  if (urls.length === 0) {
    throw new Error("SEPOLIA_RPC_URL is required");
  }
  const maxBlockSkew = options.maxBlockSkew ?? RPC_MAX_BLOCK_SKEW;
  let lastError: unknown;
  let referenceBlock = options.lastKnownBlock ?? null;

  const rememberReferenceBlock = (block: number): void => {
    referenceBlock = block;
    options.onReferenceBlock?.(block);
  };

  const resolveReferenceBlock = async (): Promise<number | null> => {
    if (referenceBlock != null) {
      return referenceBlock;
    }
    if (!options.readBlockNumber) {
      return null;
    }
    try {
      rememberReferenceBlock(await options.readBlockNumber(urls[0]));
      return referenceBlock;
    } catch {
      return null;
    }
  };

  for (let index = 0; index < urls.length; index += 1) {
    const url = urls[index];
    const backup = urls[index + 1];

    try {
      if (index > 0 && options.readBlockNumber) {
        const refBlock = await resolveReferenceBlock();
        if (refBlock != null) {
          const candidateBlock = await options.readBlockNumber(url);
          const skew = Math.abs(refBlock - candidateBlock);
          if (!isBlockSkewAcceptable(refBlock, candidateBlock, maxBlockSkew)) {
            lastError = new Error(
              `RPC block skew ${skew} exceeds max ${maxBlockSkew}`
            );
            log(
              `[VOTAR rpc-failover] at=${new Date().toISOString()} reason=unavailable failed=${sanitizeRpcUrl(
                url
              )} backup=${backup ? sanitizeRpcUrl(backup) : "(none)"} skew=${skew} message=skipped backup: block skew ${skew} (ref=${refBlock}, backup=${candidateBlock})`
            );
            continue;
          }
        }
      }

      return await fn(url);
    } catch (error) {
      lastError = error;
      if (!backup || !isRpcFailoverError(error)) {
        throw error;
      }

      if (referenceBlock == null && options.readBlockNumber) {
        try {
          rememberReferenceBlock(await options.readBlockNumber(url));
        } catch {
          // Primary may be fully unavailable; skew check best-effort on next hop.
        }
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
