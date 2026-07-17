import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { artifacts } from "hardhat";

/** Contracts whose full ABI is exported to NestJS / Vite consumers. */
export const EXPORTABLE_CONTRACTS = [
  "MerkleRootStore",
  "VoteRegistry",
  "BallotContract",
  "AuditViewContract",
  "ElectionFactory",
] as const;

export type ExportableContract = (typeof EXPORTABLE_CONTRACTS)[number];

export type ExportedAbiFile = {
  contractName: string;
  abiHash: string;
  path: string;
};

export type ExportAbisResult = {
  back: ExportedAbiFile[];
  front: ExportedAbiFile[];
};

const defaultBackDir = () =>
  process.env.ABI_EXPORT_BACK_DIR?.trim() ||
  resolve(__dirname, "../../../back/src/blockchain/abis");

const defaultFrontDir = () =>
  process.env.ABI_EXPORT_FRONT_DIR?.trim() ||
  resolve(__dirname, "../../../front/src/lib/blockchain/abis");

const hashAbi = (abi: unknown[]): string =>
  `0x${createHash("sha256").update(JSON.stringify(abi)).digest("hex")}`;

const ensureDir = (dir: string) => {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
};

const writeAbiJson = (
  directory: string,
  contractName: string,
  abi: unknown[],
  abiHash: string,
): ExportedAbiFile => {
  ensureDir(directory);
  const outPath = resolve(directory, `${contractName}.json`);
  const payload = {
    contractName,
    abiHash,
    abi,
    exportedAt: new Date().toISOString(),
    source: "blockchain/scripts/lib/export-abis.ts (VOTAR-385)",
  };
  writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return { contractName, abiHash, path: outPath };
};

/**
 * Loads the compiled Hardhat artifact ABI for a contract.
 */
export const loadCompiledAbi = async (
  contractName: ExportableContract,
): Promise<{ abi: unknown[]; abiHash: string }> => {
  const artifact = await artifacts.readArtifact(contractName);
  const abi = artifact.abi as unknown[];
  return { abi, abiHash: hashAbi(abi) };
};

/**
 * Exports full contract ABIs into backend and frontend directories (VOTAR-385).
 * Missing sibling repos are skipped with a warning (CI / solo blockchain clone).
 */
export const exportAbisToConsumers = async (
  contractNames: readonly ExportableContract[] = EXPORTABLE_CONTRACTS,
): Promise<ExportAbisResult> => {
  const backDir = defaultBackDir();
  const frontDir = defaultFrontDir();
  const result: ExportAbisResult = { back: [], front: [] };

  const skipBack = process.env.SKIP_ABI_EXPORT_BACK === "true";
  const skipFront = process.env.SKIP_ABI_EXPORT_FRONT === "true";

  for (const contractName of contractNames) {
    const { abi, abiHash } = await loadCompiledAbi(contractName);

    if (!skipBack) {
      try {
        result.back.push(writeAbiJson(backDir, contractName, abi, abiHash));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(
          `[export-abis] Could not write backend ABI for ${contractName}: ${message}`,
        );
      }
    }

    if (!skipFront) {
      try {
        result.front.push(writeAbiJson(frontDir, contractName, abi, abiHash));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(
          `[export-abis] Could not write frontend ABI for ${contractName}: ${message}`,
        );
      }
    }
  }

  if (result.back.length > 0) {
    console.log(
      `[export-abis] Wrote ${result.back.length} ABI(s) to ${backDir}`,
    );
  }
  if (result.front.length > 0) {
    console.log(
      `[export-abis] Wrote ${result.front.length} ABI(s) to ${frontDir}`,
    );
  }

  return result;
};
