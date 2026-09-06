import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import type { Interface, Log, ParamType } from "ethers";
import {
  BallotContract,
  MerkleRootStore,
  VoteRegistry,
} from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import {
  buildPadronMerkleTree,
  getMerkleProof,
  hashVotante,
  toBytes32Hex,
} from "./helpers/merkle";
import { castSignedVote, VoteFields } from "./helpers/vote";

const ELECTION_ID = 378n;
const VOTER_DNI = "30222333";
const VOTER_EMAIL = "bruno@frvm.utn.edu.ar";
const VOTER_NAME = "Bruno Pérez";
const VOTER_HASH = hashVotante(VOTER_DNI, VOTER_EMAIL);
const VOTER_LEAF = toBytes32Hex(VOTER_HASH);
const TIMESTAMP = 1_700_000_000n;
const CANDIDATE_ID = 101n;
const PLAINTEXT_PII = [VOTER_DNI, VOTER_EMAIL, VOTER_NAME, "30111222", "ana@frvm.utn.edu.ar"];
const FORBIDDEN_PARAM_NAMES = /^(dni|email|nombre|apellido|documento|cuil|cuit|telefono|legajo|fullname|votername)$/i;
const CONTRACT_FACTORIES = [
  "BallotContract",
  "VoteRegistry",
  "MerkleRootStore",
  "ElectionFactory",
  "AuditViewContract",
] as const;

function computeSelectionHash(): string {
  const normalized = {
    votoEnBlanco: false,
    votoNulo: false,
    selecciones: [{ idCategoria: 1, idCandidato: 101 }],
  };
  return ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(normalized)));
}

function walkParamTypes(param: ParamType, path: string): Array<{ path: string; type: string; name: string }> {
  if (param.baseType === "tuple" && param.components) {
    return param.components.flatMap((component, index) =>
      walkParamTypes(component, `${path}.${component.name || String(index)}`),
    );
  }
  if (param.arrayChildren) {
    return walkParamTypes(param.arrayChildren, `${path}[]`);
  }
  return [{ path, type: param.type, name: param.name }];
}

function isOperationalPauseString(fragmentName: string, paramName: string): boolean {
  return paramName === "reason" && (fragmentName === "pause" || fragmentName === "Paused");
}

function hexToSearchableText(hex: string): string {
  const bytes = Buffer.from(hex.replace(/^0x/, ""), "hex");
  return bytes.toString("utf8").replace(/\0/g, "");
}

function assertNoPlaintextPii(label: string, value: unknown): void {
  const text = JSON.stringify(value).toLowerCase();
  for (const token of PLAINTEXT_PII) {
    expect(text, `${label} contains plaintext PII "${token}"`).to.not.include(token.toLowerCase());
  }
}

describe("VOTAR-378 Ley 25.326 — sin PII on-chain", () => {
  let store: MerkleRootStore;
  let registry: VoteRegistry;
  let ballot: BallotContract;
  let voter: HardhatEthersSigner;
  let validator: HardhatEthersSigner;
  let validProof: string[];
  let nullifier: string;
  let selectionHash: string;

  async function deployFixture() {
    const [admin, merkleUpdater, validator, voter] = await ethers.getSigners();

    const storeFactory = await ethers.getContractFactory("MerkleRootStore");
    const store = await storeFactory.deploy(admin.address);
    await store.waitForDeployment();

    const registryFactory = await ethers.getContractFactory("VoteRegistry");
    const registry = await registryFactory.deploy(admin.address, false);
    await registry.waitForDeployment();

    const ballotFactory = await ethers.getContractFactory("BallotContract");
    const ballot = await ballotFactory.deploy(
      admin.address,
      await store.getAddress(),
      await registry.getAddress(),
      10,
      0,
      0,
    );
    await ballot.waitForDeployment();

    // VOTAR-377 — Entidad de Firmas Digitales must hold VALIDATOR_ROLE.
    await ballot.connect(admin).grantRole(await ballot.VALIDATOR_ROLE(), validator.address);

    await registry.connect(admin).grantRole(await registry.BALLOT_ROLE(), await ballot.getAddress());
    await registry.connect(admin).grantRole(await registry.ELECTION_ADMIN_ROLE(), admin.address);
    await registry.connect(admin).registerCandidates(ELECTION_ID, [101n, 102n, 103n]);

    await store.connect(admin).grantRole(await store.MERKLE_UPDATER_ROLE(), merkleUpdater.address);
    await store.connect(admin).grantRole(await store.ELECTION_ADMIN_ROLE(), admin.address);

    const hashes = [
      hashVotante("30111222", "ana@frvm.utn.edu.ar"),
      VOTER_HASH,
      hashVotante("30333444", "carla@frvm.utn.edu.ar"),
    ];
    const { merkleRoot, sortedHashes, tree } = buildPadronMerkleTree(hashes);
    const voterLeafIndex = sortedHashes.indexOf(VOTER_HASH);
    const validProof = getMerkleProof(tree, voterLeafIndex);

    await store.connect(merkleUpdater).publishRoot(ELECTION_ID, merkleRoot);
    const now = Math.floor(Date.now() / 1000);
    await store.connect(admin).setElectionWindow(ELECTION_ID, now, now + 3600);
    await store.connect(admin).setElectionState(ELECTION_ID, 2);

    return {
      store,
      registry,
      ballot,
      voter,
      validator,
      validProof,
      nullifier: "0x1111111111111111111111111111111111111111111111111111111111111111",
      selectionHash: computeSelectionHash(),
    };
  }

  beforeEach(async () => {
    ({ store, registry, ballot, voter, validator, validProof, nullifier, selectionHash } =
      await loadFixture(deployFixture));
  });

  describe("UAT-01: ABI y eventos sin datos personales en claro", () => {
    it("no declara parámetros string (salvo reason operacional de pause) ni nombres de PII", async () => {
      for (const name of CONTRACT_FACTORIES) {
        const factory = await ethers.getContractFactory(name);
        for (const fragment of factory.interface.fragments) {
          if (fragment.type !== "function" && fragment.type !== "event") {
            continue;
          }
          const inputs = "inputs" in fragment && fragment.inputs ? fragment.inputs : [];
          for (const input of inputs) {
            for (const walked of walkParamTypes(input, `${name}.${fragment.name}.${input.name}`)) {
              expect(walked.name, walked.path).to.not.match(FORBIDDEN_PARAM_NAMES);
              if (walked.type.startsWith("string")) {
                expect(
                  isOperationalPauseString(fragment.name, walked.name),
                  `${walked.path} usa string (PII potencial)`,
                ).to.equal(true);
              }
            }
          }
        }
      }
    });

    it("SignedVoteCast y VoteCast sólo exponen hashes/ids anónimos, nunca voterLeaf ni PII", async () => {
      const signedVote = ballot.interface.getEvent("SignedVoteCast");
      expect(signedVote.inputs.map((input) => `${input.name}:${input.type}`)).to.deep.equal([
        "electionId:uint256",
        "nullifier:bytes32",
        "selectionHash:bytes32",
        "signer:address",
      ]);
      expect(signedVote.inputs.map((input) => input.name)).to.not.include("voterLeaf");

      const voteCast = registry.interface.getEvent("VoteCast");
      expect(voteCast.inputs.map((input) => `${input.name}:${input.type}`)).to.deep.equal([
        "electionId:uint256",
        "voterHash:bytes32",
        "candidateId:uint256",
        "isOverwrite:bool",
      ]);

      const rootPublished = store.interface.getEvent("RootPublished");
      expect(rootPublished.inputs.map((input) => `${input.name}:${input.type}`)).to.deep.equal([
        "electionId:uint256",
        "root:bytes32",
        "timestamp:uint256",
      ]);
    });

    it("un voto firmado no deja DNI/email/nombre en calldata, logs ni argumentos decodificados", async () => {
      // VOTAR-377 — castSignedVote(SignedVoteInput, merkleProof, signature, validatorSignature).
      const fields: VoteFields = {
        electionId: ELECTION_ID,
        voterLeaf: VOTER_LEAF,
        nullifier,
        selectionHash,
        candidateId: CANDIDATE_ID,
        timestamp: TIMESTAMP,
        expectedSigner: voter.address,
      };

      const tx = await castSignedVote(ballot, {
        gasPayer: voter,
        ephemeralSigner: voter,
        validator,
        fields,
        merkleProof: validProof,
      });
      const receipt = await tx.wait();
      expect(receipt).to.not.equal(null);

      const txData = tx.data;
      assertNoPlaintextPii("calldata", hexToSearchableText(txData));

      const interfaces: Interface[] = [ballot.interface, registry.interface, store.interface];
      const decodedEvents: Array<{ name: string; args: unknown[] }> = [];
      for (const log of receipt!.logs as Log[]) {
        assertNoPlaintextPii(`log ${log.topics[0]}`, hexToSearchableText(log.data));
        for (const topic of log.topics) {
          assertNoPlaintextPii(`topic ${topic}`, hexToSearchableText(topic));
        }
        for (const iface of interfaces) {
          try {
            const parsed = iface.parseLog({ topics: log.topics as string[], data: log.data });
            if (parsed) {
              decodedEvents.push({ name: parsed.name, args: [...parsed.args] });
              assertNoPlaintextPii(`event ${parsed.name}`, parsed.args);
            }
          } catch {
            // Log belongs to another interface (e.g. AccessControl).
          }
        }
      }

      const signed = decodedEvents.find((event) => event.name === "SignedVoteCast");
      expect(signed, "SignedVoteCast must be emitted").to.not.equal(undefined);
      expect(signed!.args).to.not.deep.include(VOTER_LEAF);

      const voteCast = decodedEvents.find((event) => event.name === "VoteCast");
      expect(voteCast, "VoteCast must be emitted").to.not.equal(undefined);
      expect(voteCast!.args[1]).to.equal(nullifier);
      expect(voteCast!.args[1]).to.not.equal(VOTER_LEAF);
    });
  });
});
