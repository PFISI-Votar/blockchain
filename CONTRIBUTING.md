# Cómo contribuir

Gracias por auditar o mejorar **VOTAR — Blockchain**. Este repositorio es
software electoral open source (MIT). Las contribuciones se publican bajo la
misma licencia: al enviar un pull request aceptás esos términos.

## Qué se espera de una colaboración

- Discutí cambios grandes en un issue antes de abrir un PR amplio.
- No abras un issue público para vulnerabilidades. Usá [SECURITY.md](./SECURITY.md).
- No incluyas secretos, `.env`, `PRIVATE_KEY` ni claves de deployer.
- No cambies los parámetros del compilador (`0.8.26`, optimizer `runs: 200`,
  `cancun`) sin documentar el impacto sobre el bytecode ya desplegado en Sepolia.
- Mantené el alcance chico y alineado a una historia (convención `VOTAR-NNN`).

## Ramas

| Rama     | Rol                                                           |
| -------- | ------------------------------------------------------------- |
| `master` | Versión estable publicada. Es la rama por defecto de GitHub. |
| `dev`    | Integración. Los pull requests se abren contra `dev`.        |

Nombres de rama:

- `feature/votar-NNN-descripcion-breve`
- `fix/votar-NNN-descripcion-breve`

Los hitos de release usan tags `vMAJOR.MINOR.PATCH` y se vinculan a los
contratos de Sepolia en [docs/VERSIONADO.md](./docs/VERSIONADO.md).

## Entorno

```bash
git clone https://github.com/PFISI-Votar/blockchain.git
cd blockchain
git checkout dev
npm ci
npm run compile
npm test
```

Compilar y testear no requiere `.env`. El despliegue a Sepolia sí: copiá
`.env.example` y no lo commitees.

## Antes de abrir el pull request

```bash
npm run compile
npm test
npm run licenses:check
```

## Revisión

El equipo Five Stack (UTN FRVM) revisa los pull requests. No hagas merge de tu
propia rama. Un cambio de contrato desplegado exige redeploy, actualización del
catálogo en `docs/releases/` y un tag nuevo. No reescribas una etiqueta ya
publicada.
