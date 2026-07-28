# VOTAR-337 — ElectionFactory (infraestructura de comicios)

## Objetivo

Automatizar el despliegue del contrato maestro `ElectionFactory` en Sepolia, verificar el código fuente en Etherscan y registrar dirección + ABI en PostgreSQL (NestJS) para llamadas dinámicas.

`createElection` despliega por comicio: `VoteRegistry` + `BallotContract` + `AuditViewContract`, cableados al `MerkleRootStore` compartido.

## Prerrequisitos

1. `MERKLE_ROOT_STORE_ADDRESS` ya desplegado (US-335).
2. Variables en `blockchain/.env`:
   - `SEPOLIA_RPC_URL`, `PRIVATE_KEY`, `ADMIN_MULTISIG_ADDRESS`
   - `MERKLE_ROOT_STORE_ADDRESS`
   - `ETHERSCAN_API_KEY` (para verificación automática)

## UAT-01 — Despliegue + verificación

```bash
cd blockchain
npm run deploy:factory:sepolia
```

Resultado esperado:

- Consola imprime la dirección de `ElectionFactory`.
- Si hay `ETHERSCAN_API_KEY`, el script verifica el código (tilde verde en Etherscan).
- Se genera `deployments/sepolia/ElectionFactory.json`.

Verificación manual:

```bash
npx hardhat verify --network sepolia <FACTORY_ADDRESS> <ADMIN> <MERKLE_ROOT_STORE>
```

## UAT-02 — Registro en PostgreSQL

```bash
cd back
npm run migrate
npm run sync:election-factory
# o: ELECTION_FACTORY_NETWORK=sepolia npm run sync:election-factory
```

Resultado esperado: fila en `contrato_blockchain` con `tipo=ELECTION_FACTORY`, `direccion_contrato` y `abi` (jsonb).

Consulta HTTP:

```bash
curl http://localhost:3000/blockchain/contratos/election-factory?red=SEPOLIA
```
