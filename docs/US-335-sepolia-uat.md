# US-335 — Sepolia UAT: Merkle Root Publication

> Publicación del sello de integridad del padrón en la blockchain (VOTAR-335).

## Contrato desplegado

| Red | Contrato | Address |
|-----|----------|---------|
| Sepolia | `MerkleRootStore` | [`0xbDe27804308ADd8e51CF7b1033088D2C9dB0999f`](https://sepolia.etherscan.io/address/0xbDe27804308ADd8e51CF7b1033088D2C9dB0999f) |

| Rol | Address |
|-----|---------|
| `DEFAULT_ADMIN_ROLE` | `0x4852CB3d2acA0fDD4677a3e6dD1C2f3AcEFD6928` |
| `MERKLE_UPDATER_ROLE` (deployer/backend) | `0xeB8FD44Ee4b8A2da04DDbE440e32258535781BF2` |

## UAT on-chain (2026-07-01)

| ID | Resultado | Evidencia |
|----|-----------|-----------|
| **UAT-01** | PASS | Tx [`0x62abea3aec2e5fd71dec6761971e91e1f539a62d80931e30fd50e6dcaa00a7fb`](https://sepolia.etherscan.io/tx/0x62abea3aec2e5fd71dec6761971e91e1f539a62d80931e30fd50e6dcaa00a7fb) — evento `RootPublished` con `electionId=335` |
| **UAT-02** | PASS | Cuenta sin rol revertida (`AccessControlUnauthorizedAccount`) |

## E2E integrado backend + UI (2026-07-01)

Flujo completo vía API NestJS y panel admin (`/comicios/3/padron`):

| Campo | Valor |
|-------|-------|
| **Comicio (DB)** | `id_eleccion=3` — *E2E US-335 2026-07-01T19:30:53.270Z* |
| **Raíz Merkle** | `0x7f6529cef5733fdd43f39cba31ad045ba66dae37266ffb9683b0793e25f1105f` |
| **Tx publicación** | [`0x201a8e81e858f368259d1fac0ca309a1a70e722031c355f55860af059a04d012`](https://sepolia.etherscan.io/tx/0x201a8e81e858f368259d1fac0ca309a1a70e722031c355f55860af059a04d012) |
| **Bloque** | `11181957` |
| **Estado Merkle (DB)** | `PUBLICADO_ON_CHAIN` |
| **Re-publicación** | HTTP `409` con body idempotente |

La UI muestra estado `PUBLICADO_ON_CHAIN`, contrato, hash de tx y enlace **Ver en Etherscan**.

## Configuración backend

Agregar en `back/.env` (no commitear):

```env
SEPOLIA_RPC_URL=<mismo RPC que blockchain/.env>
MERKLE_ROOT_STORE_ADDRESS=0xbDe27804308ADd8e51CF7b1033088D2C9dB0999f
MERKLE_UPDATER_PRIVATE_KEY=<clave de 0xeB8FD44Ee4b8A2da04DDbE440e32258535781BF2>
CHAIN_ID=11155111
ETHERSCAN_BASE_URL=https://sepolia.etherscan.io
```

## Comandos

```bash
npm run deploy:merkle-store:sepolia
MERKLE_ROOT_STORE_ADDRESS=0xbDe27804308ADd8e51CF7b1033088D2C9dB0999f npm run uat:335:sepolia
```

## Tests locales (Hardhat)

```bash
npm test -- test/MerkleRootStore.test.ts
```

Suite: 5 tests (UAT-01/02 + validaciones de idempotencia y root cero).
