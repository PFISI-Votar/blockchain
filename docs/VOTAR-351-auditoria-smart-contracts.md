# VOTAR-351 — Reportes de auditoría de Smart Contracts

> **Historia de usuario:** Como Auditor, quiero que el código de los contratos inteligentes
> pase por un análisis de seguridad automatizado previo a cualquier integración.
> **Repositorio:** `PFISI-Votar/blockchain`
> **Pipeline:** job `slither` en `.github/workflows/ci.yml`

---

## 1. Alcance de la implementación

| Pieza | Ubicación |
|-------|-----------|
| Quality gate (medium+) | `slither.config.json` → `fail_on: "medium"` |
| Filtro de dependencias | `slither.config.json` → `filter_paths` / `exclude_dependencies` |
| Excepciones por falso positivo | `slither.db.json` + `detectors_to_exclude` + `// slither-disable-next-line` |
| Reportes Markdown / JSON / HTML | artifact `slither-report` (`reports/slither-report.*`) |
| Generador de reportes | `.github/scripts/generate-slither-reports.js` |

### Decisión: MythX fuera de alcance

El criterio de aceptación menciona *“herramientas estándar (ej. Slither y MythX)”*.
**MythX no se integra** en este pipeline por las siguientes razones:

1. **API comercial / clave de pago** — MythX (Consensys Diligence) requiere suscripción y
   secreto `MYTHX_API_KEY`. El proyecto opera con presupuesto cero y free tiers.
2. **Solapamiento funcional** — Slither ya cubre el quality gate obligatorio
   (Media / Alta / Crítica) y produce reportes machine-readable + navegables.
3. **Alternativa open-source** — si en el futuro se necesita una segunda herramienta,
   la candidata preferida es **Mythril** (sin API de pago), no MythX.

La etapa obligatoria de análisis estático queda cubierta por **Slither** como herramienta
estándar del ecosistema Solidity/Hardhat. Cualquier cambio de alcance que reintroduzca
MythX debe actualizar esta nota y la US en Jira.

---

## 2. Trazabilidad de criterios de aceptación

| Criterio | Evidencia |
|----------|-----------|
| Integración en pipeline | Job `slither` en CI (depende de `test`); herramienta: Slither. MythX justificado fuera de alcance (sección 1). |
| Quality gate Media/Alta/Crítica | `fail_on: "medium"` en `slither.config.json`; CI usa `fail-on: config` y falla el job si hay hallazgos ≥ medium. |
| Umbrales configurables | Editar `fail_on` en `slither.config.json` (`none` \| `low` \| `medium` \| `high` \| `pedantic`). No hardcodear el umbral en `ci.yml`. |
| Reporte JSON / Markdown | Artifact `slither-report` con `slither-report.md`, `slither-report.json` y `slither-report.html`. |
| Excepción por falsos positivos | Sección 3 (whitelist / triage / disable inline). |

---

## 3. Excepciones por falsos positivos

Toda excepción debe quedar **justificada por un desarrollador** (comentario en PR o en este doc).

### 3.1 Hallazgo puntual (preferido)

En el contrato, inmediatamente antes de la línea marcada:

```solidity
// slither-disable-next-line reentrancy-benign -- VOTAR-XXX: el efecto externo es solo un evento de auditoría; estado ya actualizado (CEI).
emit AuditLog(...);
```

### 3.2 Detector completo (usar con cuidado)

Agregar el nombre del detector a `detectors_to_exclude` en `slither.config.json`
(lista separada por comas) y documentar la justificación en la tabla de abajo.

### 3.3 Triage persistente (`slither.db.json`)

1. Correr localmente: `slither . --triage-mode`
2. Marcar el hallazgo como ignorado con justificación.
3. Commitear el `slither.db.json` resultante en la misma PR que introduce la excepción.

| ID / detector | Archivo | Justificación | Autor | Fecha |
|---------------|---------|---------------|-------|-------|
| _(ninguna aún)_ | — | — | — | — |

---

## 4. Cómo ajustar el umbral del quality gate

Desde VOTAR-495 (§7), relajar el umbral **no alcanza con tocar `slither.config.json`**: el
guard `.github/scripts/validate-slither-gate.js` corre antes del análisis y falla el job
`slither` si el valor nuevo no está en la tabla §7.1. Para bajar el umbral (p. ej. a `"high"`)
hay que actualizar, en el mismo PR:

1. `slither.config.json` — cambiar `"fail_on"`.
2. `.github/scripts/validate-slither-gate.js` — sumar el valor a `ACCEPTED_FAIL_ON` (u otra
   constante equivalente, según qué clave se esté relajando).
3. La tabla §7.1 de este documento — reflejar el nuevo valor aceptado y el motivo.

Si el PR solo toca `slither.config.json`, el guard lo bloquea (ver §7.2) aunque el job
`slither` en sí use `fail-on: config` (no hay umbral fijo en el YAML del job — el umbral vive
en `slither.config.json`, y el guard es lo que impide que se relaje sin revisión).

Valores admitidos por Slither: `pedantic`, `low`, `medium`, `high`, `none`.

---

## 5. UAT

| UAT | Cómo verificarlo |
|-----|------------------|
| UAT-01 — bloqueo por hallazgo medium+ | Introducir deliberadamente un patrón detectado por Slither (p. ej. reentrancy) en una rama de prueba; el job `slither` debe quedar en rojo y bloquear el merge. |
| UAT-02 — merge limpio | Contratos actuales + suite verde: Slither sin hallazgos ≥ medium → job verde y artifact `slither-report` disponible. |

---

## 6. Artifact del pipeline

Tras cada run del job `slither` (aunque falle el gate), GitHub Actions publica el artifact
`slither-report` con:

- `slither-report.md` — checklist Markdown de Slither
- `slither-report.json` — salida JSON nativa de Slither (si se generó) + metadatos del run
- `slither-report.html` — vista navegable del checklist

---

## 7. VOTAR-495 — Umbral aceptado Sprint 7 y hardening del bloqueo de merge

**Historia de usuario:** revisar que Slither efectivamente bloquee el merge/despliegue ante
defectos críticos, que el job de CI falle de forma determinística ante hallazgos no triados,
y documentar el umbral aceptado para el Sprint 7 evitando falsos negativos por configuración
laxa.

### 7.1 Umbral aceptado — Sprint 7

| Parámetro | Valor aceptado | Motivo |
|-----------|-----------------|--------|
| `fail_on` | `"medium"` | Bloquea merge ante hallazgos **Media/Alta/Crítica** (criterio de aceptación de VOTAR-351). `"high"` o `"none"` dejarían pasar Medium sin triage → falso negativo. |
| `exclude_dependencies` | `true` | Ignora dependencias vendored (OpenZeppelin) para no diluir la señal con hallazgos fuera de nuestro control. |
| `filter_paths` | `"node_modules/|@openzeppelin/"` (valor exacto) | Solo excluye dependencias de terceros; **nunca** debe incluir `contracts/` (código propio). El guard exige coincidencia exacta, no un regex "parecido". |
| `exclude_medium` / `exclude_high` | sin definir (falsy) | Cualquiera en `true` oculta hallazgos Media/Alta del reporte sin tocar `fail_on` — el gate quedaría en verde igual. |
| `detectors_to_run` | sin definir, o `"all"` | Acotar a un subconjunto recorta el análisis sobre código propio sin que `fail_on` lo refleje. |
| `include_paths` | sin definir | Un `include_paths` acotado recorta el análisis del mismo modo que un `filter_paths` malo, pero sin pasar por ese chequeo. |
| `detectors_to_exclude` | _(vacío)_ | Sin excepciones de detector vigentes a la fecha (Sprint 7). Cualquier alta futura requiere entrada en la tabla §3 y en el guard (§7.2). |
| `triage_database` (`slither.db.json`) | `{}` | Sin hallazgos triageados/ignorados a la fecha. |
| `ci.yml` → step `crytic/slither-action` → `fail-on` | `"config"` | Cualquier otro valor hace que la action pise `fail_on` de `slither.config.json` vía CLI — el archivo deja de mandar aunque esta tabla esté al día. |
| `ci.yml` → step `crytic/slither-action` → `slither-args` | sin flags `--fail-*`, `--no-fail*`, `--exclude*`, `--filter-paths`, `--detectors-to-exclude` | En Slither el CLI gana sobre el config; cualquiera de estos flags reabre el gate sin tocar `slither.config.json`. |

Este umbral fue verificado vigente el 2026-09-12 (Sprint 7). Cualquier cambio a estos valores
debe actualizar esta tabla en el mismo PR.

### 7.2 Guard determinístico contra configuración laxa

Antes de VOTAR-495, un cambio a `slither.config.json` que relajara el umbral (p. ej. `fail_on`
→ `"high"`/`"none"`, vaciar `filter_paths`, o sumar `detectors_to_exclude` sin
justificación) **no rompía el job `slither`** — solo dependía de que un revisor humano lo
notara en el diff del PR. Eso es un falso negativo estructural: el pipeline seguiría en verde
con hallazgos Media/Alta/Crítica sin triage.

La primera versión del guard solo leía `slither.config.json`. Eso dejaba dos huecos: (a)
claves del propio JSON que apagan hallazgos sin tocar `fail_on` (`exclude_medium`,
`exclude_high`, `detectors_to_run`, `include_paths`), y (b) el step de
`crytic/slither-action` en `ci.yml`, donde `fail-on` distinto de `config` o un flag en
`slither-args` (`--fail-high`, `--exclude-medium`, `--filter-paths contracts`, etc.) pisa el
archivo — en Slither el CLI gana sobre el config. El guard cubre ambos desde esta versión.

`.github/scripts/validate-slither-gate.js` corre como paso obligatorio (sin
`continue-on-error`) **antes** del análisis de Slither en el job `slither` y falla la build si:

- `fail_on` no está en `{medium, low, pedantic}` (umbral de la tabla §7.1).
- `exclude_dependencies` no es `true`.
- `filter_paths` no coincide exactamente con el valor aceptado en §7.1 (no se infiere por
  regex: un cambio de filtro tiene que ser un diff visible en el script).
- `exclude_medium` o `exclude_high` están en `true`.
- `detectors_to_run` está definido con un valor distinto de `"all"`.
- `include_paths` está definido (Sprint 7 no lo usa).
- `detectors_to_exclude` trae un detector que no está en el allowlist `ACCEPTED_DETECTOR_EXCLUSIONS`
  del script (agregar el detector ahí es un cambio explícito y revisable en el PR).
- `triage_database` no está configurado o el archivo no es un objeto JSON válido.
- En `.github/workflows/ci.yml`, el step `crytic/slither-action` del job `slither` no tiene
  `fail-on: config`, o su `slither-args` trae `--fail-`, `--no-fail`, `--exclude`,
  `--filter-paths` o `--detectors-to-exclude`.

Esto asegura que **bajar el umbral requiere tocar el guard en el mismo PR** (cambio visible,
intencional y revisable) en lugar de depender solo de la atención del revisor.

### 7.3 Bloqueo de merge (infraestructura del repo)

El bloqueo de merge no vive en `ci.yml` sino en el ruleset de rama de GitHub del repositorio
(`Settings → Rules → Rulesets`, regla **"Merge PR"**, aplicada a `dev` y `master`):

- `required_status_checks`: `test` y `slither` deben pasar.
- `strict_required_status_checks_policy: true` — la rama del PR debe estar al día con la base
  antes de mergear (evita mergear con un check verde pero desactualizado).
- `current_user_can_bypass: "never"`, sin `bypass_actors` — ni administradores pueden saltear
  el gate.

Este ruleset **no se ve** con `git`/en el árbol del repo (es configuración de GitHub, no un
archivo versionado); se verificó vía `gh api repos/PFISI-Votar/blockchain/rulesets` el
2026-09-12. Cualquier cambio a este ruleset queda fuera del alcance de este repo y debe
coordinarse con quien administra la organización `PFISI-Votar`.

### 7.4 UAT

| UAT | Cómo verificarlo |
|-----|------------------|
| UAT-03 — guard detecta umbral relajado | Cambiar localmente `fail_on` a `"high"` o `"none"` y correr `node .github/scripts/validate-slither-gate.js`: debe salir con código ≠ 0 y listar el motivo. |
| UAT-04 — guard detecta exclusión de `contracts/` | Cambiar `filter_paths` para incluir `"contracts/"` y correr el guard: debe fallar explícitamente por excluir código propio. |
| UAT-05 — guard pasa en config vigente | Con `slither.config.json` sin modificar, correr el guard: debe salir 0 y confirmar el `fail_on` vigente. |
| UAT-06 — merge bloqueado por check | Abrir un PR contra `dev`/`master` con el job `slither` en rojo: el ruleset debe impedir el merge (botón "Merge" deshabilitado) hasta que el check esté verde. |
| UAT-07 — guard detecta `fail-on` pisado en `ci.yml` | Cambiar localmente `fail-on: config` a `fail-on: high` en el step de `crytic/slither-action` y correr el guard: debe fallar explícitamente por no usar `config`. |
| UAT-08 — guard detecta flag de `slither-args` que pisa el config | Agregar `--exclude-medium` (o `--fail-high`, `--filter-paths`, `--detectors-to-exclude`) a `slither-args` en `ci.yml` y correr el guard: debe fallar citando el flag. |
| UAT-09 — guard detecta `exclude_medium`/`exclude_high` | Poner `exclude_medium: true` (o `exclude_high: true`) en `slither.config.json` y correr el guard: debe fallar aunque `fail_on` siga en `"medium"`. |
| UAT-10 — guard detecta `filter_paths` no exacto | Cambiar `filter_paths` a una variante que "parezca" correcta pero no sea el valor exacto de §7.1 (p. ej. `"node_modules|contracts\\/"`) y correr el guard: debe fallar por no coincidir, sin depender de inferir el regex. |
