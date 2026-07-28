import { expect } from "chai";
import { FeeData } from "ethers";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { formatGwei, resolveGasOverrides } from "../scripts/lib/gas";
import { exportAbisToConsumers } from "../scripts/lib/export-abis";
import { isRetryableRpcError, withRetry } from "../scripts/lib/retry";
import {
  upsertDeploymentCatalog,
  writeDeploymentArtifact,
} from "../scripts/lib/write-deployment-artifact";

describe("VOTAR-385 — deploy automation helpers", () => {
  describe("isRetryableRpcError", () => {
    it("retries transient RPC / mempool errors", () => {
      expect(isRetryableRpcError(new Error("ECONNRESET"))).to.equal(true);
      expect(isRetryableRpcError(new Error("timeout exceeded"))).to.equal(true);
      expect(isRetryableRpcError(new Error("503 Service Unavailable"))).to.equal(
        true,
      );
      expect(
        isRetryableRpcError(new Error("replacement transaction underpriced")),
      ).to.equal(true);
    });

    it("does not retry permanent errors", () => {
      expect(isRetryableRpcError(new Error("insufficient funds"))).to.equal(
        false,
      );
      expect(isRetryableRpcError(new Error("execution reverted"))).to.equal(
        false,
      );
    });
  });

  describe("withRetry", () => {
    it("returns on first success", async () => {
      let calls = 0;
      const value = await withRetry(
        async () => {
          calls += 1;
          return 42;
        },
        { maxAttempts: 3, sleep: async () => undefined },
      );
      expect(value).to.equal(42);
      expect(calls).to.equal(1);
    });

    it("retries retryable failures then succeeds", async () => {
      let calls = 0;
      const delays: number[] = [];
      const value = await withRetry(
        async (attempt) => {
          calls += 1;
          if (attempt < 3) {
            throw new Error("socket hang up");
          }
          return "ok";
        },
        {
          maxAttempts: 5,
          baseDelayMs: 10,
          sleep: async (ms) => {
            delays.push(ms);
          },
        },
      );
      expect(value).to.equal("ok");
      expect(calls).to.equal(3);
      expect(delays).to.deep.equal([10, 20]);
    });

    it("throws when attempts are exhausted", async () => {
      try {
        await withRetry(
          async () => {
            throw new Error("ECONNRESET");
          },
          { maxAttempts: 2, sleep: async () => undefined },
        );
        expect.fail("should have thrown");
      } catch (error) {
        expect((error as Error).message).to.equal("ECONNRESET");
      }
    });

    it("does not retry non-retryable errors", async () => {
      let calls = 0;
      try {
        await withRetry(
          async () => {
            calls += 1;
            throw new Error("execution reverted: Unauthorized");
          },
          { maxAttempts: 5, sleep: async () => undefined },
        );
        expect.fail("should have thrown");
      } catch (error) {
        expect((error as Error).message).to.include("Unauthorized");
        expect(calls).to.equal(1);
      }
    });
  });

  describe("resolveGasOverrides", () => {
    const fakeProvider = {
      getFeeData: async () => {
        throw new Error("should use injected feeData");
      },
    } as never;

    it("uses network fees on attempt 1 without bump", async () => {
      const feeData = new FeeData(
        null,
        30_000_000_000n,
        1_500_000_000n,
      );
      const gas = await resolveGasOverrides(fakeProvider, 1, { feeData });
      expect(gas.maxFeePerGas).to.equal(30_000_000_000n);
      expect(gas.maxPriorityFeePerGas).to.equal(1_500_000_000n);
    });

    it("bumps fees on later attempts (UAT-02)", async () => {
      const feeData = new FeeData(
        null,
        20_000_000_000n,
        1_000_000_000n,
      );
      const gas = await resolveGasOverrides(fakeProvider, 3, {
        feeData,
        bumpPercentPerAttempt: 20,
      });
      // attempt 3 → multiplier 140%
      expect(gas.maxFeePerGas).to.equal(28_000_000_000n);
      expect(gas.maxPriorityFeePerGas).to.equal(1_400_000_000n);
    });

    it("formats gwei for logs", () => {
      expect(formatGwei(1_500_000_000n)).to.equal("1.500");
    });
  });

  describe("deployment artifacts", () => {
    const network = `test-votar-385-${Date.now()}`;
    const deploymentsDir = resolve(__dirname, `../deployments/${network}`);

    after(() => {
      if (existsSync(deploymentsDir)) {
        rmSync(deploymentsDir, { recursive: true, force: true });
      }
    });

    it("writes artifact + catalog with compiler metadata", () => {
      const artifactPath = writeDeploymentArtifact({
        contractName: "MerkleRootStore",
        network,
        chainId: 11155111,
        address: "0x0000000000000000000000000000000000000001",
        abi: [{ type: "function", name: "publishRoot" }],
        abiHash: "0xabc",
        txHash: "0xdead",
        blockNumber: 1,
        constructorArguments: ["0xadmin"],
        verified: true,
        deployedAt: "2026-07-17T00:00:00.000Z",
      });

      expect(existsSync(artifactPath)).to.equal(true);
      const artifact = JSON.parse(readFileSync(artifactPath, "utf8"));
      expect(artifact.contractName).to.equal("MerkleRootStore");
      expect(artifact.verified).to.equal(true);

      const catalogPath = upsertDeploymentCatalog({
        network,
        chainId: 11155111,
        compiler: {
          version: "0.8.26",
          optimizer: { enabled: true, runs: 200 },
          evmVersion: "cancun",
        },
        entry: {
          contractName: "MerkleRootStore",
          address: artifact.address,
          abiHash: artifact.abiHash,
          verified: true,
          artifactPath,
        },
      });

      const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
      expect(catalog.compiler.version).to.equal("0.8.26");
      expect(catalog.contracts).to.have.length(1);
      expect(catalog.contracts[0].contractName).to.equal("MerkleRootStore");
    });
  });

  describe("exportAbisToConsumers", () => {
    const backDir = resolve(__dirname, `../tmp-abis-back-${Date.now()}`);
    const frontDir = resolve(__dirname, `../tmp-abis-front-${Date.now()}`);

    after(() => {
      for (const dir of [backDir, frontDir]) {
        if (existsSync(dir)) {
          rmSync(dir, { recursive: true, force: true });
        }
      }
      delete process.env.ABI_EXPORT_BACK_DIR;
      delete process.env.ABI_EXPORT_FRONT_DIR;
    });

    it("exports full ABIs to back and front directories", async () => {
      process.env.ABI_EXPORT_BACK_DIR = backDir;
      process.env.ABI_EXPORT_FRONT_DIR = frontDir;

      const result = await exportAbisToConsumers(["BallotContract"]);
      expect(result.back).to.have.length(1);
      expect(result.front).to.have.length(1);

      const payload = JSON.parse(
        readFileSync(resolve(backDir, "BallotContract.json"), "utf8"),
      );
      expect(payload.contractName).to.equal("BallotContract");
      expect(payload.abiHash).to.match(/^0x[0-9a-f]{64}$/);
      expect(payload.abi.some((e: { name?: string }) => e.name === "castSignedVote")).to.equal(
        true,
      );
    });
  });
});
