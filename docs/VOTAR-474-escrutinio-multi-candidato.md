# VOTAR-474 — Escrutinio multi-categoría on-chain

## Problema

`VoteRegistry` guardaba un único `candidateId` por `voterHash`. En boletas con
varias categorías el frontend proyectaba la selección a un solo id de auditoría,
y el escrutinio público (`getVotesByCandidate` / `getTally`) solo reflejaba la
primera categoría.

## Solución

1. **`VoteRegistry.recordVote(electionId, voterHash, uint256[] candidateIds)`**
   incrementa el tally de **cada** id de la boleta. Un voto cuenta como un
   votante único (`_totalVotes += 1`), independientemente de cuántos cargos lleve.
2. **`BallotContract.castSignedVote`** (EIP-712 domain version **`"2"`**) firma y
   envía `uint256[] candidateIds`. Typehash:
   `Vote(uint256 electionId,bytes32 nullifier,bytes32 selectionHash,uint256[] candidateIds,uint256 timestamp)`.
3. **Eventos**
   - Un `VoteCast` por boleta (participación / overwrite; `candidateId` = primer id).
   - Un `VoteUpdated` por id agregado (`old = SIN_VOTO_PREVIO`) o quitado en
     overwrite (`new = SIN_VOTO_PREVIO`). La reconstrucción off-chain ignora el
     sentinel en **ambos** lados.
4. **Frontend** — `resolveAuditCandidateIds` incluye todas las selecciones por
   categoría (ordenado), no solo la primera.

## Criterios de aceptación cubiertos

| # | Criterio | Verificación |
|---|---|---|
| 1 | Una boleta multi-categoría incrementa el tally de **cada** candidato elegido | `VoteRegistry` + `BallotContract.eip712` tests VOTAR-474 |
| 2 | `_totalVotes` / participación cuentan **1** votante por boleta | test multi-candidate unique voters |
| 3 | Blanco / nulo siguen usando el id reservado único | tests existentes de reserved ids |
| 4 | Overwrite LAST_WINS ajusta todos los ids previos y nuevos | overwrite `[A,B]→[A,C]` |
| 5 | EIP-712 v2 amarra el array completo (tamper de ids ⇒ `InvalidSignature`) | BallotContract EIP-712 tests |
| 6 | Validación: vacío / duplicados / >32 ids revierten | `EmptyBallotSelection`, `DuplicateCandidateId`, `TooManyCandidates` |

## Redeploy

Cambio breaking de ABI + domain EIP-712 v2. Requiere redeploy de
`VoteRegistry` + `BallotContract` (vía `ElectionFactory` por comicio) y
actualizar ABIs en front/back (ya sincronizados en este PR).
