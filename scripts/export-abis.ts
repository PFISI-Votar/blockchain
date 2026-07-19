/**
 * VOTAR-385 — Export compiled ABIs to NestJS and Vite directories without deploying.
 *
 * Usage:
 *   npx hardhat run scripts/export-abis.ts
 *   ABI_EXPORT_BACK_DIR=/path SKIP_ABI_EXPORT_FRONT=true npx hardhat run scripts/export-abis.ts
 */
import { exportAbisToConsumers } from "./lib/export-abis";

async function main() {
  const result = await exportAbisToConsumers();
  if (result.back.length === 0 && result.front.length === 0) {
    console.warn(
      "[export-abis] No files written. Check ABI_EXPORT_*_DIR paths or SKIP_ABI_EXPORT_* flags.",
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
