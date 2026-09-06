# VOTAR-377 — Entidad de Firmas Digitales (Tercero de Confianza)

> **Historia de usuario:** Como Autoridad Electoral, quiero que el sistema cuente con
> un servicio de validación de firmas digitales que actúe como un "Tercero de Confianza",
> para certificar la legitimidad de cada sufragio emitido por miembros del padrón sin
> comprometer el anonimato del votante y garantizando el cumplimiento de la Ley N° 25.506.
> **Repositorios:** `PFISI-Votar/blockchain` (enforcement on-chain), `PFISI-Votar/back`
> (Entidad de Firmas), `PFISI-Votar/front` (integración BUD).

---

## 1. Problema

Antes de esta US, `BallotContract.castSignedVote` no tenía **ningún control de
autorización**: era `external whenNotPaused` y la única firma que verificaba era la del
propio votante (`ECDSA.recover(...) == expectedSigner`), donde `expectedSigner` lo
provee el mismo llamador. Es decir: probaba que el payload lo firmó *alguien*, no que
ese alguien estuviera habilitado. Cualquiera con una Merkle proof podía votar salteando
el backend (riesgo **R5** — vulneración del SSO → Merkle proofs ilegítimas).

## 2. Solución — esquema de dos fases con credencial anónima (commit/reveal)

El AC-5 exige que la firma institucional cubra **todo** el payload (incluida la
selección partidaria); el AC-3 exige que el backend **no pueda** vincular identidad ↔
selección. Se resuelve separando la validación de identidad de la emisión de la firma:

```
FASE 1 — Emisión de credencial (AUTENTICADA, JWT votante)          [back/]
  cliente:  s = random(32)  (sólo RAM);  commit = keccak256(s)
  POST /elecciones/:id/validacion/credencial  { commit }
  backend:  valida padrón (votanteHash del JWT) + estado ABIERTA
            INSERT credencial_validacion(commit, expira_en)      ← sin votante_hash
            UPSERT emision_credencial(votante_hash, contador)    ← sin commit

FASE 2 — Firma institucional (ANÓNIMA, credentials:'omit', sin JWT) [back/]
  POST /elecciones/:id/validacion/firma
    { secreto: s, nullifier, selectionHash, candidateId, timestamp, expectedSigner }
  backend:  keccak256(s) ∈ credenciales EMITIDAS y no vencidas ?
            → marca CONSUMIDA (UPDATE atómico condicional)
            → firma EIP-712 `Validation` con VALIDATOR_PRIVATE_KEY
  ← { firmaValidacion, direccionValidador }

ON-CHAIN — castSignedVote(vote, merkleProof, signature, validatorSignature)  [blockchain/]
  1. whenNotPaused
  2. _assertElectionAcceptingVotes
  3. validatorSignature.length == 0            → MissingValidatorSignature   (UAT-01)
  4. recover(Validation digest) ∈ VALIDATOR_ROLE ? → InvalidValidatorSignature (UAT-01/03)
  5. Merkle proof, anti-doble-voto, cooldown, firma efímera del votante
  6. VoteRegistry.recordVote + emit SignedVoteCast
```

**Argumento de anonimato (AC-3 / UAT-02):** el backend nunca observa `votanteHash` y
`selectionHash` en la misma request. La fase 2 llega sin cookie, sin JWT y sin ninguna
referencia recuperable a la fase 1 — `credencial_validacion` y `emision_credencial` no
comparten columna ni FK, y ambas guardan su marca temporal redondeada al bucket de
5 minutos. La firma que queda en la calldata de Sepolia sólo prueba *"un integrante del
padrón votó"*: excluye deliberadamente `voterLeaf`.

**La credencial NO es el anti-doble-voto** — ese sigue siendo el `nullifier` +
`_enforceRevotePolicy` on-chain (VOTAR-353/341). La credencial es un voucher de
elegibilidad de un solo uso.

## 3. EIP-712 `Validation`

Reusa el dominio existente `EIP712("VOTAR","1")` de cada `BallotContract` (chainId +
verifyingContract ligan la firma a esa elección → sin replay cross-elección, sin costo
de un segundo dominio):

```
Validation(uint256 electionId,bytes32 nullifier,bytes32 selectionHash,
           uint256 candidateId,uint256 timestamp,address expectedSigner)
```

## 4. Cambios on-chain

| Pieza | Ubicación |
|-------|-----------|
| `VALIDATOR_ROLE` (rotable por el Multisig) | `contracts/access/VotarAccessControl.sol` |
| `VALIDATION_TYPEHASH`, `MissingValidatorSignature`, `InvalidValidatorSignature` | `contracts/ballot/BallotContract.sol` |
| Payload agrupado en `SignedVoteInput calldata` (evita *stack too deep* con el 10º arg y reduce bytecode) | `contracts/ballot/BallotContract.sol` |
| `_assertValidValidatorSignature` (verificado **primero**, antes de cualquier escritura) | `contracts/ballot/BallotContract.sol` |
| Eliminación de `castVote` legacy (Merkle-only, sin producción) | `contracts/ballot/BallotContract.sol` |
| `validatorSigner` inmutable + grant de `VALIDATOR_ROLE` en el bloque CEI | `contracts/factory/ElectionFactory.sol` |
| `VALIDATOR_ADDRESS` en scripts de deploy + `constructorArguments` para verify | `scripts/deploy-*.ts`, `.env.example` |
| Guard de tamaño EIP-170 (`ElectionFactory` embebe el init code del ballot) | `test/ContractSize.test.ts` |

Tamaños tras el cambio (optimizer 200): `ElectionFactory` 22 426 B (antes 22 674),
`BallotContract` 7 785 B — sin riesgo de EIP-170.

## 5. Gestión de claves

`VALIDATOR_PRIVATE_KEY` es una env **dedicada** del backend, distinta de `PRIVATE_KEY`
(wallet operativa, además pauser y merkle updater) — separación de funciones. El
cierre definitivo (gestor de secretos + rotación) queda en **VOTAR-382**. `VALIDATOR_ROLE`
es rotable on-chain por `DEFAULT_ADMIN_ROLE` (Multisig) sin redesplegar.

## 6. Redeploy

No hay upgradeability: los `BallotContract` ya desplegados no tienen el nuevo
`castSignedVote`. Hay que **redesplegar `ElectionFactory`** (reusando `MerkleRootStore`
vía `MERKLE_ROOT_STORE_ADDRESS`) y recrear las elecciones. Confirmar que no hay comicio
en curso antes de desplegar.

## 7. Riesgo residual

El backend ve la IP del cliente en ambas fases. Mitigado por la ofuscación de
`AUDIT_OBFUSCATION_SALT` y por no persistir la IP junto a la credencial; cierre real en
VOTAR-382 (hardening + gestor de secretos).

## 8. Trazabilidad de UAT

| UAT | Evidencia |
|-----|-----------|
| UAT-01 — tx sin/ con firma institucional inválida revierte | `test/BallotContract.eip712.test.ts` → `MissingValidatorSignature`, `InvalidValidatorSignature`; `scripts/sepolia-uat-377.ts` |
| UAT-02 — la firma del validador certifica pertenencia al padrón sin revelar DNI/nombre | `test/BallotContract.eip712.test.ts` (evento sin `voterLeaf`, replay cross-elección); `back/.../desvinculacion-identidad.spec.ts`; `scripts/sepolia-uat-377.ts` (recover + `hasRole` + ausencia de DNI en calldata) |
| UAT-03 — payload alterado con firma original → rechazo | `test/BallotContract.eip712.test.ts` → `InvalidValidatorSignature`; `scripts/sepolia-uat-377.ts` |
| UAT-04 — el rastro de auditoría constata integridad y autoría | `scripts/sepolia-uat-377.ts` (escaneo de `SignedVoteCast` + verificación de firma institucional por evento); eventos `FIRMA_VALIDACION_EMITIDA` en `audit_log` (back/) |

## 9. Quality gates

- `npm test` — 172 pruebas (incluye VOTAR-377 y el guard de tamaño).
- CI `slither` (`fail_on: medium`) debe seguir en verde: el nuevo helper replica el
  patrón de `_assertValidVoteSignature` (checks-effects-interactions, zero-checks
  explícitos, custom errors).
