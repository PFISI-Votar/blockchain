/**
 * show-wallet.ts
 *
 * Muestra la dirección de la multisig wallet configurada en blockchain/.env,
 * junto con los links de los faucets para cargarla de fondos.
 *
 * Uso:
 *   npx ts-node scripts/init-sepolia-contracts/show-wallet.ts
 */

import * as fs from "fs";
import * as path from "path";

function readEnvVar(filePath: string, key: string): string | null {
  if (!fs.existsSync(filePath)) return null;
  const content = fs.readFileSync(filePath, "utf8");
  const match = content.match(new RegExp(`^${key}=(.+)$`, "m"));
  return match ? match[1].trim() : null;
}

function main() {
  const blockchainRoot = path.resolve(__dirname, "..", "..");
  const envPath = path.join(blockchainRoot, ".env");

  const address = readEnvVar(envPath, "ADMIN_MULTISIG_ADDRESS");

  if (!address) {
    console.error("❌ No se encontró ADMIN_MULTISIG_ADDRESS en blockchain/.env");
    console.error("   ¿Ya ejecutaste el script setup-sepolia.ts?");
    process.exit(1);
  }

  console.log("\n")
  console.log("╔══════════════════════════════════════════════════════════════════════════════════════╗");
  console.log("║                              VOTAR - MULTISIG WALLET                                 ║");
  console.log("╠══════════════════════════════════════════════════════════════════════════════════════╣");
  console.log("║                                                                                      ║");
  console.log("║  ► Dirección:                                                                        ║");
  console.log(`║  ${address}                                          ║`);
  console.log("║                                                                                      ║");
  console.log("╠══════════════════════════════════════════════════════════════════════════════════════╣");
  console.log("║   Recordá mantener la wallet cargada. Podés usar:                                    ║");
  console.log("║                                                                                      ║");
  console.log("║  • Google (0.05 ETH cada 24hs):                                                      ║");
  console.log("║  https://cloud.google.com/application/web3/faucet/ethereum/sepolia                   ║");
  console.log("║                                                                                      ║");
  console.log("║  • Nyan Cat (Miná ~0.05 ETH cada 1 minuto):                                          ║");
  console.log("║  https://sepolia-faucet.pk910.de/                                                    ║");
  console.log("║                                                                                      ║");
  console.log("║                                                                                      ║");
  console.log("║  ► Revisá tus fondos en:                                                             ║");
  console.log(`║  https://sepolia.etherscan.io/address/${address}     ║`);
  console.log("║                                                                                      ║");
  console.log("╚══════════════════════════════════════════════════════════════════════════════════════╝\n");
}

main();
