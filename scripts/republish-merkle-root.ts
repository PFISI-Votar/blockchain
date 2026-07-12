import { ethers } from 'hardhat'

async function main() {
  const electionId = 2
  const merkleRoot = '0x8cadaf0f1cadaa1e1ca6c794557f48588528d6f7e651f04dd69eb6076732a11b'

  console.log(`Publishing Merkle root for election ${electionId}`)
  console.log(`Merkle root: ${merkleRoot}`)

  // Get account #1 (MERKLE_UPDATER_ROLE holder)
  const [, merkleUpdater] = await ethers.getSigners()
  console.log(`Using merkle updater: ${merkleUpdater.address}`)

  // Get the MerkleRootStore contract
  const merkleRootStoreAddress = '0x5FbDB2315678afecb367f032d93F642f64180aa3'
  const MerkleRootStore = await ethers.getContractAt('MerkleRootStore', merkleRootStoreAddress, merkleUpdater)

  // Publish the root
  const tx = await MerkleRootStore.publishRoot(electionId, merkleRoot)
  console.log(`Transaction sent: ${tx.hash}`)

  const receipt = await tx.wait()
  console.log(`Transaction mined in block ${receipt.blockNumber}`)
  console.log('✅ Merkle root published successfully!')

  // Verify
  const [root, timestamp] = await MerkleRootStore.getMerkleRoot(electionId)
  console.log(`\nVerification:`)
  console.log(`  Published root: ${root}`)
  console.log(`  Timestamp: ${timestamp}`)
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
