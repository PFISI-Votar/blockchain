#!/usr/bin/env node
/**
 * Imprime SHA-256(JSON.stringify(abi)) de los artefactos compilados.
 * Mismo algoritmo que scripts/lib/export-abis.ts (VOTAR-383 / UAT Sepolia).
 */
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const artifactsDir = fileURLToPath(new URL('../artifacts/contracts', import.meta.url))

const walk = (dir, found = []) => {
  if (!existsSync(dir)) return found
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) walk(path, found)
    else if (name.endsWith('.json') && !name.endsWith('.dbg.json')) found.push(path)
  }
  return found
}

const files = walk(artifactsDir)
if (files.length === 0) {
  console.error('No hay artefactos. Corré `npm run compile` primero.')
  process.exit(1)
}

const wanted = new Set([
  'MerkleRootStore',
  'ElectionFactory',
  'BallotContract',
  'VoteRegistry',
  'AuditViewContract',
])

for (const file of files.sort()) {
  const artifact = JSON.parse(readFileSync(file, 'utf8'))
  if (!wanted.has(artifact.contractName) || !Array.isArray(artifact.abi)) continue
  const abiHash = `0x${createHash('sha256').update(JSON.stringify(artifact.abi)).digest('hex')}`
  console.log(`${artifact.contractName} ${abiHash}`)
}
