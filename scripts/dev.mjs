#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { waitForTcp } from './lib/wait-for-tcp.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const blockchainRoot = resolve(__dirname, '..');

const HARDHAT_RPC_HOST = '127.0.0.1';
const HARDHAT_RPC_PORT = 8545;

const logStep = (message) => {
  console.log(`\n[blockchain] ${message}`);
};

const runCommand = (command, args) =>
  new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: blockchainRoot,
      stdio: 'inherit',
      shell: false,
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      reject(
        new Error(
          `${command} ${args.join(' ')} falló con código de salida ${code}`,
        ),
      );
    });
  });

const startHardhatNode = () => {
  logStep(`Iniciando Hardhat node en ${HARDHAT_RPC_HOST}:${HARDHAT_RPC_PORT}...`);
  const child = spawn('npx', ['hardhat', 'node'], {
    cwd: blockchainRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
  });

  child.stdout.on('data', (chunk) => {
    process.stdout.write(`[hardhat] ${chunk}`);
  });
  child.stderr.on('data', (chunk) => {
    process.stderr.write(`[hardhat] ${chunk}`);
  });

  return child;
};

const logReady = () => {
  console.log('\n[blockchain] Entorno local listo');
  console.log(`[blockchain]   RPC:     http://${HARDHAT_RPC_HOST}:${HARDHAT_RPC_PORT}`);
  console.log(
    '[blockchain]   Backend: variables escritas en ../back/.env.blockchain.local',
  );
  console.log(
    '[blockchain]   Siguiente paso: en otra terminal, corré npm run dev en back/',
  );
  console.log('[blockchain] Presioná Ctrl+C para detener Hardhat node\n');
};

const main = async () => {
  let hardhatProcess;
  let isShuttingDown = false;

  const shutdown = (signal) => {
    if (isShuttingDown) {
      return;
    }
    isShuttingDown = true;
    console.log(`\n[blockchain] Deteniendo (${signal})...`);
    if (hardhatProcess && !hardhatProcess.killed) {
      hardhatProcess.kill('SIGTERM');
    }
    setTimeout(() => process.exit(0), 500);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  try {
    logStep('Compilando contratos...');
    await runCommand('npx', ['hardhat', 'compile']);

    hardhatProcess = startHardhatNode();

    hardhatProcess.on('exit', (code) => {
      if (!isShuttingDown && code !== 0 && code !== null) {
        console.error(
          `[blockchain] Hardhat node terminó inesperadamente (${code})`,
        );
        process.exit(code);
      }
    });

    await waitForTcp(HARDHAT_RPC_HOST, HARDHAT_RPC_PORT);

    logStep('Desplegando contratos y configurando roles...');
    await runCommand('npm', ['run', 'deploy:local']);

    logReady();
  } catch (error) {
    console.error(`[blockchain] Error: ${error.message}`);
    shutdown('error');
    process.exit(1);
  }
};

main();
