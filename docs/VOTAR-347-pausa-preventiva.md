# VOTAR-347 — Pausa de emergencia (protección operacional del sistema de votación)

> **Historia de usuario:** Como Autoridad Electoral, quiero tener la capacidad de detener
> de forma preventiva la operación de la urna digital ante incidentes detectados.
> **Repositorio:** `PFISI-Votar/blockchain`
> **Base:** extiende el marco RBAC/Pausable de US-349 (`VotarAccessControl.sol`).

---

## 1. Alcance de la implementación

| Contrato | Cambio |
|----------|--------|
| `VotarAccessControl.sol` | `pause(string reason)` (overload de `pause()`), evento `Paused(address account, string reason)` |
| `MerkleRootStore.sol` | `whenNotPaused` agregado a `setElectionState`, `setElectionWindow`, `lockConfig`, `publishRoot` |
| `VoteRegistry.sol` | `whenNotPaused` agregado a `registerCandidates` (`recordVote` ya lo tenía) |
| `ElectionFactory.sol` | Nuevo `pauserOperator` inmutable — cada elección creada por `createElection` otorga `PAUSER_ROLE` automáticamente en su `BallotContract`/`VoteRegistry` |

**Decisión de alcance (AC2 — Multisig)**: no existe un contrato multisig on-chain en este repo. `PAUSER_ROLE` se otorga a la wallet operativa del backend (`pauserOperator`); el requisito de "ningún individuo puede sabotear el sistema en solitario" se aplica a **nivel de aplicación** en `back/` (flujo de solicitud + confirmación de 2+ autoridades distintas antes de emitir la transacción). Ver `back/src/eleccion/services/pausa-comicio.service.ts`.

**Alcance explícito**: la pausa es **por comicio** — se aplica sobre el `BallotContract` y `VoteRegistry` de la elección afectada, nunca sobre `MerkleRootStore`/`ElectionFactory` (singletons compartidos por todas las elecciones). Un "kill switch" de plataforma completa queda fuera de alcance.

---

## 2. Trazabilidad de criterios de aceptación

| Criterio | Evidencia |
|----------|-----------|
| AC1 — `whenNotPaused` en funciones críticas | `BallotContract.castVote/castSignedVote`, `VoteRegistry.recordVote/registerCandidates`, `MerkleRootStore.setElectionState/setElectionWindow/lockConfig/publishRoot`, `ElectionFactory.createElection/lockConfig` |
| AC2 — Control de acceso (no una sola cuenta) | `ElectionFactory.pauserOperator` + confirmación de 2+ autoridades a nivel de aplicación (`back/`) |
| AC3 — Registro de justificación | `pause(string reason)` en `VotarAccessControl.sol` |
| AC4 — Alcance de la pausa (solo lectura durante bloqueo) | Getters de `MerkleRootStore`/`VoteRegistry`/`BallotContract` sin `whenNotPaused`; ver tests "keeps ... readable while paused" |
| AC5 — Evento `Paused(address account, string reason)` | `event Paused(address indexed account, string reason)` en `VotarAccessControl.sol`; consumido hoy indirectamente en `front/` vía el error `EnforcedPause` mapeado en `vote-tx-error-catalog.ts` |

---

## 3. Pruebas de usuario (UAT)

### UAT-01 (Happy Path) — pausa autorizada bloquea el voto

Local (Hardhat): `test/VotarAccessControl.test.ts` → `UAT-01 — cross-role rejection` (casos `pause(reason)`); `test/BallotContract.test.ts` / `test/BallotContract.eip712.test.ts` → casos "reverts when contract is paused" (`EnforcedPause` tras `castSignedVote`).

### UAT-02 (Acceso no autorizado)

`test/VotarAccessControl.test.ts` → `pause(reason): reverts for an account without PAUSER_ROLE` (`AccessControlUnauthorizedAccount`).

### UAT-03 (Seguridad de estado — lecturas durante la pausa)

`test/MerkleRootStore.test.ts` → `pause — VOTAR-347` → `getters keep responding while paused`; `test/VoteRegistry.test.ts` → `access control and pause` → `keeps VOTAR-350 view helpers readable while paused`; `test/AuditViewContract.test.ts` → `UAT-04: reads remain available while paused` (contrato no-Pausable por diseño).

### UAT-04 (Protección de transacciones en vuelo) — análisis, sin código

No requiere un test automatizado (la propia historia lo scopea como análisis documentado):

Una transacción de voto (`castSignedVote`) que ya esté en el mempool cuando se confirma el bloque que contiene la transacción de `pause(reason)` puede, en el peor caso, minarse en el **mismo bloque** posterior a la pausa o en uno **posterior**. En ambos casos el resultado es determinístico:

- El EVM ejecuta las transacciones de un bloque en el orden en que el minero/validador las incluyó. Si la tx de `pause` se incluye antes que la tx de voto **dentro del mismo bloque**, `_paused` ya es `true` cuando se ejecuta `castSignedVote`, y esta revierte con `EnforcedPause`.
- Cualquier tx de voto que llegue en un bloque **posterior** al de la pausa ve el estado `paused() == true` al inicio de su propia ejecución (el efecto de `_pause()` se confirma atómicamente junto con la transacción de pausa), y revierte con `EnforcedPause` sin excepción.
- La única ventana en la que un voto puede colarse es si su transacción ya estaba incluida en un bloque **anterior** al de la pausa — comportamiento esperado y no evitable por ningún mecanismo de pausa a nivel de aplicación (es inherente a cómo Ethereum ordena bloques), documentado aquí para que quede explícito que la garantía de esta historia es "ningún voto nuevo se admite después de que la pausa se confirma on-chain", no "cancelación retroactiva de transacciones ya incluidas".

`front/src/features/voto/crypto/vote-tx-error-catalog.ts` ya mapea `EnforcedPause` a un mensaje de UI (`El comicio se encuentra temporalmente pausado...`), por lo que un votante cuya transacción revierte por esta causa recibe feedback claro sin cambios adicionales.

---

## 4. Pendiente (fuera de alcance de VOTAR-347)

- Ejecución de esta suite contra Sepolia testnet (evidencia on-chain, siguiendo el formato de `docs/US-349-sepolia-uat.md`) — no se corrió en esta sesión de desarrollo.
- Un "kill switch" de plataforma completa (pausar `MerkleRootStore`/`ElectionFactory`).
- Un multisig on-chain real (Gnosis Safe u otro esquema n-of-m) para `PAUSER_ROLE`, en reemplazo de la confirmación a nivel de aplicación.
