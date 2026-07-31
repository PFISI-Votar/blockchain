/**
 * inspect-election.ts
 *
 * Dado un Election ID, consulta al contrato ElectionFactory en Sepolia
 * y muestra las direcciones de Ballot, VoteRegistry y AuditView del comicio.
 *
 * Prerequisito: tener al menos un comicio creado y oficializado en la app.
 *
 * Uso:
 *   npx ts-node scripts/init-sepolia-contracts/inspect-election.ts <ELECTION_ID>
 *
 * Ejemplo:
 *   npx ts-node scripts/init-sepolia-contracts/inspect-election.ts 2
 */

import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
import { ethers } from "ethers";

// ─── Helpers ────────────────────────────────────────────────────────────────

function readEnvVar(filePath: string, key: string): string | null {
  if (!fs.existsSync(filePath)) return null;
  const content = fs.readFileSync(filePath, "utf8");
  const match = content.match(new RegExp(`^${key}=(.+)$`, "m"));
  return match ? match[1].trim() : null;
}

function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// ABI mínimo para llamar getElection(uint256)
// Devuelve (address ballot, address voteRegistry, address auditView, tuple config, bool active)
const ELECTION_FACTORY_ABI = [
  "function getElection(uint256 electionId) view returns (address ballot, address voteRegistry, address auditView, tuple(bool initialized, uint256 candidateCount, uint256 voterCount, uint256 voteCount) config, bool active)",
];

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log("\n╔══════════════════════════════════════════════════════╗");
  console.log("║         VOTAR — Inspección de contratos              ║");
  console.log("╚══════════════════════════════════════════════════════╝\n");

  // Leer .env de blockchain para obtener SEPOLIA_RPC_URL
  const blockchainRoot = path.resolve(__dirname, "..", "..");
  const blockchainEnv = path.join(blockchainRoot, ".env");

  const rpcUrl = readEnvVar(blockchainEnv, "SEPOLIA_RPC_URL");
  if (!rpcUrl) {
    console.error("❌ No se encontró SEPOLIA_RPC_URL en blockchain/.env");
    console.error("   ¿Ya ejecutaste setup-sepolia.ts?");
    process.exit(1);
  }

  // Leer .env de back para obtener ELECTION_FACTORY_ADDRESS
  const backRoot = path.resolve(blockchainRoot, "..", "back");
  const backEnv = path.join(backRoot, ".env");
  let factoryAddressFromEnv = readEnvVar(backEnv, "ELECTION_FACTORY_ADDRESS");

  // Instrucciones previas
  console.log("  Prerequisito: debés tener al menos un comicio creado y oficializado");
  console.log("  en la app antes de continuar.\n");

  // Pedir ELECTION_FACTORY_ADDRESS (mostrando el del .env como sugerencia)
  let factoryAddress: string;
  if (factoryAddressFromEnv) {
    console.log(`  Se detectó ELECTION_FACTORY_ADDRESS en back/.env: ${factoryAddressFromEnv}`);
    const useEnv = await prompt("  ¿Usarlo? (Enter para confirmar, o escribí otra dirección): ");
    factoryAddress = useEnv === "" ? factoryAddressFromEnv : useEnv;
  } else {
    factoryAddress = await prompt("  Ingresá el ELECTION_FACTORY_ADDRESS del back/.env: ");
  }

  if (!ethers.isAddress(factoryAddress)) {
    console.error("❌ La dirección ingresada no es válida:", factoryAddress);
    process.exit(1);
  }

  // Pedir Election ID
  let electionIdArg = process.argv[2];
  let electionId: number;

  if (electionIdArg) {
    electionId = parseInt(electionIdArg, 10);
    if (isNaN(electionId) || electionId < 0) {
      console.error("❌ El Election ID debe ser un número entero positivo. Recibido:", electionIdArg);
      process.exit(1);
    }
  } else {
    const idInput = await prompt("\n  Ingresá el ID del comicio a inspeccionar: ");
    electionId = parseInt(idInput, 10);
    if (isNaN(electionId) || electionId < 0) {
      console.error("❌ ID inválido:", idInput);
      process.exit(1);
    }
  }

  // Conectar a Sepolia y consultar
  console.log(`\n  Consultando ElectionFactory en ${factoryAddress}...`);
  console.log(`  Comicio ID: ${electionId}\n`);

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const factory = new ethers.Contract(factoryAddress, ELECTION_FACTORY_ABI, provider);

  let result: any;
  try {
    result = await factory.getElection(electionId);
  } catch (err: any) {
    console.error("❌ Error al consultar el contrato:");
    console.error("  ", err.message ?? err);
    console.error("\n  Verificá que:");
    console.error("   - El comicio con ese ID exista y esté oficializado.");
    console.error("   - La dirección de ElectionFactory sea correcta.");
    console.error("   - Tu app de Alchemy esté activa y con fondos en la wallet.");
    process.exit(1);
  }

  // result[0] = ballot, result[1] = voteRegistry, result[2] = auditView
  const ballot = result[0] ?? result.ballot;
  const voteRegistry = result[1] ?? result.voteRegistry;
  const auditView = result[2] ?? result.auditView;

  console.log("╔══════════════════════════════════════════════════════╗");
  console.log(`║         Comicio ID: ${String(electionId).padEnd(33)}║`);
  console.log("╠══════════════════════════════════════════════════════╣");
  console.log("║                                                      ║");
  console.log(`║  Ballot:        ${ballot}  ║`);
  console.log(`║  VoteRegistry:  ${voteRegistry}  ║`);
  console.log(`║  AuditView:     ${auditView}  ║`);
  console.log("║                                                      ║");
  console.log("╚══════════════════════════════════════════════════════╝\n");

  // Links a Etherscan
  const base = "https://sepolia.etherscan.io/address";
  console.log("  🔗 Ver en Etherscan:");
  console.log(`     Ballot:        ${base}/${ballot}`);
  console.log(`     VoteRegistry:  ${base}/${voteRegistry}`);
  console.log(`     AuditView:     ${base}/${auditView}\n`);
}

main().catch((err) => {
  console.error("\n❌ Error inesperado:", err.message ?? err);
  process.exit(1);
});
