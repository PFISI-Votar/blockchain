/**
 * setup-sepolia.ts
 *
 * Script principal de inicialización para Sepolia testnet.
 *
 * Uso:
 *   npx ts-node scripts/init-sepolia-contracts/setup-sepolia.ts <ALCHEMY_SEPOLIA_URL>
 *
 * Ejemplo:
 *   npx ts-node scripts/init-sepolia-contracts/setup-sepolia.ts https://eth-sepolia.g.alchemy.com/v2/alch_XXXX
 *
 * Qué hace:
 *   1. Valida la URL de Alchemy (debe contener "eth-sepolia").
 *   2. Genera una wallet aleatoria (address + privateKey).
 *   3. Escribe las variables en blockchain/.env.
 *   4. Si back/.env no existe, lo copia desde back/.env.example. Luego escribe las variables.
 *   5. Si front/.env no existe, lo copia desde front/.env.example. Luego escribe las variables.
 *   6. Ejecuta deploy-sepolia-stack.ts --network sepolia y parsea las addresses resultantes.
 *   7. Escribe MERKLE_ROOT_STORE_ADDRESS y ELECTION_FACTORY_ADDRESS en back/.env y front/.env.
 *   8. Ejecuta los scripts de grant.
 *   9. Muestra la dirección de la multisig wallet y los links de los faucets.
 */

import { execSync, spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { ethers } from "ethers";

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Devuelve la ruta absoluta a una carpeta hermana del repo blockchain. */
function siblingRepo(name: string): string {
  // __dirname apunta a blockchain/scripts/init-sepolia-contracts
  const blockchainRoot = path.resolve(__dirname, "..", "..");
  return path.resolve(blockchainRoot, "..", name);
}

/** Lee un .env como texto y lo devuelve como Map<key, lineIndex> + líneas originales. */
function readEnv(filePath: string): { lines: string[]; map: Map<string, number> } {
  const content = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
  const lines = content.split("\n");
  const map = new Map<string, number>();
  lines.forEach((line, i) => {
    const match = line.match(/^([A-Z0-9_]+)\s*=/);
    if (match) map.set(match[1], i);
  });
  return { lines, map };
}

/**
 * Escribe (o agrega) un conjunto de variables en un archivo .env.
 * No toca ninguna otra línea existente.
 */
function writeEnvVars(filePath: string, vars: Record<string, string>): void {
  const { lines, map } = readEnv(filePath);

  for (const [key, value] of Object.entries(vars)) {
    const newLine = `${key}=${value}`;
    if (map.has(key)) {
      lines[map.get(key)!] = newLine;
    } else {
      // Agregar al final (con salto de línea si el archivo no termina en uno)
      if (lines.length > 0 && lines[lines.length - 1] !== "") {
        lines.push("");
      }
      lines.push(newLine);
      map.set(key, lines.length - 1);
    }
  }

  fs.writeFileSync(filePath, lines.join("\n"), "utf8");
}

/**
 * Si el .env no existe, intenta copiarlo desde .env.example.
 * Si tampoco existe el .env.example, crea un .env vacío.
 */
function ensureEnvExists(envPath: string): void {
  if (fs.existsSync(envPath)) return;

  const examplePath = envPath + ".example";
  if (fs.existsSync(examplePath)) {
    fs.copyFileSync(examplePath, envPath);
    console.log(`  📋 Creado ${envPath} desde .env.example`);
  } else {
    fs.writeFileSync(envPath, "", "utf8");
    console.log(`  📋 Creado ${envPath} vacío (no se encontró .env.example)`);
  }
}

/**
 * Ejecuta un comando de shell mostrando su output en tiempo real.
 * Lanza un error si el proceso termina con código distinto de 0.
 */
function run(cmd: string, cwd?: string): void {
  console.log(`\n  ▶ ${cmd}${cwd ? ` (en ${cwd})` : ""}`);
  const result = spawnSync(cmd, {
    cwd,
    shell: true,
    stdio: "inherit",
    env: { ...process.env },
  });
  if (result.status !== 0) {
    throw new Error(`Comando falló con código ${result.status}: ${cmd}`);
  }
}

/**
 * Ejecuta un comando y captura su stdout+stderr como string.
 */
function runCapture(cmd: string, cwd?: string): string {
  return execSync(cmd, {
    cwd,
    shell: true,
    env: { ...process.env },
    encoding: "utf8",
  });
}

/** Parsea las addresses del output de deploy-sepolia-stack.ts */
function parseDeployOutput(output: string): {
  merkleRootStore: string;
  electionFactory: string;
} {
  const merkleMatch = output.match(/Set MERKLE_ROOT_STORE_ADDRESS=(0x[0-9a-fA-F]{40})/);
  const factoryMatch = output.match(/Set ELECTION_FACTORY_ADDRESS=(0x[0-9a-fA-F]{40})/);

  if (!merkleMatch) throw new Error("No se pudo parsear MERKLE_ROOT_STORE_ADDRESS del output del deploy.");
  if (!factoryMatch) throw new Error("No se pudo parsear ELECTION_FACTORY_ADDRESS del output del deploy.");

  return {
    merkleRootStore: merkleMatch[1],
    electionFactory: factoryMatch[1],
  };
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log("\n╔══════════════════════════════════════════════════════╗");
  console.log("║          VOTAR — Inicialización Sepolia Testnet      ║");
  console.log("╚══════════════════════════════════════════════════════╝\n");

  // 1. Validar argumento
  const alchemyUrl = process.argv[2];
  if (!alchemyUrl) {
    console.error("❌ Uso: npx ts-node scripts/init-sepolia-contracts/setup-sepolia.ts <ALCHEMY_SEPOLIA_URL>");
    console.error("   Ejemplo: npx ts-node scripts/init-sepolia-contracts/setup-sepolia.ts https://eth-sepolia.g.alchemy.com/v2/alch_XXXX");
    process.exit(1);
  }

  if (!alchemyUrl.includes("eth-sepolia")) {
    console.error("❌ La URL no parece ser de Sepolia. Asegurate de que contenga 'eth-sepolia'.");
    console.error("   URL recibida:", alchemyUrl);
    console.error("   Revisá el Paso 4 del README: cambiá el network a 'Ethereum Sepolia' en tu app de Alchemy.");
    process.exit(1);
  }

  console.log("✅ URL de Alchemy validada:", alchemyUrl);

  // 2. Generar wallet
  console.log("\n── Paso 1: Generando wallet ──────────────────────────");
  const wallet = ethers.Wallet.createRandom();
  const address = wallet.address;
  const privateKey = wallet.privateKey;
  console.log("  Address:    ", address);
  console.log("  Private key:", privateKey);

  // 3. Rutas de los repos
  const blockchainRoot = path.resolve(__dirname, "..", "..");
  const backRoot = siblingRepo("back");
  const frontRoot = siblingRepo("front");

  // Verificar que los repos hermanos existen
  for (const [name, repoPath] of [["back", backRoot], ["front", frontRoot]] as [string, string][]) {
    if (!fs.existsSync(repoPath)) {
      console.error(`\n❌ No se encontró el repositorio '${name}' en: ${repoPath}`);
      console.error("   Asegurate de que los tres repos (back, blockchain, front) estén en la misma carpeta raíz.");
      process.exit(1);
    }
  }

  // 4. Escribir .env de blockchain
  console.log("\n── Paso 2: Configurando blockchain/.env ──────────────");
  const blockchainEnv = path.join(blockchainRoot, ".env");
  ensureEnvExists(blockchainEnv);
  writeEnvVars(blockchainEnv, {
    SEPOLIA_RPC_URL: alchemyUrl,
    PRIVATE_KEY: privateKey,
    ADMIN_MULTISIG_ADDRESS: address,
    GRANT_TARGET: address,
  });
  console.log("  ✅ blockchain/.env actualizado.");

  // 5. Escribir .env de back
  console.log("\n── Paso 3: Configurando back/.env ────────────────────");
  const backEnv = path.join(backRoot, ".env");
  ensureEnvExists(backEnv);
  writeEnvVars(backEnv, {
    SEPOLIA_RPC_URL: alchemyUrl,
    MERKLE_UPDATER_PRIVATE_KEY: privateKey,
    ELECTION_ADMIN_PRIVATE_KEY: privateKey,
    AUDIT_VIEW_ADDRESS: address,
    RECIBO_SIGNING_PRIVATE_KEY: address,
  });
  console.log("  ✅ back/.env actualizado.");

  // 6. Escribir .env de front
  console.log("\n── Paso 4: Configurando front/.env ───────────────────");
  const frontEnv = path.join(frontRoot, ".env");
  ensureEnvExists(frontEnv);
  writeEnvVars(frontEnv, {
    VITE_RPC_URL: alchemyUrl,
    VITE_CHAIN_ID: "11155111",
    VITE_VOTE_TRANSMITTER_PRIVATE_KEY: privateKey,
    VITE_AUDIT_VIEW_ADDRESS: address,
  });
  console.log("  ✅ front/.env actualizado.");

  // 7. Deploy
  console.log("\n── Paso 5: Ejecutando deploy-sepolia-stack.ts ─────────");
  console.log("  (Esto puede tardar varios minutos según la red)\n");

  let deployOutput: string;
  try {
    deployOutput = runCapture(
      "npx hardhat run scripts/deploy-sepolia-stack.ts --network sepolia",
      blockchainRoot
    );
  } catch (err: any) {
    // execSync lanza si el proceso falla; el output está en err.stdout/stderr
    console.error("\n❌ El deploy falló:");
    console.error(err.stdout ?? "");
    console.error(err.stderr ?? "");
    process.exit(1);
  }

  // Mostrar el output del deploy en consola igual que si lo hubiéramos corrido directo
  process.stdout.write(deployOutput);

  // 8. Parsear addresses del output
  console.log("\n── Paso 6: Parseando addresses del deploy ─────────────");
  let merkleRootStore: string;
  let electionFactory: string;

  try {
    ({ merkleRootStore, electionFactory } = parseDeployOutput(deployOutput));
  } catch (err: any) {
    console.error("❌", err.message);
    console.error("   Output del deploy:");
    console.error(deployOutput);
    process.exit(1);
  }

  console.log("  MERKLE_ROOT_STORE_ADDRESS:", merkleRootStore);
  console.log("  ELECTION_FACTORY_ADDRESS: ", electionFactory);

  // 9. Escribir addresses en back/.env y front/.env
  console.log("\n── Paso 7: Escribiendo addresses en back y front ──────");
  writeEnvVars(backEnv, {
    MERKLE_ROOT_STORE_ADDRESS: merkleRootStore,
    ELECTION_FACTORY_ADDRESS: electionFactory,
  });
  writeEnvVars(frontEnv, {
    // El front normalmente no necesita estas, pero las dejamos por si el .env.example las tiene
    // Si no estaban en el template, simplemente se agregan al final y no molestan.
  });
  console.log("  ✅ back/.env actualizado con addresses del deploy.");

  // 10. Scripts de grant
  console.log("\n── Paso 8: Ejecutando scripts de grant ────────────────");
  run("npx hardhat run scripts/grant-election-admin-local.ts --network sepolia", blockchainRoot);
  run("npx hardhat run scripts/grant-roles-dev.ts --network sepolia", blockchainRoot);
  console.log("  ✅ Grants ejecutados.");

  // 11. sync:election-factory en back
  console.log("\n── Paso 9: Sincronizando ElectionFactory en backend ───");
  run("npm run sync:election-factory", backRoot);
  console.log("  ✅ Sync completado.");

  // 12. Resumen final
  console.log("\n╔══════════════════════════════════════════════════════╗");
  console.log("║               ✅  Setup completado                   ║");
  console.log("╠══════════════════════════════════════════════════════╣");
  console.log("║                                                      ║");
  console.log("║  MULTISIG WALLET ADDRESS:                            ║");
  console.log(`║  ${address}  ║`);
  console.log("║                                                      ║");
  console.log("╠══════════════════════════════════════════════════════╣");
  console.log("║  ⚠️  NECESITÁS FONDOS EN ESA DIRECCIÓN PARA OPERAR  ║");
  console.log("║                                                      ║");
  console.log("║  Conseguí ETH de prueba en alguno de estos faucets:  ║");
  console.log("║                                                      ║");
  console.log("║  🔵 Google (0.05 ETH / 24hs):                       ║");
  console.log("║  https://cloud.google.com/application/web3/faucet/  ║");
  console.log("║          ethereum/sepolia                            ║");
  console.log("║                                                      ║");
  console.log("║  🐱 Nyan Cat (~0.05 ETH / 10 min minando):          ║");
  console.log("║  https://sepolia-faucet.pk910.de/                   ║");
  console.log("║                                                      ║");
  console.log("║  Copiá la dirección de arriba en cualquiera de      ║");
  console.log("║  los dos links para recibir los fondos.             ║");
  console.log("╚══════════════════════════════════════════════════════╝\n");

  // También mostrar la dirección sola al final para fácil copiado
  console.log("📋 Dirección para copiar en el faucet:");
  console.log(`   ${address}\n`);
}

main().catch((err) => {
  console.error("\n❌ Error inesperado:", err.message ?? err);
  process.exit(1);
});
