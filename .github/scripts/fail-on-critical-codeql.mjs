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

function ingestRules(rules, scores) {
  for (const rule of rules ?? []) {
    if (!rule?.id) continue
    const raw = rule.properties?.['security-severity']
    const score = raw == null || raw === '' ? null : Number(raw)
    scores.set(rule.id, Number.isFinite(score) ? score : null)
  }
}

/** Build ruleId → security-severity maps from driver and query-pack extensions. */
function buildScoreIndexes(run) {
  const driverScores = new Map()
  ingestRules(run.tool?.driver?.rules, driverScores)

  const extensionScores = (run.tool?.extensions ?? []).map((ext) => {
    const scores = new Map()
    ingestRules(ext.rules, scores)
    return scores
  })

  // Flat fallback: driver first, then extensions (query-pack rules win on conflict).
  const flatScores = new Map(driverScores)
  for (const scores of extensionScores) {
    for (const [id, score] of scores) {
      flatScores.set(id, score)
    }
  }

  return { driverScores, extensionScores, flatScores }
}

function resolveScore(result, indexes) {
  const ruleId = result.ruleId ?? result.rule?.id ?? 'unknown'
  const extIndex = result.rule?.toolComponent?.index

  if (typeof extIndex === 'number') {
    const fromExt = indexes.extensionScores[extIndex]?.get(ruleId)
    if (fromExt != null) return { ruleId, score: fromExt }
  }

  // No toolComponent → driver; otherwise fall back across all components.
  if (result.rule?.toolComponent == null) {
    const fromDriver = indexes.driverScores.get(ruleId)
    if (fromDriver != null) return { ruleId, score: fromDriver }
  }

  return { ruleId, score: indexes.flatScores.get(ruleId) ?? null }
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
    const indexes = buildScoreIndexes(run)

    for (const result of run.results ?? []) {
      const { ruleId, score } = resolveScore(result, indexes)
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
