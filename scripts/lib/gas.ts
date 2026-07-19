import type { FeeData, Provider } from "ethers";

export type GasFeeOverrides = {
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
};

export type ResolveGasOptions = {
  /** Percent bump applied per attempt (default 20 → attempt 1 = +0%, 2 = +20%, …). */
  bumpPercentPerAttempt?: number;
  /** Floor for priority fee in wei when the RPC returns null/0. */
  minPriorityFeeWei?: bigint;
  /** Optional fee data injector for unit tests. */
  feeData?: FeeData;
};

/**
 * Builds EIP-1559 fee overrides with a progressive bump for retries (VOTAR-385).
 * Keeps fees as low as possible on attempt 1 and only raises them on RPC/mempool pressure.
 */
export const resolveGasOverrides = async (
  provider: Provider,
  attempt: number,
  options: ResolveGasOptions = {},
): Promise<GasFeeOverrides> => {
  const bumpPercent = options.bumpPercentPerAttempt ?? 20;
  const minPriority = options.minPriorityFeeWei ?? 1_000_000_000n; // 1 gwei
  const feeData = options.feeData ?? (await provider.getFeeData());

  const baseMaxFee = feeData.maxFeePerGas ?? feeData.gasPrice;
  const basePriority =
    feeData.maxPriorityFeePerGas ?? feeData.gasPrice ?? minPriority;

  if (baseMaxFee == null) {
    throw new Error(
      "RPC did not return fee data (maxFeePerGas/gasPrice). Cannot set dynamic gas.",
    );
  }

  const safePriority =
    basePriority != null && basePriority > 0n ? basePriority : minPriority;
  const multiplier = 100n + BigInt(Math.max(0, attempt - 1) * bumpPercent);

  const maxPriorityFeePerGas = (safePriority * multiplier) / 100n;
  let maxFeePerGas = (baseMaxFee * multiplier) / 100n;

  // maxFee must cover base + tip; pad if the RPC returned a skinny maxFee.
  if (maxFeePerGas < maxPriorityFeePerGas) {
    maxFeePerGas = maxPriorityFeePerGas * 2n;
  }

  return { maxFeePerGas, maxPriorityFeePerGas };
};

/**
 * Human-readable gwei string for deploy logs.
 */
export const formatGwei = (wei: bigint): string => {
  const whole = wei / 1_000_000_000n;
  const frac = (wei % 1_000_000_000n).toString().padStart(9, "0").slice(0, 3);
  return `${whole}.${frac}`;
};
