# Cómo corren los tests de este proyecto

`npm test` **no** corre `node --test` directo — corre
`scripts/run-tests.js`, que:

1. Se conecta a Postgres (con las mismas credenciales de `.env` —
   `DB_HOST`/`DB_PORT`/`DB_USER`/`DB_PASSWORD`) y hace
   `DROP DATABASE IF EXISTS sicaber_test` + `CREATE DATABASE sicaber_test`.
   Una base **completamente nueva y vacía**, en cada corrida.
2. Arranca `src/index.js` como proceso aparte, con `DB_NAME=sicaber_test`
   y `PORT=4099` — un servidor dedicado, nunca el de desarrollo.
3. Espera a que ese servidor imprima `✅ Migraciones verificadas` (no
   solo a que responda algo: Express empieza a escuchar peticiones antes
   de que `config/db.js` termine de crear las tablas).
4. Corre `node --test --test-concurrency=1` contra ese servidor
   (`TEST_BASE_URL=http://localhost:4099/api`).
5. Al terminar (pase o falle la suite), mata el servidor de test. La base
   `sicaber_test` queda ahí tal cual — la próxima corrida la vuelve a
   destruir y crear desde cero, así que no hace falta limpiarla a mano.

## Por qué existe esto — causa raíz real (no hipotética)

Hasta la Ronda 15, `npm test` corría contra la **misma base de datos que
el servidor de desarrollo** (el único `DB_NAME` del `.env`, `sicaber`).
Cada corrida de la suite creaba insumos/productos/pedidos/ventas/compras
de prueba reales ahí — con nombres tageados (`... test aislamiento ...`,
`... test vaso-pitillo ...`, etc.) pero **datos reales en la base real**.

La mayoría de esos registros de prueba **no se podían borrar solos**: en
cuanto un insumo de prueba pasaba por una compra, o un producto de prueba
se vendía (los propios tests simulan una venta completa para probar el
descuento de stock), quedaban con una compra o una venta real asociada —
exactamente el mismo candado que protege datos reales de un local
(`DELETE /insumos/:id`, `DELETE /productos/:id`, etc. rechazan el borrado
si hay historial real). El `after()` de cada test lo intentaba y, al
fallar, desactivaba el registro en su lugar — así que quedaba vivo,
Inactivo, para siempre.

Confirmado en vivo (Ronda 14→15): el conteo de insumos de prueba subió de
25 a 71 entre una revisión y la siguiente, y los pedidos saltaron del
`#53` al `#99` — cada corrida de `npm test` (mía, en cada ronda de este
proyecto — corrí la suite decenas de veces) agregaba más basura real al
catálogo y al panel de administración, visible para cualquiera usando la
app de verdad.

**La solución no era "borrar mejor"** (eso solo pospone el problema hasta
la siguiente corrida) — era que los tests dejaran de escribir en la base
real. De las tres opciones evaluadas (base de datos dedicada,
transacciones con rollback por test, fixtures autolimpiables), se eligió
**base de datos dedicada**: los tests son de integración sobre HTTP real
(no acceden a Postgres directo salvo para preparar/verificar), así que
"una transacción por test" habría exigido reescribir cómo el pool de
`config/db.js` maneja conexiones (una transacción persistente compartida
entre el proceso de test y el servidor, algo que el pooling normal de
`pg` no da gratis) — mucho más invasivo que apuntar todo el server a otra
base y destruirla en cada corrida.

## `--test-concurrency=1`: por qué NO es opcional

`node --test` corre los **archivos** de test en paralelo por defecto (no
solo los tests dentro de un mismo archivo). Ningún archivo de esta suite
está aislado de los demás — **todos comparten la misma `sicaber_test`**,
y varios leen o escriben tablas **globales completas**, no solo sus
propias filas:

- `test/contadores-y-borrado-local.test.js` compara "cuántos insumos hay
  en total" entre dos locales — un número que cambia si CUALQUIER otro
  archivo crea o borra un insumo mientras tanto.
- `POST /insumos` siembra una fila de `insumo_local` por CADA local
  existente; `POST /locales` siembra una fila por CADA insumo existente
  — si otro archivo borra un local/insumo justo en medio de esa siembra,
  es una carrera real (ya se corrigió el 500 que causaba — ver
  CAMBIOS.md — pero el RESULTADO final seguiría dependiendo del orden).
- Varios archivos usan `GET /locales/todos` y asumen "al menos N locales
  Activos" — si otro archivo desactivó uno a mitad de camino, la cuenta
  cambia.

Esto se comprobó en vivo: con concurrencia por defecto, la suite falló de
forma intermitente (no siempre, solo cuando el timing de dos archivos se
cruzaba mal) con errores de violación de FK y aserciones de conteo
incorrectas — el mismo síntoma clásico de una condición de carrera, no un
bug de producto. `--test-concurrency=1` hace que los archivos corran uno
a la vez, eliminando la carrera de raíz.

**No lo quites** para "acelerar" la suite sin antes aislar cada archivo
de verdad (medio ambiente por archivo, o `TRUNCATE` de las tablas
compartidas entre archivos) — si no, vuelve el mismo flakiness.

## Cómo restaurar la base de desarrollo desde un respaldo

Las migraciones de baja destructivas (ver `config/db.js`) guardan un
respaldo JSON en `respaldo-migraciones/` (gitignored — puede contener
PII) antes de soltar una columna con datos reales. Para restaurar un
valor puntual desde ahí:

```js
const fs = require('fs');
const filas = JSON.parse(fs.readFileSync('respaldo-migraciones/<archivo>.json'));
// filas es un array de objetos con los valores de antes del borrado —
// revisar su forma exacta (cada respaldo documenta sus propias columnas)
// y reinsertar a mano por "id" con una consulta UPDATE puntual.
```

No hay un script de restauración automática — son respaldos de
"por si acaso", pensados para consulta manual, no para un rollback de un
clic (la migración que los generó documenta, en su propio comentario en
`config/db.js`, qué se guardó y por qué).

## Correr un archivo de test manualmente contra un servidor ya levantado

`scripts/run-tests.js` es lo que corre `npm test`, pero cada archivo
también puede correr suelto contra un servidor que ya esté arriba (útil
para iterar rápido en un solo archivo):

```
TEST_BASE_URL=http://localhost:4099/api node --test test/nombre-del-archivo.test.js
```

(o contra el servidor de desarrollo normal, en `http://localhost:4000/api`
— pero entonces sí volvería a escribir en la base real; solo para
depurar puntualmente, nunca como corrida habitual).
