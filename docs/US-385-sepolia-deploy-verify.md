# VOTAR-385 — Despliegue y verificación automatizados en Sepolia

## Objetivo

Automatizar el despliegue reproducible de la infraestructura electoral en Sepolia, verificar el código fuente en Etherscan y exportar ABIs al backend (NestJS) y frontend (Vite), con gas dinámico y reintentos ante fallos de RPC.

## Criterios cubiertos

| Criterio | Implementación |
|---|---|
| Bytecode reproducible | Compilador fijado en `hardhat.config.ts` (`0.8.26`, optimizer `runs: 200`, `cancun`) |
| Verificación automática | `scripts/lib/verify-contract.ts` tras cada deploy en Sepolia |
| Exportación de ABIs | `scripts/lib/export-abis.ts` → `back/src/blockchain/abis/` y `front/src/lib/blockchain/abis/` |
| Gas dinámico + retries | `scripts/lib/gas.ts` + `scripts/lib/retry.ts` en `deploy-sepolia-stack.ts` |
| Credenciales aisladas | Solo variables de entorno (`.env` / `.env.example`); nunca en código |

## Prerrequisitos

Copiar `.env.example` → `.env` y completar:

```bash
SEPOLIA_RPC_URL=          # Infura / Alchemy
PRIVATE_KEY=              # EOA funded con Sepolia ETH
ADMIN_MULTISIG_ADDRESS=   # Multisig / Governor
ETHERSCAN_API_KEY=        # verificación automática
# MERKLE_ROOT_STORE_ADDRESS=  # opcional: reutilizar store US-335
```

## UAT-01 — Deploy limpio + catálogo de artefactos

```bash
cd blockchain
npm run deploy:sepolia:stack
```

Resultado esperado:

- `MerkleRootStore` (si no hay address previa) + `ElectionFactory` desplegados
- Verificación Etherscan (si hay API key)
- `deployments/sepolia/catalog.json` + `*.json` por contrato
- ABIs exportados a back/front

Solo exportar ABIs (sin deploy):

```bash
npm run export:abis
```

## UAT-02 — Gas pico / inestabilidad RPC

El script usa:

- `resolveGasOverrides` — bump progresivo de `maxFeePerGas` / tip por intento
- `withRetry` — backoff exponencial ante `ECONNRESET`, timeouts, 429/5xx, underpriced, etc.
- No confirma un deploy “huérfano”: exige receipt; si falta, reintenta

Variables opcionales:

```bash
DEPLOY_MAX_ATTEMPTS=5
GAS_BUMP_PERCENT=20
DEPLOY_RETRY_DELAY_MS=2000
```

## UAT-03 — Código verificado en Etherscan

Tras el deploy, abrir la dirección en `https://sepolia.etherscan.io/address/<ADDR>#code`.
El tilde verde debe estar presente y el fuente debe coincidir con el repo.

Re-verify manual:

```bash
npx hardhat verify --network sepolia <ADDRESS> <constructor args...>
```

## UAT-04 — Backend consume ABI exportada

```bash
cd back
npm run validate:exported-abis
```

Codifica una llamada de prueba (`publishRoot` / `createElection`) con la ABI JSON exportada.

Luego sincronizar ElectionFactory en PostgreSQL:

```bash
npm run sync:election-factory
```

## Tests unitarios

```bash
cd blockchain
npx hardhat test test/DeployAutomation.test.ts
```
