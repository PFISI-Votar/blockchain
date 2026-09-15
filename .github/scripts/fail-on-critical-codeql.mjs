import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const CRITICAL_MIN = 9
const resultsDir = process.argv[2]

if (!resultsDir) {
  console.error('Usage: fail-on-critical-codeql.mjs <sarif-dir>')
  process.exit(2)
}

function collectSarif(dir, acc = []) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) {
      collectSarif(path, acc)
    } else if (entry.endsWith('.sarif')) {
      acc.push(path)
    }
  }
  return acc
}

let files
try {
  files = collectSarif(resultsDir)
} catch (error) {
  console.error(`Cannot read CodeQL results at ${resultsDir}: ${error.message}`)
  process.exit(1)
}

if (files.length === 0) {
  console.error(`No SARIF results in ${resultsDir}`)
  process.exit(1)
}

const findings = []

for (const file of files) {
  const sarif = JSON.parse(readFileSync(file, 'utf8'))
  for (const run of sarif.runs ?? []) {
    const scores = new Map()
    for (const rule of run.tool?.driver?.rules ?? []) {
      const raw = rule.properties?.['security-severity']
      const score = raw == null || raw === '' ? null : Number(raw)
      scores.set(rule.id, Number.isFinite(score) ? score : null)
    }

    for (const result of run.results ?? []) {
      const ruleId = result.ruleId ?? result.rule?.id ?? 'unknown'
      const score = scores.get(ruleId) ?? null
      if (score == null || score < CRITICAL_MIN) continue

      const uri =
        result.locations?.[0]?.physicalLocation?.artifactLocation?.uri ??
        '(unknown)'
      findings.push({
        ruleId,
        score,
        uri,
        message: result.message?.text ?? '',
      })
    }
  }
}

if (findings.length === 0) {
  console.log('No critical CodeQL findings (security-severity >= 9.0).')
  process.exit(0)
}

console.error(`Critical CodeQL findings (${findings.length}):`)
for (const finding of findings) {
  console.error(
    `- ${finding.ruleId} severity=${finding.score} ${finding.uri}: ${finding.message}`,
  )
}
process.exit(1)
