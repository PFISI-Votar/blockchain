# Política de seguridad

VOTAR es software electoral. Un defecto en un contrato puede ser irreversible
una vez desplegado. Pedimos reporte responsable: no publiques el detalle hasta
coordinar la corrección.

## Qué reportar

- Fallas de control de acceso, pausa, unicidad del sufragio o contadores.
- Caminos que vinculen la identidad del votante con el contenido del voto.
- Dependencia del deployer, del relayer o de una clave que no debería ser
  necesaria para operar el contrato.
- Secretos commiteados (`PRIVATE_KEY`, `ADMIN_PRIVATE_KEY`, RPC con API key).

No uses este canal para preguntas de despliegue. Abrí un issue normal.

## Cómo reportar

1. No abras un issue público ni un pull request con un exploit.
2. Usá el reporte privado de GitHub:
   <https://github.com/PFISI-Votar/blockchain/security/advisories/new>
3. Incluí contrato, tag (`v2.0.0` u otro), dirección en Sepolia si aplica,
   impacto y si el problema es explotable con una transacción.

Si ese canal no está habilitado, contactá a los maintainers de la organización
`PFISI-Votar` por un medio privado.

## Qué no hacer

- No explotes el hallazgo contra contratos ajenos ni contra un comicio en
  curso, ni siquiera en Sepolia, más allá de una transacción de confirmación.
- No publiques un advisory por tu cuenta antes de coordinarlo.

## Plazos de respuesta

| Hito                          | Plazo           |
| ----------------------------- | --------------- |
| Acuse de recibo               | 3 días hábiles  |
| Evaluación inicial de impacto | 10 días hábiles |
| Corrección, pausa o redeploy  | Según severidad |

En Sepolia, `PAUSER_ROLE` existe para detener operaciones. Una pausa no sustituye
el parche del fuente.

## Alcance

En alcance: los contratos y scripts de este repositorio, y las direcciones
publicadas en [docs/VERSIONADO.md](./docs/VERSIONADO.md).

Fuera de alcance: clientes de Ethereum, Etherscan y proveedores de RPC.

## Versiones

La etiqueta `v2.0.0` es el hito ligado al stack desplegado en Sepolia el
2026-08-10. No se reescriben tags publicados. Un fix de contrato implica un tag
nuevo y un redeploy documentado.
