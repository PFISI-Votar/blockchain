import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export type ElectionFactoryDeploymentArtifact = {
  contractName: "ElectionFactory";
  network: string;
  chainId: number;
  address: string;
  abi: unknown[];
  abiHash: string;
  txHash: string | null;
  blockNumber: number | null;
  admin: string;
  merkleRootStore: string;
  verified: boolean;
  deployedAt: string;
};

/**
 * Writes a deployment artifact consumed by the NestJS sync script (VOTAR-337).
 */
export const writeElectionFactoryArtifact = (
  artifact: ElectionFactoryDeploymentArtifact,
): string => {
  const outPath = resolve(
    __dirname,
    `../../deployments/${artifact.network}/ElectionFactory.json`,
  );
  const directory = dirname(outPath);
  if (!existsSync(directory)) {
    mkdirSync(directory, { recursive: true });
  }
  writeFileSync(outPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  return outPath;
};
