# VOTAR — Blockchain (On-Chain)

Smart contracts del ecosistema electoral VOTAR. Stack: **Solidity ^0.8.24**, **OpenZeppelin v5**, **Hardhat** (TypeScript) y despliegue en **Ethereum Sepolia** testnet.

## RBAC — Control de acceso (AccessControl)

Base de seguridad del sistema: control de acceso basado en roles (RBAC) con principio de mínimo privilegio, construido sobre `@openzeppelin/contracts/access/AccessControl.sol`.

### Roles

| Rol | Constante | Capacidad |
|---|---|---|
| `DEFAULT_ADMIN_ROLE` | `0x00` (OZ) | Administración centralizada: único autorizado a otorgar/revocar roles. Se asigna a una **Multisig/Governor** en el deploy. |
| `PAUSER_ROLE` | `keccak256("PAUSER_ROLE")` | Pausar/reanudar operaciones (parada de emergencia). |
| `MERKLE_UPDATER_ROLE` | `keccak256("MERKLE_UPDATER_ROLE")` | Publicar/actualizar la Merkle root del padrón. |
| `BALLOT_ROLE` | `keccak256("BALLOT_ROLE")` | Operaciones de boleta (registro de voto). |

### Contratos

- `contracts/access/VotarAccessControl.sol` — **base abstracta** (`AccessControl` + `Pausable`). Define los roles, el constructor que asigna `DEFAULT_ADMIN_ROLE` al admin Multisig, y `pause()/unpause()` guardados por `PAUSER_ROLE`. Los contratos del ecosistema (BallotContract, MerkleRootRegistry, ElectionFactory, …) la heredan.
- `contracts/mocks/AccessControlHarness.sol` — contrato concreto de prueba. Añade una función crítica por rol (`updateMerkleRoot`, `recordBallotOp`) para validar el aislamiento de operaciones.
- `contracts/merkle/MerkleRootStore.sol` — almacén de Merkle roots por `electionId` (US-335). Emite `RootPublished`; `publishRoot` requiere `MERKLE_UPDATER_ROLE`.

### Auditabilidad

`grantRole`/`revokeRole`/`renounceRole` se heredan de OpenZeppelin y emiten **`RoleGranted(role, account, sender)`** y **`RoleRevoked(role, account, sender)`** en cada cambio de privilegios, permitiendo a un indexer externo rastrear permisos en tiempo real.

## Comandos

```bash
npm install              # instalar dependencias
npx hardhat compile      # compilar contratos
npx hardhat test         # ejecutar suite (UAT-01..04)
npx hardhat coverage     # cobertura
```

### Desarrollo local

Desde `blockchain/`:

```bash
npm run dev
```

Esto levanta Hardhat node en `http://127.0.0.1:8545`, compila y despliega `MerkleRootStore` + `BallotContract`, otorga `MERKLE_UPDATER_ROLE` a la cuenta del backend y escribe automáticamente:

- `../back/.env.blockchain.local`
- `../front/.env.local` (mergea RPC, chainId, BallotContract y transmitter; preserva otras vars como `VITE_API_URL`)

Luego, en otras terminales: `npm run dev` en `back/` y `front/` (reiniciá el front para cargar `.env.local`).

Si reiniciás Hardhat node, volvé a correr `npm run dev` en este repo para redeployar.

La red `hardhat` tiene auto-mining (`interval: 0`) para confirmar transacciones al instante en tests/dev.

Si solo necesitás republicar una raíz Merkle contra un nodo local ya desplegado:

```bash
ELECTION_ID=2 \
MERKLE_ROOT=0x... \
MERKLE_ROOT_STORE_ADDRESS=0x... \
npx hardhat run scripts/republish-merkle-root.ts --network localhost
```

Comandos puntuales:

```bash
npm run node          # solo Hardhat node (sin deploy)
npm run deploy:local  # deploy contra un nodo ya corriendo
```

Cuentas Hardhat por defecto en local:

| Índice | Rol |
|--------|-----|
| #0 | `DEFAULT_ADMIN_ROLE` |
| #1 | `MERKLE_UPDATER_ROLE` (wallet del backend) |

### Deploy a Sepolia

1. Copiar `.env.example` a `.env` y completar `SEPOLIA_RPC_URL`, `PRIVATE_KEY`, `ADMIN_MULTISIG_ADDRESS` y (para UAT on-chain) `ADMIN_PRIVATE_KEY`.
2. Ejecutar:

```bash
npm run deploy:sepolia
npx hardhat run scripts/sepolia-uat.ts --network sepolia

# US-335 — MerkleRootStore
npm run deploy:merkle-store:sepolia
npm run uat:335:sepolia
```

### Deploy ElectionFactory (VOTAR-337)

Despliega el contrato maestro, verifica el código en Etherscan (si hay `ETHERSCAN_API_KEY`) y escribe el artefacto `deployments/<network>/ElectionFactory.json` (dirección + ABI) para sincronizar con NestJS/PostgreSQL:

```bash
# Requiere MERKLE_ROOT_STORE_ADDRESS ya desplegado (US-335)
npm run deploy:factory:sepolia
```

Luego, desde `back/`:

```bash
npm run sync:election-factory
```

### Despliegue documentado (US-349)

| Red | Contrato | Admin (`DEFAULT_ADMIN_ROLE`) |
|-----|----------|------------------------------|
| Sepolia | [`0x55d1d115309872C16B9646362C82fFa246F3F652`](https://sepolia.etherscan.io/address/0x55d1d115309872C16B9646362C82fFa246F3F652) | `0x4852CB3d2acA0fDD4677a3e6dD1C2f3AcEFD6928` |

Evidencia completa de UAT en testnet: [`docs/US-349-sepolia-uat.md`](docs/US-349-sepolia-uat.md).

> **No commitear** `.env` ni claves privadas.

## Pruebas de usuario (UAT)

Cubiertas en `test/VotarAccessControl.test.ts`:

| UAT | Verifica |
|---|---|
| UAT-01 | Rechazo por rol cruzado: `MERKLE_UPDATER_ROLE` no puede `pause()`. |
| UAT-02 | Gestión de admin: cuenta sin admin no puede otorgar `BALLOT_ROLE`. |
| UAT-03 | Auditoría: `RoleGranted(role, account, sender)` emitido al otorgar. |
| UAT-04 | Auto-revocación: `renounceRole` permite a la cuenta quitarse su propio rol. |

### UAT en Sepolia (testnet)

Ver [`docs/US-349-sepolia-uat.md`](docs/US-349-sepolia-uat.md). Script: `scripts/sepolia-uat.ts`.
