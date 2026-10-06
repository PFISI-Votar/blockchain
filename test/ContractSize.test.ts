import { expect } from "chai";
import { artifacts } from "hardhat";

/**
 * EIP-170 deployed-bytecode ceiling is 24576 bytes. `ElectionFactory` embeds the
 * full creation bytecode of VoteRegistry + BallotContract + AuditViewContract, so
 * any growth in BallotContract (e.g. VOTAR-377's validator signature check) pushes
 * it toward the limit. This guard fails the build well before a deploy would revert.
 */
describe("Contract size — EIP-170 guard", () => {
  const EIP170_LIMIT = 24_576;
  // Headroom kept for future features; ElectionFactory is the tightest contract.
  const BUDGET: Record<string, number> = {
    ElectionFactory: 24_000,
    BallotContract: 24_000,
    VoteRegistry: 24_000,
    MerkleRootStore: 24_000,
    AuditViewContract: 24_000,
  };

  for (const [name, budget] of Object.entries(BUDGET)) {
    it(`${name} deployed bytecode stays under ${budget} bytes`, async () => {
      const artifact = await artifacts.readArtifact(name);
      const size = (artifact.deployedBytecode.length - 2) / 2;
      expect(size, `${name} is ${size} bytes`).to.be.lessThan(budget);
      expect(size).to.be.lessThan(EIP170_LIMIT);
    });
  }
});
