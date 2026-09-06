import { ethers } from "hardhat";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { BallotContract } from "../../typechain-types";

/** Anything that can produce an EIP-712 signature (HardhatEthersSigner, Wallet, …). */
export type TypedDataSigner = {
  signTypedData(
    domain: Record<string, unknown>,
    types: Record<string, Array<{ name: string; type: string }>>,
    value: Record<string, unknown>,
  ): Promise<string>;
};

/**
 * EIP-712 helpers for {BallotContract.castSignedVote} (VOTAR-357 + VOTAR-377).
 *
 * The ballot payload is bundled into the `SignedVoteInput` calldata struct; the
 * transaction also carries two ECDSA signatures over the same EIP-712 domain:
 *  - `signature`          — ephemeral session key (proves the voter authored the ballot)
 *  - `validatorSignature` — "Entidad de Firmas Digitales" (proves padrón membership)
 */
export const VOTE_TYPE = {
  Vote: [
    { name: "electionId", type: "uint256" },
    { name: "nullifier", type: "bytes32" },
    { name: "selectionHash", type: "bytes32" },
    { name: "candidateId", type: "uint256" },
    { name: "timestamp", type: "uint256" },
  ],
};

export const VALIDATION_TYPE = {
  Validation: [
    { name: "electionId", type: "uint256" },
    { name: "nullifier", type: "bytes32" },
    { name: "selectionHash", type: "bytes32" },
    { name: "candidateId", type: "uint256" },
    { name: "timestamp", type: "uint256" },
    { name: "expectedSigner", type: "address" },
  ],
};

export interface VoteFields {
  electionId: bigint;
  voterLeaf: string;
  nullifier: string;
  selectionHash: string;
  candidateId: bigint;
  timestamp: bigint;
  expectedSigner: string;
}

/** The `SignedVoteInput` calldata struct as an ethers-compatible object. */
export function toSignedVoteInput(fields: VoteFields) {
  return {
    electionId: fields.electionId,
    voterLeaf: fields.voterLeaf,
    nullifier: fields.nullifier,
    selectionHash: fields.selectionHash,
    candidateId: fields.candidateId,
    timestamp: fields.timestamp,
    expectedSigner: fields.expectedSigner,
  };
}

export async function eip712Domain(ballot: BallotContract) {
  return {
    name: "VOTAR",
    version: "1",
    chainId: (await ethers.provider.getNetwork()).chainId,
    verifyingContract: await ballot.getAddress(),
  };
}

/** Ephemeral-key signature over the EIP-712 `Vote` digest. */
export async function signVote(
  signer: TypedDataSigner,
  ballot: BallotContract,
  fields: VoteFields,
): Promise<string> {
  const domain = await eip712Domain(ballot);
  return signer.signTypedData(domain, VOTE_TYPE, {
    electionId: fields.electionId,
    nullifier: fields.nullifier,
    selectionHash: fields.selectionHash,
    candidateId: fields.candidateId,
    timestamp: fields.timestamp,
  });
}

/** Institutional signature over the EIP-712 `Validation` digest (VOTAR-377). */
export async function signValidation(
  validator: TypedDataSigner,
  ballot: BallotContract,
  fields: VoteFields,
): Promise<string> {
  const domain = await eip712Domain(ballot);
  return validator.signTypedData(domain, VALIDATION_TYPE, {
    electionId: fields.electionId,
    nullifier: fields.nullifier,
    selectionHash: fields.selectionHash,
    candidateId: fields.candidateId,
    timestamp: fields.timestamp,
    expectedSigner: fields.expectedSigner,
  });
}

export interface CastOverrides {
  signature?: string;
  validatorSignature?: string;
  merkleProof?: string[];
}

/**
 * Signs (ephemeral + validator) and submits a vote. `voterSigner` is the account
 * paying gas (the platform transmitter in production); `ephemeralSigner` and
 * `validator` produce the two EIP-712 signatures.
 */
export async function castSignedVote(
  ballot: BallotContract,
  args: {
    gasPayer: HardhatEthersSigner;
    ephemeralSigner: TypedDataSigner;
    validator: TypedDataSigner;
    fields: VoteFields;
    merkleProof: string[];
  },
  overrides: CastOverrides = {},
) {
  const signature =
    overrides.signature ??
    (await signVote(args.ephemeralSigner, ballot, args.fields));
  const validatorSignature =
    overrides.validatorSignature ??
    (await signValidation(args.validator, ballot, args.fields));

  return ballot
    .connect(args.gasPayer)
    .castSignedVote(
      toSignedVoteInput(args.fields),
      overrides.merkleProof ?? args.merkleProof,
      signature,
      validatorSignature,
    );
}
