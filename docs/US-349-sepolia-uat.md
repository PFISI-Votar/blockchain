# US-349 — Prueba RBAC en Sepolia Testnet

> **Historia de usuario:** Control de acceso por roles en contratos inteligentes  
> **Red:** Ethereum Sepolia (chainId `11155111`)  
> **Fecha de ejecución:** 2026-06-24  
> **Repositorio:** `PFISI-Votar/blockchain`

---

## 1. Alcance de la prueba

Esta evidencia documenta la validación on-chain del marco RBAC implementado en el sprint:

| Contrato | Tipo | Descripción |
|----------|------|-------------|
| `VotarAccessControl.sol` | Base abstracta | `AccessControl` + `Pausable` de OpenZeppelin v5; define roles y `pause()`/`unpause()` |
| `AccessControlHarness.sol` | Concreto (UAT) | Mock que expone una función crítica por rol para probar aislamiento |

> Los contratos electorales de producción (`BallotContract`, `VoteRegistry`, etc.) **heredarán** `VotarAccessControl` en historias futuras. Esta prueba valida la capa RBAC base desplegada en testnet.

---

## 2. Despliegue en Sepolia

| Campo | Valor |
|-------|-------|
| **Contrato** | [`0x55d1d115309872C16B9646362C82fFa246F3F652`](https://sepolia.etherscan.io/address/0x55d1d115309872C16B9646362C82fFa246F3F652) |
| **DEFAULT_ADMIN_ROLE** | `0x4852CB3d2acA0fDD4677a3e6dD1C2f3AcEFD6928` |
| **Deployer (gas)** | `0xeB8FD44Ee4b8A2da04DDbE440e32258535781BF2` |
| **Script** | `scripts/deploy.ts` |
| **Comando** | `npm run deploy:sepolia` |

### Roles on-chain

| Rol | Constante | Capacidad verificada |
|-----|-----------|----------------------|
| `DEFAULT_ADMIN_ROLE` | `0x00` (OZ) | Único autorizado a `grantRole` / `revokeRole` |
| `PAUSER_ROLE` | `keccak256("PAUSER_ROLE")` | `pause()` / `unpause()` |
| `MERKLE_UPDATER_ROLE` | `keccak256("MERKLE_UPDATER_ROLE")` | `updateMerkleRoot()` (harness) |
| `BALLOT_ROLE` | `keccak256("BALLOT_ROLE")` | `recordBallotOp()` (harness) |

---

## 3. Pruebas de usuario (UAT) en Sepolia

Ejecutadas con `scripts/sepolia-uat.ts`:

```bash
npx hardhat run scripts/sepolia-uat.ts --network sepolia
```

Variables requeridas en `.env`:

| Variable | Uso |
|----------|-----|
| `SEPOLIA_RPC_URL` | Endpoint Infura/Alchemy |
| `PRIVATE_KEY` | Deployer (paga gas de funding y pruebas) |
| `ADMIN_MULTISIG_ADDRESS` | Cuenta con `DEFAULT_ADMIN_ROLE` |
| `ADMIN_PRIVATE_KEY` | Firma transacciones del admin en UAT-01/03/04 |
| `CONTRACT_ADDRESS` | Reutiliza contrato ya desplegado (opcional) |

### Resultado — 2026-06-24

| UAT | Escenario | Resultado |
|-----|-----------|-----------|
| **UAT-01** | `MERKLE_UPDATER_ROLE` invoca `pause()` | **PASS** — revert por `AccessControlUnauthorizedAccount` |
| **UAT-02** | Cuenta sin admin intenta `grantRole(BALLOT_ROLE, …)` | **PASS** — revert |
| **UAT-03** | Admin otorga rol → evento `RoleGranted(role, account, sender)` | **PASS** — args correctos en receipt |
| **UAT-04** | Cuenta invoca `renounceRole` sobre su propio rol | **PASS** — `RoleRevoked` emitido; `hasRole` → `false` |
| **Bonus** | `PAUSER_ROLE` invoca `pause()` | **PASS** — contrato en estado pausado |

```
Passed: 5 | Failed: 0 | Skipped: 0
```

### Notas operativas

1. La cuenta **Admin** necesita ETH de Sepolia para firmar `grantRole` (se transfirió `0.01 ETH` desde el Deployer).
2. Las cuentas efímeras de prueba reciben `0.002 ETH` cada una para pagar gas en `renounceRole` y reverts intencionales.
3. Tras la prueba bonus el contrato quedó **pausado** (`paused = true`). Es estado esperado en testnet.

---

## 4. Pruebas locales (referencia)

Suite Hardhat equivalente (sin gas real):

```bash
npm test
# 14 passing — test/VotarAccessControl.test.ts
```

---

## 5. Verificación manual en Etherscan

1. Abrir [el contrato en Sepolia Etherscan](https://sepolia.etherscan.io/address/0x55d1d115309872C16B9646362C82fFa246F3F652).
2. Pestaña **Events** → filtrar `RoleGranted`, `RoleRevoked`, `Paused`.
3. Pestaña **Read Contract** → `paused()`, `hasRole`, `getRoleAdmin`.

---

## 6. Criterios de aceptación — trazabilidad

| Criterio US-349 | Evidencia |
|-----------------|-----------|
| Framework OpenZeppelin `AccessControl` | `VotarAccessControl.sol` + dependencia `@openzeppelin/contracts@^5.1.0` |
| Roles inicializados internamente | Constantes `PAUSER_ROLE`, `MERKLE_UPDATER_ROLE`, `BALLOT_ROLE` |
| Admin centralizado en Multisig al deploy | Constructor + `ADMIN_MULTISIG_ADDRESS` en deploy Sepolia |
| Funciones críticas con `onlyRole` | `pause`, `unpause`, `updateMerkleRoot`, `recordBallotOp` |
| Eventos `RoleGranted` / `RoleRevoked` | UAT-03, UAT-04 (Sepolia + local) |

---

## 7. Pendiente (fuera de alcance US-349)

- Herencia de `VotarAccessControl` en `BallotContract`, `MerkleRootStore`, `VoteRegistry`, `TallyContract`, `ElectionFactory`.
- `unpause()` manual post-prueba si se requiere contrato activo en testnet.
