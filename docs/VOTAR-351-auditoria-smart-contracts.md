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

1. Abrir `slither.config.json`.
2. Cambiar `"fail_on"` (p. ej. `"high"` solo falla en High/Critical).
3. Abrir PR: el job `slither` lee el archivo vía `fail-on: config` (no hay umbral fijo en YAML).

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
