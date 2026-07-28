import { ethers } from 'hardhat'

/**
 * Republish Merkle root after Hardhat restart (ephemeral chain state).
 *
 * Usage:
 *   npx hardhat run scripts/republish-merkle-root.ts --network localhost \
 *     --election-id 2 \
 *     --merkle-root 0x... \
 *     --store-address 0x...
 *
 * Or via env:
 *   ELECTION_ID=2 MERKLE_ROOT=0x... MERKLE_ROOT_STORE_ADDRESS=0x... npx hardhat run ...
 *
 * Note: Hardhat's `run` does not forward unknown CLI flags to the script.
 * Prefer environment variables for parameters.
 */
async function main() {
  const electionId = Number(process.env.ELECTION_ID ?? '0')
  const merkleRoot = process.env.MERKLE_ROOT
  const merkleRootStoreAddress =
    process.env.MERKLE_ROOT_STORE_ADDRESS ??
    process.env.MERKLE_STORE_ADDRESS

  if (!Number.isFinite(electionId) || electionId <= 0) {
    throw new Error(
      'Set ELECTION_ID to a positive election id (e.g. ELECTION_ID=2).',
    )
  }
  if (!merkleRoot || !/^0x[0-9a-fA-F]{64}$/.test(merkleRoot)) {
    throw new Error(
      'Set MERKLE_ROOT to a bytes32 hex value (0x + 64 hex chars).',
    )
  }
  if (
    !merkleRootStoreAddress ||
    !/^0x[0-9a-fA-F]{40}$/.test(merkleRootStoreAddress)
  ) {
    throw new Error(
      'Set MERKLE_ROOT_STORE_ADDRESS to the deployed MerkleRootStore address.',
    )
  }

  console.log(`Publishing Merkle root for election ${electionId}`)
  console.log(`Merkle root: ${merkleRoot}`)
  console.log(`Store: ${merkleRootStoreAddress}`)

  const [, merkleUpdater] = await ethers.getSigners()
  console.log(`Using merkle updater: ${merkleUpdater.address}`)

  const MerkleRootStore = await ethers.getContractAt(
    'MerkleRootStore',
    merkleRootStoreAddress,
    merkleUpdater,
  )

  const tx = await MerkleRootStore.publishRoot(electionId, merkleRoot)
  console.log(`Transaction sent: ${tx.hash}`)

  const receipt = await tx.wait()
  console.log(`Transaction mined in block ${receipt?.blockNumber}`)
  console.log('Merkle root published successfully')

  const [root, timestamp] = await MerkleRootStore.getMerkleRoot(electionId)
  console.log(`Verification:`)
  console.log(`  Published root: ${root}`)
  console.log(`  Timestamp: ${timestamp}`)
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
