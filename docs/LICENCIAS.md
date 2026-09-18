# Licencias de terceros

La restricción del proyecto es un stack **100% open source o de uso gratuito**.
Este repositorio se publica bajo MIT (`LICENSE`). OpenZeppelin Contracts v5,
Hardhat y el resto de dependencias de compilación entran en esa regla.

Las dependencias deben ser compatibles con ese modelo: OSI, FSF libre, dominio
público o una expresión SPDX que permita elegir una de esas licencias
(`MIT OR …`).

No se aceptan licencias propietarias, `UNLICENSED`, Business Source (`BUSL`),
SSPL, Elastic 2.0, Commons Clause ni Creative Commons no comercial / no
derivadas. MythX queda fuera de alcance por ser un servicio comercial
(VOTAR-351); el análisis estático usa Slither, que es open source.

Copyleft débil o fuerte (MPL, LGPL, GPL, AGPL) sigue siendo código abierto y
cumple la restricción de uso gratuito. Si aparece, se documenta en el PR.

## Verificación

```bash
npm ci
npm run licenses:check
```

El script lee `package-lock.json`. Si falta el identificador SPDX, busca el
archivo `LICENSE` en `node_modules` (por eso hace falta `npm ci`). Sale con
código 1 si hay una licencia no libre o un paquete sin metadato resoluble.

La integración continua ejecuta el mismo comando. Un auditor puede repetirlo en
cualquier clone; no hace falta FOSSA ni Snyk.
