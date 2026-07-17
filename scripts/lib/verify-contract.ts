import { run } from "hardhat";

export type VerifyContractParams = {
  address: string;
  constructorArguments?: unknown[];
  networkName: string;
  /** Delay before first verify attempt (Etherscan indexing). */
  indexingDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
};

/**
 * Verifies contract source on Etherscan when configured (VOTAR-385 / UAT-03).
 * Treats "already verified" as success. Returns false when skipped or failed.
 */
export const verifyContractSource = async (
  params: VerifyContractParams,
): Promise<boolean> => {
  const skipVerify = process.env.SKIP_VERIFY === "true";
  const apiKey = process.env.ETHERSCAN_API_KEY?.trim();

  if (params.networkName !== "sepolia") {
    return false;
  }
  if (skipVerify) {
    console.warn("[verify] SKIP_VERIFY=true — skipping Etherscan verification");
    return false;
  }
  if (!apiKey) {
    console.warn(
      "[verify] ETHERSCAN_API_KEY not set — skipping automatic verification",
    );
    return false;
  }

  const sleep =
    params.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const delay = params.indexingDelayMs ?? 15_000;

  console.log(
    `[verify] Waiting ${delay}ms for Etherscan indexing of ${params.address}...`,
  );
  await sleep(delay);

  try {
    await run("verify:verify", {
      address: params.address,
      constructorArguments: params.constructorArguments ?? [],
    });
    console.log(`[verify] Source verified on Etherscan: ${params.address}`);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.toLowerCase().includes("already verified")) {
      console.log(`[verify] Source already verified: ${params.address}`);
      return true;
    }
    console.error(`[verify] Etherscan verification failed: ${message}`);
    return false;
  }
};
