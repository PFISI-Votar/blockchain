# Versionado, ramas y contratos en Sepolia

VOTAR usa [versionado semántico](https://semver.org/lang/es/): `vMAJOR.MINOR.PATCH`.
Cada etiqueta de release nombra el hito y, cuando hubo despliegue, queda ligada
a direcciones concretas en Ethereum Sepolia (chainId `11155111`).

| Etiqueta | Fecha      | Hito                                                                 |
| -------- | ---------- | -------------------------------------------------------------------- |
| `v1.0.0` | 2026-07-28 | MVP: elección funcional extremo a extremo (Sprint 0 — Versión 1)     |
| `v2.0.0` | 2026-08-11 | Re-voto, cooldown, sellado de política y auditoría on-chain (Sprint 4) |

`package.json` declara `2.1.0`: es la línea de integración posterior a `v2.0.0`.
No es un release hasta que exista el tag. No se reescriben etiquetas ya
publicadas.

## Ramas

| Rama     | Rol                                                                 |
| -------- | ------------------------------------------------------------------- |
| `master` | Producción / estable. Contiene `v2.0.0` y es la rama por defecto.   |
| `dev`    | Integración. Recibe los pull requests. Aún no es un release.        |

La rama estable no se adelanta con todo `dev`: eso publicaría trabajo sin
etiquetar como si fuera la versión estable. El próximo release se corta
mergeando `dev` en `master` y creando `v2.1.0` (o el número que corresponda).

Un auditor que clona la rama por defecto (`master`) obtiene la última estable.
`main` no se usa en este repositorio: el nombre de producción acordado es
`master`.

## Stack ligado a `v2.0.0`

Despliegue del 2026-08-10 (tag anotado al día siguiente). Compilador fijado en
`hardhat.config.ts`: Solidity `0.8.26`, optimizer habilitado, `runs: 200`,
`evmVersion: cancun`.

Catálogo público: [`docs/releases/v2.0.0-sepolia.json`](./releases/v2.0.0-sepolia.json).

| Contrato           | Dirección                                                                                                      | Tx de despliegue                                                                                              | SHA-256 de la ABI |
| ------------------ | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ----------------- |
| `MerkleRootStore`  | [`0xfd9125096DA61C2E88645036EB6C61Af45D4bd02`](https://sepolia.etherscan.io/address/0xfd9125096DA61C2E88645036EB6C61Af45D4bd02) | [`0x771f58…fa73fd`](https://sepolia.etherscan.io/tx/0x771f582e726607dcf48e3192a7cc01ad663c9ea6f1b1b5e7284ea2a0d8fa73fd) | `0x16bfda3741ac839a1a7386f160de97a7675b25640e185580c1e8fdd81cd3dd48` |
| `ElectionFactory`  | [`0x12e061F229Fa34b444D6548E4f3ee4340249e7e2`](https://sepolia.etherscan.io/address/0x12e061F229Fa34b444D6548E4f3ee4340249e7e2) | [`0x3a7a22…d5f7e`](https://sepolia.etherscan.io/tx/0x3a7a22ab4d46dd691d20d131eea80c184c3bd24fc07b66d3dffd5d4c5f7d5f7e) | `0xf285ae5432d9446be78169b5eb1f3a65e9ec6e1d8a1d2f2f125d04103ac9d14b` |

`ElectionFactory` se construyó con admin `0x5AdfE82772625E0337e16467b7FC0CE040154457`
y `MerkleRootStore` `0xfd9125096DA61C2E88645036EB6C61Af45D4bd02`. Esas
direcciones son públicas on-chain; no son secretos.

El artefacto local de ese deploy registró `verified: false`. La coincidencia
con Etherscan hay que confirmarla con el procedimiento de abajo: este
documento no afirma que el tilde verde ya esté presente.

### Despliegues anteriores (no son el stack de `v2.0.0`)

| Dirección | Qué es | Estado |
| --------- | ------ | ------ |
| [`0x55d1d115309872C16B9646362C82fFa246F3F652`](https://sepolia.etherscan.io/address/0x55d1d115309872C16B9646362C82fFa246F3F652) | Harness RBAC de US-349 (2026-06-24) | Histórico. No es la urna. |
| [`0xbDe27804308ADd8e51CF7b1033088D2C9dB0999f`](https://sepolia.etherscan.io/address/0xbDe27804308ADd8e51CF7b1033088D2C9dB0999f) | `MerkleRootStore` de US-335 | Reemplazado por `0xfd91…bd02`. |

## Cómo comparar el fuente con Sepolia

El hash publicado es SHA-256 de `JSON.stringify(abi)`, el mismo cálculo que
`scripts/lib/export-abis.ts`.

1. Clonar el tag del release, no `dev` (en `dev` el fuente puede haber
   avanzado después del deploy):

   ```bash
   git clone --branch v2.0.0 https://github.com/PFISI-Votar/blockchain.git
   cd blockchain
   npm ci
   npm run compile
   npm run fingerprint
   ```

2. Comparar la salida con la tabla de arriba y con
   `docs/releases/v2.0.0-sepolia.json`.
3. Abrir cada dirección en Sepolia Etherscan, pestaña Contract. El bytecode en
   ejecución debe corresponder a ese fuente con el compilador indicado. Si el
   contrato no está verificado, la verificación se rehace sin cambiar la
   dirección:

   ```bash
   npx hardhat verify --network sepolia 0xfd9125096DA61C2E88645036EB6C61Af45D4bd02 0x5AdfE82772625E0337e16467b7FC0CE040154457
   npx hardhat verify --network sepolia 0x12e061F229Fa34b444D6548E4f3ee4340249e7e2 0x5AdfE82772625E0337e16467b7FC0CE040154457 0xfd9125096DA61C2E88645036EB6C61Af45D4bd02
   ```

   Hace falta `SEPOLIA_RPC_URL` y `ETHERSCAN_API_KEY` en un `.env` local. No se
   commitean.

## Crear la próxima etiqueta

Un cambio de contrato desplegado exige redeploy, un JSON nuevo en
`docs/releases/` y un tag nuevo. No se mueve `v2.0.0`.

```bash
git tag -a v2.1.0 -m "Release v2.1.0 — <hito>. Sepolia: <direcciones>"
git push origin v2.1.0
```
