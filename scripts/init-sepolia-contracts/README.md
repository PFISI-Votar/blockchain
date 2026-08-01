# init-sepolia-contracts

Scripts para inicializar el entorno de Sepolia testnet del proyecto VOTAR.

## Estructura de repositorios requerida

Los tres repos deben estar en la **misma carpeta raíz**, con estos nombres exactos:

```
Repositorios/       → La raíz puede tener cualquier nombre
 ┣ back/
 ┣ blockchain/      ← estás aquí
 ┗ front/
```

## Scripts disponibles

| Script | Descripción |
|--------|-------------|
| `setup-sepolia.ts` | **Script principal.** Genera wallet, configura todos los `.env`, despliega contratos y otorga permisos. |
| `show-wallet.ts` | Muestra la dirección de la multisig wallet y los links de los faucets. |
| `inspect-election.ts` | Dado un Election ID, muestra las addresses de Ballot, VoteRegistry y AuditView. |


## Paso a paso completo

### 1 · Crear una app en Alchemy

1. Ir a [https://www.alchemy.com/](https://www.alchemy.com/) y loguearse (o crear cuenta).
2. Ir a [https://dashboard.alchemy.com/apps/new](https://dashboard.alchemy.com/apps/new).
3. En **Choose chains**, seleccionar **Ethereum**. Verificar que diga *Sepolia* en la descripción.
4. En **Activate services**, seleccionar: **Webhooks**, **Websockets** y **Node API**.
5. Crear la app.
6. Una vez creada, verificar que el **Network** sea **Ethereum Sepolia**. Si no lo es, cambiarlo en el desplegable.
7. Hacer click en **Send request** y verificar que el response sea:
   ```json
   { 
      "jsonrpc": "2.0", 
      "id": 1, 
      "result": "0x..." 
   }
   ```
8. Copiar el **Endpoint URL**. Debe tener el formato:
   ```
   https://eth-sepolia.g.alchemy.com/v2/XXXXXXXXXXXX
   ```
   > ⚠️ Si la URL no contiene `eth-sepolia`, repetir a partir del paso 6.


### 2 · Ejecutar el script de setup

> ⚠️ Antes de empezar, asegurate que todos los repos tengan su .env.example, tal cual como está en Github (con placeholders y todo).

> ⚠️ Si tus credenciales de la base de datos votar son distintas a la del .env.example, copialo y creá un .env con las credenciales de DB correctas.

Desde el repositorio `blockchain/`, ejecutar:

```bash
npx ts-node scripts/init-sepolia-contracts/setup-sepolia.ts https://eth-sepolia........
```

El script va a:

1. Validar la URL de Alchemy.
2. Generar una nueva wallet (address + private key).
3. Escribir las variables necesarias en `blockchain/.env`, `back/.env` y `front/.env`.
   - Si algún `.env` no existe, lo copia desde `.env.example` antes de modificarlo.
4. Ejecutar `deploy-sepolia-stack.ts --network sepolia`. Para ello tenés que cargar fondos en tu wallet (seguí el instructivo que se muestra)
5. Parsear las addresses resultantes del deploy y escribirlas en `back/.env`.
6. Ejecutar los scripts de grant (`grant-election-admin-local.ts` y `grant-roles-dev.ts`).
7. Ejecutar `npm run sync:election-factory` en `back/`.
8. Mostrar la dirección de la wallet y los links de los faucets.

> ⏱️ El deploy puede tardar varios minutos dependiendo de la congestión de la red.



### 3 · Cargar fondos en la wallet

Durante el setup, el script muestra la dirección de tu multisig wallet. **CARGALE ETH para poder operar** (deploy-sepolia-stack.ts, crear comicios, votar, etc.).

► Faucets recomendados:

- **🔵 Google**: 0,05 ETH cada 24hs  
  [https://cloud.google.com/application/web3/faucet/ethereum/sepolia](https://cloud.google.com/application/web3/faucet/ethereum/sepolia)

- **🐱 Nyan Cat**: ~0,05 ETH cada 10 minutos (minando en background)  
  [https://sepolia-faucet.pk910.de/](https://sepolia-faucet.pk910.de/)


► Listados de faucets:
- [https://github.com/Mock-DAO/Awesome-List-of-Sepolia-Faucets](https://github.com/Mock-DAO/Awesome-List-of-Sepolia-Faucets)
- [https://github.com/arddluma/awesome-list-testnet-faucets](https://github.com/arddluma/awesome-list-testnet-faucets)


Copiá la dirección que muestra el script en cualquiera de los dos links para cargarlo. Si no sabés tu adress, seguí leyendo, abajo hay un script que te lo dice.

Comprobá los fondos de la wallet accediendo a este enlace, o bien asociándola en **Metamask**
- [https://sepolia.etherscan.io/address/TU_ADDRESS](https://sepolia.etherscan.io/address/TU_ADDRESS)


## Scripts adicionales

### Ver la wallet en cualquier momento

```bash
npx ts-node scripts/init-sepolia-contracts/show-wallet.ts
```

Muestra la `ADMIN_MULTISIG_ADDRESS` configurada y los links de los faucets.


### Inspeccionar contratos de un comicio

> ⚠️ Prerequisito: tener al menos un comicio creado y oficializado en la app.

```bash
npx ts-node scripts/init-sepolia-contracts/inspect-election.ts <ELECTION_ID>
```

**Ejemplo:**
```bash
npx ts-node scripts/init-sepolia-contracts/inspect-election.ts 2
```

El script va a:
1. Leer `ELECTION_FACTORY_ADDRESS` de `back/.env` (o pedírtela si no la encuentra).
2. Conectarse a Sepolia via Alchemy.
3. Consultar el contrato y mostrar las addresses de **Ballot**, **VoteRegistry** y **AuditView** del comicio.
4. Mostrar los links de Etherscan para cada contrato.

```bash
npx ts-node scripts/init-sepolia-contracts/inspect-election.ts
```

La ID del comicio es la ID que aparece en el front cuando lo creás. Sino también podés buscarlo en PSQL:
```PSQL
votar=# SELECT * FROM eleccion;
```

## Variables de entorno que configura el setup

### `blockchain/.env`

| Variable | Origen |
|----------|--------|
| `SEPOLIA_RPC_URL` | URL de Alchemy que pasaste como argumento |
| `PRIVATE_KEY` | Wallet generada automáticamente |
| `ADMIN_MULTISIG_ADDRESS` | Wallet generada automáticamente |
| `GRANT_TARGET` | Wallet generada automáticamente |

### `back/.env`

| Variable | Origen |
|----------|--------|
| `SEPOLIA_RPC_URL` | URL de Alchemy |
| `MERKLE_UPDATER_PRIVATE_KEY` | Wallet generada |
| `ELECTION_ADMIN_PRIVATE_KEY` | Wallet generada |
| `AUDIT_VIEW_ADDRESS` | Address de la wallet |
| `RECIBO_SIGNING_PRIVATE_KEY` | Private key generada |
| `MERKLE_ROOT_STORE_ADDRESS` | Output del deploy |
| `ELECTION_FACTORY_ADDRESS` | Output del deploy |

### `front/.env`

| Variable | Origen |
|----------|--------|
| `VITE_RPC_URL` | URL de Alchemy |
| `VITE_CHAIN_ID` | `11155111` (Sepolia) |
| `VITE_VOTE_TRANSMITTER_PRIVATE_KEY` | Wallet generada |
| `VITE_AUDIT_VIEW_ADDRESS` | Address de la wallet |

> Todas las demás variables que ya existan en los `.env` no son modificadas.
