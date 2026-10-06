#!/usr/bin/env node
/**
 * VOTAR-383 — rechaza dependencias con licencia no libre.
 *
 * Lee `package-lock.json` (lockfile npm v2/v3). Si una dependencia no declara
 * SPDX, inspecciona el archivo LICENSE en `node_modules` (hace falta `npm ci`).
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const modulesRoot = process.env.OSS_MODULES_ROOT || root
const requiredFiles = ['LICENSE', 'README.md', 'CONTRIBUTING.md', 'SECURITY.md']

const denied = [
  /^unlicensed$/,
  /proprietary/,
  /commercial/,
  /^busl/,
  /^sspl/,
  /^elastic-2\.0$/,
  /commons-clause/,
  /cc-by-nc/,
  /cc-by-nd/,
  /non-commercial/,
]

const allowed = [
  /^mit(-0)?$/,
  /^isc$/,
  /^bsd-[23]-clause$/,
  /^0bsd$/,
  /^apache-2\.0$/,
  /^unlicense$/,
  /^cc0-1\.0$/,
  /^cc-by-[34]\.0$/,
  /^mpl-2\.0$/,
  /^lgpl-(2\.1|3\.0)/,
  /^gpl-(2\.0|3\.0)/,
  /^agpl-3\.0/,
  /^ofl-1\.1$/,
  /^blueoak-1\.0\.0$/,
  /^python-2\.0$/,
  /^psf-2\.0$/,
  /^artistic-2\.0$/,
  /^zlib$/,
  /^wtfpl$/,
  /^public domain$/,
  /^hpnd$/,
  /^unicode-dfs-2016$/,
  /^bsl-1\.0$/,
]

const isDenied = (term) => denied.some((pattern) => pattern.test(term))
const isAllowed = (term) => allowed.some((pattern) => pattern.test(term))

const normalize = (value) =>
  String(value)
    .replace(/[()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()

/** Una expresión SPDX es aceptable si alguna alternativa OR es totalmente libre. */
const expressionIsFree = (raw) => {
  const alternatives = normalize(raw).split(/\s+or\s+/)
  return alternatives.some((alternative) => {
    const terms = alternative.split(/\s+and\s+/).map((term) => term.trim())
    return terms.length > 0 && terms.every((term) => term && isAllowed(term) && !isDenied(term))
  })
}

const licenseFromFiles = (packageDir) => {
  if (!existsSync(packageDir)) return null
  const names = readdirSync(packageDir).filter((name) =>
    /^(license|licence|copying|readme)/i.test(name)
  )
  const text = names.map((name) => readFileSync(join(packageDir, name), 'utf8')).join('\n')
  if (/permission is hereby granted/i.test(text)) return 'MIT'
  if (/redistribution and use in source and binary forms/i.test(text)) return 'BSD-3-Clause'
  if (/apache license/i.test(text)) return 'Apache-2.0'
  if (/gnu lesser general public license/i.test(text)) return 'LGPL-3.0'
  if (/gnu general public license/i.test(text)) return 'GPL-3.0'
  if (/public domain/i.test(text)) return 'Public Domain'
  if (/psf license agreement/i.test(text)) return 'PSF-2.0'
  return null
}

const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'))
const packages = lock.packages ?? {}
const blocked = []
const unresolved = []
let scanned = 0

for (const [key, meta] of Object.entries(packages)) {
  if (!key || key === '') continue
  scanned += 1
  const declared = meta.license
  const raw = Array.isArray(declared)
    ? declared.map((item) => (typeof item === 'string' ? item : item.type)).join(' OR ')
    : declared

  if (raw && expressionIsFree(raw)) continue

  if (!raw) {
    const inferred = licenseFromFiles(join(modulesRoot, key))
    if (inferred && expressionIsFree(inferred)) continue
    unresolved.push(key)
    continue
  }

  blocked.push(`${key} (${raw})`)
}

const missingFiles = requiredFiles.filter((file) => !existsSync(join(root, file)))

console.log(`Dependencias inspeccionadas: ${scanned}`)
console.log(`Licencias no libres: ${blocked.length}`)
console.log(`Sin metadato de licencia resoluble: ${unresolved.length}`)

if (missingFiles.length || blocked.length || unresolved.length) {
  if (missingFiles.length) {
    console.error('Faltan archivos regulatorios:', missingFiles.join(', '))
  }
  for (const item of blocked) console.error(`NO LIBRE: ${item}`)
  for (const item of unresolved) {
    console.error(`SIN LICENCIA: ${item} (corré npm ci si falta node_modules)`)
  }
  process.exit(1)
}

console.log('OK: stack 100% open source / free (sin licencias propietarias).')
