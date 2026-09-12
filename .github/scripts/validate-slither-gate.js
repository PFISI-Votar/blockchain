#!/usr/bin/env node
/**
 * VOTAR-495 — Guard contra debilitamiento silencioso del quality gate de Slither.
 *
 * Corre ANTES del análisis de Slither en CI y falla de forma determinística si
 * slither.config.json ya no cumple el umbral aceptado para Sprint 7
 * (docs/VOTAR-351-auditoria-smart-contracts.md §7). Sin este guard, bajar
 * `fail_on` a "high"/"none" o vaciar `filter_paths`/`detectors_to_exclude`
 * pasaría desapercibido en la revisión de un PR y generaría falsos negativos
 * (el job `slither` seguiría en verde con hallazgos Media/Alta/Crítica sin
 * triage).
 */
const fs = require("fs");
const path = require("path");

const CONFIG_PATH = path.join(process.cwd(), "slither.config.json");

// Umbral aceptado Sprint 7: Media/Alta/Crítica deben bloquear el merge.
// "high" deja pasar Medium sin triage; "none" desactiva el gate por completo.
const ACCEPTED_FAIL_ON = new Set(["medium", "low", "pedantic"]);

// Exclusiones de detector aprobadas explícitamente (ver doc §3.2). Vacío por
// defecto: hoy no hay ninguna exclusión documentada, así que cualquier valor
// en `detectors_to_exclude` debe agregarse acá en el mismo PR que lo introduce.
const ACCEPTED_DETECTOR_EXCLUSIONS = new Set([]);

let hasError = false;

function fail(message) {
  console.error(`✗ ${message}`);
  hasError = true;
}

function readJson(filePath, label) {
  if (!fs.existsSync(filePath)) {
    fail(`${label} no existe en ${filePath}`);
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (err) {
    fail(`${label} no es JSON válido: ${err.message}`);
    return null;
  }
}

const config = readJson(CONFIG_PATH, "slither.config.json");

if (config) {
  if (!ACCEPTED_FAIL_ON.has(config.fail_on)) {
    fail(
      `fail_on="${config.fail_on}" no cumple el umbral aceptado para Sprint 7 ` +
        `(valores permitidos: ${[...ACCEPTED_FAIL_ON].join(", ")}). ` +
        "Ver docs/VOTAR-351-auditoria-smart-contracts.md §7."
    );
  }

  if (config.exclude_dependencies !== true) {
    fail(
      'exclude_dependencies debe ser "true" (evita ruido de librerías vendored en el conteo de hallazgos).'
    );
  }

  const filterPaths = String(config.filter_paths ?? "");
  if (!filterPaths.includes("node_modules")) {
    fail(
      'filter_paths ya no excluye "node_modules" — riesgo de ruido/latencia, revisar antes de mergear.'
    );
  }
  if (/(^|[|/])contracts(\/|$)/.test(filterPaths)) {
    fail(
      `filter_paths="${filterPaths}" excluye el directorio "contracts/" del propio proyecto — ` +
        "esto apagaría el análisis sobre código propio y es un falso negativo crítico."
    );
  }

  const detectorsToExclude = String(config.detectors_to_exclude ?? "")
    .split(",")
    .map((d) => d.trim())
    .filter(Boolean);
  const unapproved = detectorsToExclude.filter(
    (d) => !ACCEPTED_DETECTOR_EXCLUSIONS.has(d)
  );
  if (unapproved.length > 0) {
    fail(
      `detectors_to_exclude incluye detectores sin justificación aprobada: ${unapproved.join(", ")}. ` +
        "Documentar en docs/VOTAR-351-auditoria-smart-contracts.md §3.2 y agregar el detector a " +
        "ACCEPTED_DETECTOR_EXCLUSIONS en este script en el mismo PR."
    );
  }

  if (!config.triage_database) {
    fail("triage_database no está configurado en slither.config.json.");
  }
}

const triagePath = path.join(
  process.cwd(),
  (config && config.triage_database) || "slither.db.json"
);
const triageDb = readJson(triagePath, "triage_database");
if (triageDb !== null && (typeof triageDb !== "object" || Array.isArray(triageDb))) {
  fail(`${triagePath} debe ser un objeto JSON (formato de triage de Slither).`);
}

if (hasError) {
  console.error(
    "\nEl quality gate de Slither no cumple el umbral aceptado para Sprint 7 — bloqueando CI (VOTAR-495)."
  );
  process.exit(1);
}

console.log(
  `✓ slither.config.json cumple el umbral aceptado para Sprint 7 (fail_on="${config.fail_on}").`
);
