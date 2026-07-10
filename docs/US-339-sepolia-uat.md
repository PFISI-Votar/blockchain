# US-339 — Validación criptográfica de electores (Sepolia UAT)

## Contrato

- `BallotContract.castVote(electionId, voterLeaf, merkleProof)`
- Verifica la prueba contra la raíz anclada en `MerkleRootStore`.
- Revierte con `InvalidMerkleProof` si la prueba no coincide.

## Variables de entorno

```env
SEPOLIA_RPC_URL=...
PRIVATE_KEY=...
ADMIN_MULTISIG_ADDRESS=...
ADMIN_PRIVATE_KEY=...          # opcional, para otorgar MERKLE_UPDATER_ROLE
MERKLE_ROOT_STORE_ADDRESS=...  # opcional, despliega uno nuevo si falta
BALLOT_CONTRACT_ADDRESS=...    # opcional, despliega uno nuevo si falta
MERKLE_UPDATER_ADDRESS=...     # opcional, default: deployer
```

## Ejecución

```bash
npm run uat:339:sepolia
```

## Criterios UAT

| UAT | Escenario | Resultado esperado |
|-----|-----------|-------------------|
| UAT-01 | Proof manipulada | Revert `InvalidMerkleProof` |
| UAT-02 | Proof legítima | `VoteCast` + `hasVoted == true` |

## Tests locales

```bash
npm test -- --grep "US-339"
```
