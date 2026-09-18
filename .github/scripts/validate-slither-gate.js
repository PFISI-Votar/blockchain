#!/usr/bin/env node
/**
 * VOTAR-495 — Guard contra debilitamiento silencioso del quality gate de Slither.
 *
 * Corre ANTES del análisis de Slither en CI y falla de forma determinística si
 * slither.config.json o el step de crytic/slither-action en
 * .github/workflows/ci.yml ya no cumplen el umbral aceptado para Sprint 7
 * (docs/VOTAR-351-auditoria-smart-contracts.md §7). Sin este guard, bajar
 * `fail_on` a "high"/"none", vaciar/relajar `filter_paths`, prender
 * `exclude_medium`/`exclude_high`, acotar `detectors_to_run`/`include_paths`,
 * o pisar cualquiera de esos valores vía `fail-on`/`slither-args` en el YAML,
 * pasaría desapercibido en la revisión de un PR y generaría falsos negativos
 * (el job `slither` seguiría en verde con hallazgos Media/Alta/Crítica sin
 * triage).
 */
const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");

const CONFIG_PATH = path.join(process.cwd(), "slither.config.json");
const CI_WORKFLOW_PATH = path.join(process.cwd(), ".github/workflows/ci.yml");

// Umbral aceptado Sprint 7: Media/Alta/Crítica deben bloquear el merge.
// "high" deja pasar Medium sin triage; "none" desactiva el gate por completo.
const ACCEPTED_FAIL_ON = new Set(["medium", "low", "pedantic"]);

// Valor exacto aceptado para Sprint 7 (docs/VOTAR-351-auditoria-smart-contracts.md §7.1).
// Fijo en vez de inferido por regex: un filtro nuevo debe ser un diff visible acá.
const ACCEPTED_FILTER_PATHS = "node_modules/|@openzeppelin/";

// detectors_to_run acotado recorta el análisis sobre código propio. Sprint 7
// exige el ruleset completo: sin definir, o "all" explícito.
const ACCEPTED_DETECTORS_TO_RUN = new Set(["", "all"]);

// Exclusiones de detector aprobadas explícitamente (ver doc §3.2). Vacío por
// defecto: hoy no hay ninguna exclusión documentada, así que cualquier valor
// en `detectors_to_exclude` debe agregarse acá en el mismo PR que lo introduce.
const ACCEPTED_DETECTOR_EXCLUSIONS = new Set([]);

// Flags de `slither-args` en ci.yml que pisan slither.config.json vía CLI:
// en Slither, el CLI gana sobre el config. Cualquiera de estos reabre el
// hueco que este guard existe para cerrar.
const FORBIDDEN_SLITHER_ARG_SUBSTRINGS = [
  "--fail-",
  "--no-fail",
  "--exclude",
  "--filter-paths",
  "--detectors-to-exclude",
];

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
  if (filterPaths !== ACCEPTED_FILTER_PATHS) {
    fail(
      `filter_paths="${filterPaths}" no coincide con el valor aceptado para Sprint 7 ` +
        `("${ACCEPTED_FILTER_PATHS}", ver §7.1). Un cambio de filtro tiene que ser un diff ` +
        "visible en este script, no solo en slither.config.json."
    );
  }

  if (config.exclude_medium === true) {
    fail(
      'exclude_medium no puede ser "true" — oculta hallazgos Media del reporte sin tocar ' +
        '`fail_on`, dejando pasar exactamente lo que fail_on="medium" debería bloquear.'
    );
  }

  if (config.exclude_high === true) {
    fail(
      'exclude_high no puede ser "true" — oculta hallazgos Alta/Crítica del reporte sin tocar `fail_on`.'
    );
  }

  const detectorsToRun = String(config.detectors_to_run ?? "");
  if (!ACCEPTED_DETECTORS_TO_RUN.has(detectorsToRun)) {
    fail(
      `detectors_to_run="${detectorsToRun}" acota el análisis a un subconjunto de detectores — ` +
        'Sprint 7 exige el ruleset completo (sin definir, o "all"). ' +
        "Ver docs/VOTAR-351-auditoria-smart-contracts.md §7.1."
    );
  }

  if (config.include_paths !== undefined) {
    fail(
      "include_paths no debe estar definido — Sprint 7 analiza todo el proyecto (el recorte a " +
        "terceros ya lo hace filter_paths). Un include_paths acotado recorta el análisis sobre " +
        "código propio sin pasar por este guard."
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

function findSlitherStep(workflow) {
  const slitherJob = workflow && workflow.jobs && workflow.jobs.slither;
  if (!slitherJob || !Array.isArray(slitherJob.steps)) {
    fail(".github/workflows/ci.yml no define jobs.slither.steps.");
    return null;
  }
  const step = slitherJob.steps.find(
    (s) => typeof s.uses === "string" && s.uses.startsWith("crytic/slither-action@")
  );
  if (!step) {
    fail(
      '.github/workflows/ci.yml ya no usa "crytic/slither-action" en el job "slither" — ' +
        "revisar manualmente si el gate de VOTAR-351 sigue vigente."
    );
    return null;
  }
  return step;
}

if (!fs.existsSync(CI_WORKFLOW_PATH)) {
  fail(`${CI_WORKFLOW_PATH} no existe.`);
} else {
  let workflow;
  try {
    workflow = yaml.load(fs.readFileSync(CI_WORKFLOW_PATH, "utf8"));
  } catch (err) {
    workflow = null;
    fail(`.github/workflows/ci.yml no es YAML válido: ${err.message}`);
  }

  if (workflow) {
    const slitherStep = findSlitherStep(workflow);
    if (slitherStep) {
      const withArgs = slitherStep.with || {};

      if (withArgs["fail-on"] !== "config") {
        fail(
          `El step de crytic/slither-action en ci.yml tiene fail-on="${withArgs["fail-on"]}" ` +
            'en vez de "config". Con cualquier otro valor, la action ignora el `fail_on` de ' +
            "slither.config.json — el umbral de la tabla §7.1 deja de aplicarse aunque este " +
            "script pase."
        );
      }

      const slitherArgs = String(withArgs["slither-args"] ?? "");
      const forbiddenHit = FORBIDDEN_SLITHER_ARG_SUBSTRINGS.find((flag) =>
        slitherArgs.includes(flag)
      );
      if (forbiddenHit) {
        fail(
          `slither-args en ci.yml contiene "${forbiddenHit}" — en Slither el CLI gana sobre ` +
            "slither.config.json, así que este flag pisa el umbral/filtro validado arriba " +
            "(falso negativo aunque slither.config.json esté correcto). Sacarlo, o justificarlo " +
            "explícitamente en docs/VOTAR-351-auditoria-smart-contracts.md §7 y agregarlo al " +
            "allowlist de este script en el mismo PR."
        );
      }
    }
  }
}

if (hasError) {
  console.error(
    "\nEl quality gate de Slither no cumple el umbral aceptado para Sprint 7 — bloqueando CI (VOTAR-495)."
  );
  process.exit(1);
}

console.log(
  `✓ slither.config.json y el step de Slither en ci.yml cumplen el umbral aceptado para Sprint 7 (fail_on="${config.fail_on}").`
);
