import { expect } from "chai";
import {
  classifyRpcFailoverReason,
  isBlockSkewAcceptable,
  isRpcFailoverError,
  parseRpcUrls,
  resolveSepoliaRpcUrls,
  sanitizeRpcUrl,
  withRpcFailover,
} from "../scripts/lib/rpc-failover";

describe("VOTAR-386 — RPC failover helpers", () => {
  it("parses Infura/Alchemy/QuickNode URLs", () => {
    expect(
      parseRpcUrls(
        "https://sepolia.infura.io/v3/aaa",
        "https://eth-sepolia.g.alchemy.com/v2/bbb, https://x.quiknode.pro/ccc"
      )
    ).to.deep.equal([
      "https://sepolia.infura.io/v3/aaa",
      "https://eth-sepolia.g.alchemy.com/v2/bbb",
      "https://x.quiknode.pro/ccc",
    ]);
  });

  it("redacts API keys in operator logs (UAT-04)", () => {
    expect(
      sanitizeRpcUrl("https://sepolia.infura.io/v3/abcd1234secret")
    ).to.equal("https://sepolia.infura.io/v3/abcd...");
  });

  it("classifies 429 / revoked keys / timeouts as failover errors", () => {
    expect(isRpcFailoverError(new Error("429 Too Many Requests"))).to.equal(
      true
    );
    expect(classifyRpcFailoverReason(new Error("invalid api key"))).to.equal(
      "auth"
    );
    expect(isRpcFailoverError(new Error("timeout exceeded"))).to.equal(true);
    expect(isRpcFailoverError(new Error("execution reverted"))).to.equal(false);
  });

  it("rejects backups with significant block skew", () => {
    expect(isBlockSkewAcceptable(100, 103, 5)).to.equal(true);
    expect(isBlockSkewAcceptable(100, 90, 5)).to.equal(false);
  });

  it("rotates to the backup URL after a 429 (UAT-03)", async () => {
    const logs: string[] = [];
    const value = await withRpcFailover(
      [
        "https://primary.example/rpc/secretkey12",
        "https://backup.example/rpc/backupkey12",
      ],
      async (url) => {
        if (url.includes("primary")) {
          throw new Error("429 Too Many Requests");
        }
        return url;
      },
      (message) => logs.push(message)
    );

    expect(value).to.include("backup");
    expect(logs[0]).to.include("reason=rate_limit");
    expect(logs[0]).to.not.include("secretkey12");
  });

  it("reads fallbacks from env", () => {
    expect(
      resolveSepoliaRpcUrls({
        SEPOLIA_RPC_URL: "https://a.example/rpc",
        SEPOLIA_RPC_FALLBACK_URLS: "https://b.example/rpc",
      })
    ).to.deep.equal(["https://a.example/rpc", "https://b.example/rpc"]);
  });
});
