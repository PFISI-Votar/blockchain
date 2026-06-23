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

### Auditabilidad

`grantRole`/`revokeRole`/`renounceRole` se heredan de OpenZeppelin y emiten **`RoleGranted(role, account, sender)`** y **`RoleRevoked(role, account, sender)`** en cada cambio de privilegios, permitiendo a un indexer externo rastrear permisos en tiempo real.

## Comandos

```bash
npm install              # instalar dependencias
npx hardhat compile      # compilar contratos
npx hardhat test         # ejecutar suite (UAT-01..04)
npx hardhat coverage     # cobertura
```

### Deploy a Sepolia

1. Copiar `.env.example` a `.env` y completar `SEPOLIA_RPC_URL`, `PRIVATE_KEY` y `ADMIN_MULTISIG_ADDRESS` (la Multisig/Governor que recibirá `DEFAULT_ADMIN_ROLE`).
2. Ejecutar:

```bash
npx hardhat run scripts/deploy.ts --network sepolia
```

> **No commitear** `.env` ni claves. La dirección del contrato desplegado debe documentarse aquí una vez en Sepolia.

## Pruebas de usuario (UAT)

Cubiertas en `test/VotarAccessControl.test.ts`:

| UAT | Verifica |
|---|---|
| UAT-01 | Rechazo por rol cruzado: `MERKLE_UPDATER_ROLE` no puede `pause()`. |
| UAT-02 | Gestión de admin: cuenta sin admin no puede otorgar `BALLOT_ROLE`. |
| UAT-03 | Auditoría: `RoleGranted(role, account, sender)` emitido al otorgar. |
| UAT-04 | Auto-revocación: `renounceRole` permite a la cuenta quitarse su propio rol. |
