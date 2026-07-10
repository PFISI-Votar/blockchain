import { StandardMerkleTree } from "@openzeppelin/merkle-tree";
import { keccak256 } from "js-sha3";

/** Mirrors backend `hashVotante` (keccak.util.ts). */
export function hashVotante(dni: string, email: string): string {
  const dniNormalizado = dni.trim().replace(/\D/g, "");
  const emailNormalizado = email.trim().toLowerCase();
  return keccak256(`${dniNormalizado}:${emailNormalizado}`);
}

export function toBytes32Hex(hashHex: string): string {
  const normalized = hashHex.startsWith("0x") ? hashHex.slice(2) : hashHex;
  return `0x${normalized.toLowerCase()}`;
}

export interface PadronMerkleFixture {
  merkleRoot: string;
  sortedHashes: string[];
  tree: StandardMerkleTree<[string]>;
}

/**
 * Builds a Merkle tree identical to backend MerkleBuilderService.buildFromLeaves().
 */
export function buildPadronMerkleTree(hashes: string[]): PadronMerkleFixture {
  const sorted = [...hashes].sort((a, b) => a.localeCompare(b));
  const values = sorted.map((hash) => [toBytes32Hex(hash)] as [string]);
  const tree = StandardMerkleTree.of(values, ["bytes32"]);
  return { merkleRoot: tree.root, sortedHashes: sorted, tree };
}

export function getMerkleProof(tree: StandardMerkleTree<[string]>, leafIndex: number): string[] {
  return tree.getProof(leafIndex);
}
