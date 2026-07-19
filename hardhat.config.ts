import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import * as dotenv from "dotenv";

dotenv.config();

const SEPOLIA_RPC_URL = process.env.SEPOLIA_RPC_URL ?? "";
const PRIVATE_KEY = process.env.PRIVATE_KEY ?? "";
const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY ?? "";

/**
 * Compiler settings are pinned so bytecode is identical across machines
 * under the same Solidity version (VOTAR-385 — reproducible deploy).
 */
const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.26",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: "cancun",
    },
  },
  networks: {
    hardhat: {
      mining: {
        auto: true,
        interval: 0,
      },
    },
    localhost: {
      url: "http://127.0.0.1:8545",
    },
    // Sepolia only registers when secrets are present, so `compile`/`test`
    // work out of the box without a .env file.
    ...(SEPOLIA_RPC_URL && PRIVATE_KEY
      ? {
          sepolia: {
            url: SEPOLIA_RPC_URL,
            accounts: [PRIVATE_KEY],
            // Tolerate Infura/Alchemy micro-outages during deploy (VOTAR-385).
            timeout: 180_000,
            // Multiplies gas *limit* estimates; fee bumps are handled in scripts/lib/gas.ts.
            gasMultiplier: 1.15,
          },
        }
      : {}),
  },
  // Automatic source verification after Sepolia deploy (VOTAR-337 / VOTAR-385).
  etherscan: {
    apiKey: ETHERSCAN_API_KEY || undefined,
  },
  sourcify: {
    enabled: true,
  },
};

export default config;
