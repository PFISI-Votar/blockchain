import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export type DeploymentArtifact = {
  contractName: string;
  network: string;
  chainId: number;
  address: string;
  abi: unknown[];
  abiHash: string;
  txHash: string | null;
  blockNumber: number | null;
  constructorArguments?: unknown[];
  verified: boolean;
  deployedAt: string;
  /** Extra metadata (admin, merkleRootStore, etc.). */
  meta?: Record<string, unknown>;
};

/** VOTAR-337 shape — flat admin / merkleRootStore fields. */
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
  /** VOTAR-347 — operational address granted PAUSER_ROLE on every created election. */
  pauserOperator: string;
  verified: boolean;
  deployedAt: string;
};

export type DeploymentCatalogEntry = {
  contractName: string;
  address: string;
  abiHash: string;
  verified: boolean;
  artifactPath: string;
};

export type DeploymentCatalog = {
  network: string;
  chainId: number;
  compiler: {
    version: string;
    optimizer: { enabled: boolean; runs: number };
    evmVersion: string;
  };
  deployedAt: string;
  contracts: DeploymentCatalogEntry[];
};

const deploymentsRoot = (...segments: string[]) =>
  resolve(__dirname, "../../deployments", ...segments);

/**
 * Writes a per-contract deployment artifact under deployments/<network>/.
 */
export const writeDeploymentArtifact = (
  artifact: DeploymentArtifact,
): string => {
  const outPath = deploymentsRoot(
    artifact.network,
    `${artifact.contractName}.json`,
  );
  const directory = dirname(outPath);
  if (!existsSync(directory)) {
    mkdirSync(directory, { recursive: true });
  }
  writeFileSync(outPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  return outPath;
};

/**
 * Writes ElectionFactory artifact (VOTAR-337) with admin/store flattened for sync.
 */
export const writeElectionFactoryArtifact = (
  artifact: ElectionFactoryDeploymentArtifact,
): string => {
  const payload = {
    ...artifact,
    constructorArguments: [
      artifact.admin,
      artifact.merkleRootStore,
      artifact.pauserOperator,
    ],
    meta: {
      admin: artifact.admin,
      merkleRootStore: artifact.merkleRootStore,
      pauserOperator: artifact.pauserOperator,
    },
  };
  const outPath = deploymentsRoot(artifact.network, "ElectionFactory.json");
  const directory = dirname(outPath);
  if (!existsSync(directory)) {
    mkdirSync(directory, { recursive: true });
  }
  writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return outPath;
};

/**
 * Upserts the network catalog (UAT-01 artifact index).
 */
export const upsertDeploymentCatalog = (params: {
  network: string;
  chainId: number;
  compiler: DeploymentCatalog["compiler"];
  entry: DeploymentCatalogEntry;
}): string => {
  const outPath = deploymentsRoot(params.network, "catalog.json");
  const directory = dirname(outPath);
  if (!existsSync(directory)) {
    mkdirSync(directory, { recursive: true });
  }

  let catalog: DeploymentCatalog = {
    network: params.network,
    chainId: params.chainId,
    compiler: params.compiler,
    deployedAt: new Date().toISOString(),
    contracts: [],
  };

  if (existsSync(outPath)) {
    try {
      catalog = JSON.parse(
        readFileSync(outPath, "utf8"),
      ) as DeploymentCatalog;
    } catch {
      // Corrupt catalog — rewrite from scratch.
    }
  }

  catalog.network = params.network;
  catalog.chainId = params.chainId;
  catalog.compiler = params.compiler;
  catalog.deployedAt = new Date().toISOString();
  catalog.contracts = [
    ...catalog.contracts.filter(
      (c) => c.contractName !== params.entry.contractName,
    ),
    params.entry,
  ].sort((a, b) => a.contractName.localeCompare(b.contractName));

  writeFileSync(outPath, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");
  return outPath;
};
