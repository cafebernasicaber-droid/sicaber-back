# Cambios aplicados

## Ronda 11 (esta entrega) — Corrección de un bug propio: selectores de local rotos

### Causa raíz (punto 1)

`GET /locales` es el ÚNICO endpoint de "locales activos" que existe — lo
consumen tanto el checkout público como los selectores internos de
Compras e Insumos (no hay uno separado por consumidor). La Ronda 10
agregó ahí un filtro `direccion <> '(Pendiente de completar...)'`,
pensado solo para no mostrarle al cliente un local sin dirección real en
el checkout. Como Villa Liliam y 3 Esquinas quedaron con ESE TEXTO EXACTO
en `direccion` (backfill de esa misma ronda) + `NOT NULL`, el filtro los
excluía — y al ser el único endpoint, rompió también los selectores de
Compras e Insumos, que nunca debieron estar sujetos a esa regla. Solo
"cwece" (el único con dirección real) seguía apareciendo. Confirmado en
vivo antes de tocar nada: `GET /locales` devolvía 1 de 3 activos;
`GET /locales/todos` (admin, sin ese filtro) sí devolvía los 4.

Sí, el placeholder se había guardado como VALOR REAL de la columna — el
error de diseño exacto que se sospechaba.

### Corrección

- **`locales.direccion` vuelve a ser NULLABLE** (se revierte el `NOT
  NULL` de la Ronda 10) — un registro existente incompleto nunca debe
  desaparecer de ningún listado ni bloquear ninguna operación. La
  dirección obligatoria se mantiene, pero SOLO como validación de
  aplicación al crear/editar (`POST`/`PUT /locales`, sin cambios ahí).
- El placeholder se limpia de vuelta a `NULL`.
- **`direccionPendiente` calculado** (`direccion IS NULL`) en `GET
  /locales` y `GET /locales/todos` — no se agrega una columna nueva
  porque el dato ya está 100% implícito en si `direccion` es NULL;
  guardar los dos sería la misma información dos veces, con riesgo real
  de que queden desincronizados. Nunca más un texto de interfaz dentro
  del dato.
- `GET /locales` deja de filtrar por dirección — devuelve TODOS los
  locales Activos, completos o no.

### Punto 2 — insumo_local para los 3 locales activos + el inactivo

Auditoría: 49/49/49/49 insumo_local por local tras la corrección (antes:
un hueco puntual en el local inactivo). La causa era literal:
`asegurarInsumoLocalEnTodosLosLocales()` y `POST /insumos` solo
sembraban filas para locales con `estado='Activo'` — un local que se
desactiva después de crear un insumo se queda con un hueco para
cualquier insumo nuevo posterior. Se corrigió para cubrir TODOS los
locales (activos e inactivos): un local inactivo igual conserva su
stock/historial en solo lectura, así que también debe tener su fila.

El contador `insumosConStock` de `GET /locales/todos` YA calculaba bien
(verificado en vivo: 47/47/47/46 antes de esta corrección) — si la
tarjeta de Locales muestra "—", no es este endpoint: revisa que esa
vista esté llamando a `GET /locales/todos` (con esos campos) y no a
`GET /locales` (el selector, que nunca los tuvo) — no lo pude confirmar
desde este repo, que es solo backend.

### Archivos modificados

`src/config/db.js`, `src/routes/index.js`, `test/inventario-por-local.test.js`
(ajustado: ahora espera fila en TODOS los locales, no solo activos), y el
nuevo `test/locales-selector.test.js`.

### Migración + rollback

Revierte la de la Ronda 10: `UPDATE locales SET direccion = NULL WHERE
direccion = '(Pendiente de completar...)'; ALTER TABLE locales ALTER
COLUMN direccion DROP NOT NULL;`. Rollback (volver a lo que causó el
bug — no recomendado): re-aplicar el `UPDATE`+`SET NOT NULL` de la Ronda
10.

### Endpoints cambiados

- `GET /locales` — ya no filtra por dirección; agrega `direccionPendiente`.
- `GET /locales/todos` — agrega `direccionPendiente`.
- `POST /insumos` — ahora siembra `insumo_local` en TODOS los locales
  (antes, solo los Activos).

### Evidencia

- `GET /locales` antes: `[cwece]` (1 de 3). Después: `[Local Villa
  Liliam, Local 3 Esquinas, cwece]` (3 de 3), con `direccionPendiente`
  correcto en cada uno.
- `GET /locales/todos`: `insumosConStock` real en los 4 locales (49 en
  cada uno, incluido el inactivo).
- `npm test` — **11/11 passing** (8 anteriores + 3 nuevos de este
  selector).

---

## Ronda 10 (esta entrega) — Locales: dirección obligatoria y teléfono validado

Los 3 puntos pedidos: local obligatorio en Compras, dirección/teléfono en
Locales, y un solo endpoint de creación de pedido. Los dos primeros de
esos tres YA estaban completos desde rondas anteriores (verificado en vivo
otra vez, ver evidencia) — el trabajo real de esta ronda fue el modelo de
Local.

### 1 y 3. Ya implementados — solo se re-verificó

- **Compras**: `local_id` ya era obligatorio, ya validaba local Activo, ya
  sumaba stock SOLO en `insumo_local` de ese local, ya registraba el
  movimiento con su `local_id`, ya filtraba por `?local_id=` en `GET
  /compras` y `/compras/historial`, y ya devolvía `localId`/`localNombre`
  en el detalle. Sin cambios de código — re-probado en vivo (ver evidencia).
- **Pedidos**: sigue habiendo un único `POST /pedidos` (con `authOpcional`)
  para Admin, Cajero y cliente/landing — no había ningún segundo endpoint
  que consolidar. Re-probado en vivo con ambos roles.

### 2. Locales — dirección obligatoria, teléfono validado

- `direccion`: pasa a ser obligatoria (antes aceptaba vacío — por eso el
  listado mostraba "—"). Se valida igual que un nombre (no vacía, no solo
  espacios, hasta 500 caracteres).
- `telefono`: sigue opcional, pero ahora se valida el FORMATO — acepta el
  prefijo +57 y separadores (espacios, guiones, paréntesis); sin ellos,
  exige entre 7 y 10 dígitos reales.

### Archivos modificados

`src/config/validaciones.js` (nuevo `errorTelefono`), `src/config/db.js`
(migración), `src/config/schema.sql`, `src/routes/index.js`.

### Migración + rollback

`locales.direccion` pasa a `NOT NULL`. Los dos locales sembrados (Local
Villa Liliam, Local 3 Esquinas) no tenían dirección real cargada —
**estrategia elegida: backfill con un placeholder EXPLÍCITAMENTE marcado
como pendiente** (`"(Pendiente de completar — actualízala en Empleados >
Locales)"`), aplicando el `NOT NULL` de inmediato, en vez de la alternativa
de dejarlo pendiente hasta que alguien lo complete desde la interfaz (esa
alternativa deja la garantía de la base de datos sin aplicarse
indefinidamente). Para que ese placeholder nunca se le muestre a un
cliente como si fuera una dirección real, **`GET /locales` (el selector
público de "recoger en el local") ahora excluye cualquier local que
todavía lo tenga** — `GET /locales/todos` (admin) lo sigue mostrando tal
cual, como recordatorio de que falta completarlo. Rollback: `ALTER TABLE
locales ALTER COLUMN direccion DROP NOT NULL;` (opcionalmente, `UPDATE
locales SET direccion = NULL WHERE direccion = '(Pendiente de completar
— actualízala en Empleados > Locales)'` para limpiar el placeholder).

### Endpoints cambiados

- `POST/PUT /locales` — `direccion` ahora obligatoria; `telefono` valida
  formato (400 si no cumple).
- `GET /locales` (público) — excluye locales con la dirección todavía
  pendiente.

### Evidencia

- Local sin dirección → `400`. Local con teléfono inválido ("abc123") →
  `400`. Local con dirección y teléfono válidos (`+57 300 123 4567`) →
  `201`.
- Compra sin `local_id` → `400` con `requiereSeleccionLocal:true`.
- Compra en "Local Villa Liliam": Café molido `{Villa Liliam: 0, 3
  Esquinas: 0}` → compra de 2 → `{Villa Liliam: 2, 3 Esquinas: 0}` →
  anulada → vuelve a `{0, 0}`. Respuesta trae `localId`/`localNombre`.
- Mismo `POST /pedidos`: Cajero mandando `local_id`/`atendido_por` ajenos
  → se guardan los SUYOS (`local_id:3, atendido_por:4`, ignorando lo que
  mandó); Administrador con el mismo endpoint → lo elegido se respeta
  (`local_id:4`).
- `npm test` — **8/8 passing** (sin cambios en la suite: nada de esto
  tocó insumo_local/ventas).

---

## Post-Ronda 9 — Limpieza: dos columnas zombi en cada arranque

Verificación de rutina (reinicio del servidor tras la Ronda 9): el log de
arranque mostraba un error y un mensaje de "columna duplicada eliminada"
en CADA reinicio, no solo el primero. Encontré dos pasos de `alters` que
seguían agregando una columna vieja que otro paso, más abajo, ya se
encarga de renombrar/retirar — mismo patrón que ya se había corregido una
vez con `es_adicion_sin_costo`:

- `ALTER TABLE pedidos ... SET domiciliario_id = ...` — `domiciliario_id`
  se DROPEÓ del todo en la Ronda 7 (el sistema no maneja domiciliarios);
  este paso quedó huérfano y fallaba ("no existe la columna
  domiciliario_id") en cada arranque. Se quitó — no hace falta rollback,
  no crea ni borra nada, solo dejaba de intentar un UPDATE imposible.
- `ALTER TABLE fichas_tecnicas ADD COLUMN IF NOT EXISTS vaso_id` — al
  existir junto con el paso de renombrado `vaso_id → vaso_insumo_id` (Ronda
  9), cada arranque volvía a crear `vaso_id` (vacía) y el paso de
  renombrado la volvía a eliminar — un ciclo crea/borra silencioso pero
  innecesario. Se quitó ese `ADD COLUMN`, y el paso de renombrado ahora
  cubre el tercer caso (ninguna de las dos existe → crea `vaso_insumo_id`
  directo, para instalaciones nuevas que nunca pasaron por `vaso_id`).

Verificado: reinicio limpio, sin errores ni mensajes de limpieza
repetidos; `npm test` — 8/8 passing.

## Ronda 9 (esta entrega) — Vaso/pitillo en ficha técnica, flujo de estados, dashboard, buscadores

### 1 y 2. Diagnóstico de los buscadores truncados

Revisé `GET /insumos` a fondo y lo probé en vivo con las combinaciones
reales que usarían los selectores de Ficha Técnica: `estado=Activo` (41
resultados), `tipo=insumo` (41), `tipo=topping` (3), `local_id=` de cada
local activo, `q=` con término amplio. **En ningún caso encontré límite
fijo, paginación implícita, filtro de local heredado, filtro de categoría,
ni un WHERE residual** — la consulta no tiene `LIMIT` y ninguna rama del
código recorta el arreglo salvo por lo que el propio caller pide. Con la
base actual, el endpoint ya devuelve el conjunto completo en todos los
casos.

**Conclusión**: el límite de "2 resultados" no viene de esta ruta tal como
existe hoy. O era un comportamiento de una versión anterior del endpoint
(antes de la reescritura de la Ronda 6, que ya quitó ese tipo de límite),
o es un límite del lado del FRONTEND (tamaño de página de un selector,
`.slice`, caché de un fetch viejo) que no puedo confirmar ni corregir
desde este repo — es solo el backend. Lo que sí agregué, para que un
límite nunca vuelva a ser silencioso: paginación real y EXPLÍCITA
(`?limit=&offset=`), opcional — sin ella, sigue devolviendo todo.

Para el buscador de Toppings específicamente: `?tipo=topping` ya consulta
`es_topping` (el valor correcto tras la corrección de tipos de uso de la
ronda anterior) y devuelve los 3 insumos realmente marcados — verificado.

### 3 y 4. Vaso y pitillo: insumos normales en la ficha técnica

Se agregó `vaso_insumo_id`, `cantidad_vaso`, `lleva_pitillo`,
`pitillo_insumo_id`, `cantidad_pitillo` a `fichas_tecnicas`. Ambos son
insumos NORMALES (nunca un tipo especial ni la entidad "empaques" de una
ronda anterior, que sigue existiendo pero sin ninguna fila real cargada).
El vaso pasó de obligatorio a opcional; si se manda, exige su cantidad. El
pitillo es condicional: `lleva_pitillo=true` exige `pitillo_insumo_id` +
`cantidad_pitillo`; en `false` ambos quedan en `NULL` sin importar qué
mande el body. Al vender, ambos se descuentan como cualquier ingrediente
de la receta — únicamente en el local de la venta, con la misma regla de
"no bloquea si falta stock" que ya aplicaba al resto.

### 5. Validación de cantidad por unidad en insumos Y toppings de la ficha

`validarLineasInsumo` (usada tanto para los insumos de la receta como para
los toppings propios de la ficha) ahora exige enteros cuando la unidad del
insumo es "unidad", decimales para el resto — antes solo se pedía
"mayor a 0", sin mirar la unidad real de cada insumo.

### 6. Insumo en "Todos los locales"

`POST /insumos` acepta `todosLosLocales: true`: todas las filas de
`insumo_local` (una por cada local activo, como ya se generaban desde la
Ronda 8) quedan con `activo=true`. Sin el flag, solo el local elegido
queda activo (el resto existe en 0, pero `activo=false`). La respuesta
siempre trae `porLocal[].activo` para que el front lo muestre al editar.

### 7. Flujo de estados de pedido — auditoría

La máquina de estados (`pendiente_verificacion → pendiente → en_proceso →
en_camino('Listo') → entregado`, con `cancelado` alcanzable desde
cualquier estado previo a `entregado`) ya rechazaba retrocesos y saltos
sin pago confirmado — verificado en vivo (ver evidencia). El problema real
estaba en los **contadores del Dashboard** (`GET /pedidos/stats`):

- `total` filtraba `estado <> 'anulado'` — **'anulado' nunca fue un
  estado válido de pedido** (los reales son los de arriba + `cancelado`;
  probablemente copiado del dominio de Compras, que sí usa 'anulada'). El
  filtro era un no-op: `total` contaba TODO, incluidos `entregado` y
  `cancelado`, quedando desfasado contra la suma de las otras tarjetas
  (pendiente + porVerificar + proceso + listo, mutuamente excluyentes).
  Ahora `total` es exactamente esa suma.
- `ventas` (ingresos de hoy) sumaba `pedidos.total` de cualquier pedido de
  hoy no cancelado — **incluidos los que ni siquiera pasaron por caja**
  (sin pago confirmado, sin venta real creada). Ahora suma de la tabla
  `ventas` (solo existe una fila ahí cuando el pedido se marcó
  'entregado'), igual que ya hace `GET /ventas/stats`.

**Pedidos atascados o mal contados que encontré**: el pedido **#18** lleva
2 días en `en_camino` (pago por Nequi ya confirmado) — no lo puedo
avanzar/cancelar por mi cuenta, es una decisión operativa, así que solo lo
reporto. El pedido **#1** (`entregado`, del 2026-09-02) no tenía ninguna
fila en `ventas` — de antes de que existiera la creación automática de
venta al entregar. Se completó su fila de `ventas` (con la fecha real del
pedido, para no inflar "ventas de hoy") **sin** recalcular inventario
(ese movimiento, si ocurrió, ya pasó hace días).

### 8. Dashboard: se retira "Insumos — stock bajo"

`GET /insumos/alertas-stock` se eliminó — nada más en el backend lo
consumía. El resto de "stock bajo" sigue disponible donde hace falta:
`GET /insumos?stockBajo=true` y `GET /insumos/:id`.

### Archivos modificados

`src/config/db.js`, `src/config/schema.sql`, `src/routes/index.js`,
`test/inventario-por-local.test.js` (ajustado a la nueva forma de vaso) y
el nuevo `test/ficha-vaso-pitillo.test.js`.

### Migraciones + rollback

- `fichas_tecnicas`: nuevas columnas `cantidad_vaso`, `lleva_pitillo`,
  `pitillo_insumo_id` (+ FK), `cantidad_pitillo`. Rollback: `DROP COLUMN`.
- Rename `vaso_id` → `vaso_insumo_id` (mismo patrón guardado que
  `es_adicion` de la ronda pasada) + backfill `cantidad_vaso=1` en las
  fichas que ya tenían vaso (antes el descuento era fijo en 1 unidad, sin
  poder configurarse). Rollback: `ALTER TABLE fichas_tecnicas RENAME
  COLUMN vaso_insumo_id TO vaso_id;`.
- Backfill de `ventas` faltantes para pedidos `entregado` sin venta.
  Rollback: `DELETE FROM ventas WHERE created_at >= '<fecha de esta
  migración>' AND pedido_id = 1` (o el id puntual que corresponda).

### Endpoints cambiados

- `GET /insumos` — nuevo `?unidad=` (con alias "onzas"→'oz',
  "unidades"→'unidad', requisito 3) y `?limit=&offset=` (paginación
  explícita opcional).
- `POST /insumos` — nuevo `todosLosLocales: true`.
- `POST/PUT /fichas-tecnicas` — nuevo contrato de vaso/pitillo (ver
  arriba); `vaso_id` se sigue aceptando como alias de `vaso_insumo_id`.
- `GET /insumos/alertas-stock` — eliminado.

### Evidencia

- **Buscadores**: `GET /insumos?estado=Activo` → 41/41; `?tipo=topping` →
  3/3 (los realmente marcados). Sin límite en ningún caso probado.
- **Ficha con vaso y pitillo**: test automatizado `la ficha técnica guarda
  vaso y pitillo correctamente` — PASS.
- **Venta descuenta vaso y pitillo, antes/después, local correcto**: test
  automatizado `una venta descuenta el vaso y el pitillo del stock del
  local correcto` — PASS (vaso -8oz, pitillo -1unidad, ingrediente -1kg,
  otro local en 0).
- **Transición ilegal rechazada**: pedido en `en_proceso` → intento de
  volver a `pendiente` → `409` con `estadoActual`/`estadoSolicitado`.
- **"Todos los locales"**: insumo creado con `todosLosLocales:true` →
  `activo:true` en los 3 locales activos existentes; sin el flag,
  `activo:true` solo en el elegido.
- **Tests automatizados**: `npm test` — **8/8 passing** (5 de aislamiento
  por local + 3 de vaso/pitillo).

---

## Ronda 8 (esta entrega) — Cobertura total de insumo_local, estado nunca sumado, "tipo de uso" corregido, tests

### 0. Reporte de la auditoría "tipo de uso" — ANTES de tocar nada

Definiciones dadas: **Topping** = adición GRATUITA y opcional en la ficha
técnica. **Adición** = extra que el cliente agrega y que SÍ tiene costo.

Lo que encontré, cruzando los FLAGS del insumo (`es_topping`,
`es_adicion_sin_costo`) contra el uso REAL en las tablas `toppings` y
`adiciones` (no solo la etiqueta del formulario):

- Las tablas `toppings` (nunca tuvo columna de precio) y `adiciones`
  (columna `precio`, sus 11 filas reales tienen entre $1.000 y $2.000) YA
  reflejan correctamente la definición: topping = gratis, adición = con
  costo. **No están invertidas.**
- **Ningún insumo tenía los dos booleanos genuinamente cruzados**: verifiqué
  cada insumo referenciado de verdad por `toppings.insumo_id` (Crema
  chantilly, hielo, chispas) — ninguno tenía `es_adicion_sin_costo=true`: no
  hay un swap real de datos que revertir.
- El problema real era el **nombre de la columna**: `es_adicion_sin_costo`
  ("adición SIN costo") contradice la propia definición de Adición (que por
  definición SÍ tiene costo) — es una etiqueta que se contradice a sí misma,
  no un valor invertido.
- Efecto colateral que sí encontré y corregí: 2 insumos (Crema chantilly,
  hielo) YA estaban usados por un topping real pero nunca quedaron marcados
  `es_topping=true` (la marca es informativa, nunca condicionó el descuento
  de stock — por eso pasó desapercibido).

**Conclusión y acción — para no invertir nada dos veces**: esto es un
RENAME (`es_adicion_sin_costo` → `es_adicion`, mismos valores, sin swap) +
un backfill puntual (encender `es_topping` en los 2 insumos que faltaban),
no una inversión de datos. Ver migración abajo.

### 1. Archivos modificados

| Archivo | Cambio |
|---|---|
| `src/config/db.js` | Rename `es_adicion_sin_costo`→`es_adicion` (+ backfill de `es_topping`); nueva `asegurarInsumoLocalEnTodosLosLocales()` (cobertura 100% insumo×local activo). |
| `src/config/schema.sql` | Columna `es_adicion` directo (instalaciones nuevas). |
| `src/routes/index.js` | `POST /insumos` crea fila en TODOS los locales activos (no solo el elegido); `POST /locales` propaga a insumos existentes; `GET /insumos` con `?incluirInactivos=` y sin `estadoStock` sumado a nivel consolidado; filtro `?tipo=adicion` (antes `adicion_sin_costo`). |
| `package.json` | Nuevo script `test`. |
| `test/inventario-por-local.test.js` | **Nuevo** — 5 tests de integración del aislamiento por local (requisito 3). |

### 2. Migraciones (en `config/db.js`, idempotentes) + rollback

- **Rename `insumos.es_adicion_sin_costo` → `es_adicion`** (guardado: Postgres no tiene `RENAME COLUMN IF EXISTS`, se verifica el estado de ambas columnas a mano). Incluye limpieza de un efecto secundario real: el paso histórico que agregaba la columna vieja seguía en el arreglo de "alters" y la resucitaba en cada arranque DESPUÉS de renombrada, dejando una columna zombi siempre en `false` — se quitó ese paso y se agregó un DROP guardado para instalaciones que ya la tuvieran duplicada. Rollback: `ALTER TABLE insumos RENAME COLUMN es_adicion TO es_adicion_sin_costo;` (mismos valores, ningún dato se pierde).
- **Backfill `es_topping=true`** para insumos usados por un topping real que no lo tenían marcado. Rollback: no aplica un revert automático (encender un flag informativo no es destructivo); si hiciera falta, `UPDATE insumos SET es_topping=false WHERE id IN (10,32)`.
- **`asegurarInsumoLocalEnTodosLosLocales()`**: completó 67 filas de `insumo_local` que faltaban (insumos×locales activos sin fila — 39 insumos × 3 locales activos = 117 esperadas, solo 50 existían). Rollback: `DELETE FROM insumo_local WHERE stock = 0 AND created_at >= '<fecha de esta migración>'` (borra solo las filas en 0 recién creadas; cualquier ajuste manual posterior ya no calzaría con ese filtro, así que hazlo pronto si necesitás revertir).

### 3. Endpoints cambiados

- **`POST /insumos`** — ahora crea una fila de `insumo_local` por **cada local Activo** (antes solo el elegido); el resto arranca en `stock_actual=0` con el mismo `stock_minimo` como valor heredado.
- **`POST /locales`** — ahora propaga automáticamente: crea la fila de `insumo_local` (stock 0) para cada insumo ya existente.
- **`GET /insumos`** — nuevo `?incluirInactivos=true` (por defecto, los locales Inactivos no aparecen en el `porLocal` consolidado ni suman al total — quedan "ocultos" pero sus datos NO se borran, ver `GET /insumos/:id`). El nivel consolidado (`local_id=all` u omitido) **ya no trae `estadoStock`** propio (nunca se calcula sumando locales — solo cada entrada de `porLocal` tiene el suyo). `?tipo=adicion` reemplaza a `?tipo=adicion_sin_costo`.
- **`GET /insumos/:id`** — sigue trayendo TODOS los locales (activos e inactivos: el histórico de un local desactivado se conserva y es consultable), cada uno con `localEstado` y su `estadoStock` individual.

### 4. Evidencia

- **117/117 filas de insumo_local**: 39 insumos × 3 locales activos, cero huecos tras la migración (antes: 50/117).
- **Cantidades independientes**: insumo de prueba con 10 kg en un local y 5 kg en otro (test automatizado, ver abajo).
- **Compra en un solo local**: antes `{A:10, B:0}` → compra de 4 kg en A → `{A:14, B:0}` → anulada → `{A:10, B:0}`.
- **Venta descuenta solo su local**: pedido entregado en el local A con una ficha que consume 3 (2 ingrediente + 1 vaso) → A baja en 3, B sin cambios.
- **Estado nunca sumado**: `GET /insumos/:id?local_id=all` no trae `estadoStock` en el nivel superior; cada `porLocal[i].estadoStock` se calcula individualmente.
- **Tests automatizados**: `npm test` (requiere el servidor corriendo) — **5/5 passing**, cubriendo exactamente los 4 puntos anteriores contra la API real.

---

## Ronda 7 (esta entrega) — Sin domiciliario, pedido único Admin/Cajero, insumos 100% por local

### 1. Archivos modificados

| Archivo | Cambio |
|---|---|
| `src/middleware/auth.js` | Nuevo `authOpcional` (decodifica el JWT si viene, nunca exige uno) — usado por `POST /pedidos`. |
| `src/config/db.js` | `DROP COLUMN pedidos.domiciliario_id`; nueva `asegurarInsumoLocalParaTodos()` (asigna local a los insumos que nunca lo tuvieron). |
| `src/config/schema.sql` | `pedidos` sin `domiciliario_id` (instalaciones nuevas). |
| `src/routes/index.js` | `POST /pedidos` unificado con `authOpcional` + defaults por rol; domiciliario eliminado de POST/PUT/PATCH-estado y de `PEDIDO_SELECT`; `POST/PUT /insumos` con `local_id`/`stock_minimo` obligatorios y validación entero-si-"unidad"; `calcularEstadoStock` con 4 estados. |

### 2. Migraciones (en `config/db.js`, idempotentes) + rollback

- **`ALTER TABLE pedidos DROP COLUMN IF EXISTS domiciliario_id`** (requisito 1). Se DROPEA, no se deja nullable/deprecada: es un concepto retirado del todo, no un dato que se siga consultando. Verificado antes de correr: los 8 pedidos existentes tenían `domiciliario_id = NULL` (visible en el backup `sicaber_backup_20260905_172203.sql` de la ronda anterior) — **no se perdió ningún dato real**. Rollback: `ALTER TABLE pedidos ADD COLUMN domiciliario_id INTEGER REFERENCES usuarios(id) ON DELETE SET NULL;` (vuelve vacía; sin un backup posterior a este drop no hay forma de recuperar valores que se hubieran cargado después).
- **`asegurarInsumoLocalParaTodos()`** (requisito 3): a los 28 insumos que nunca tuvieron `insumo_local` (creados antes de que el local fuera obligatorio) se les asigna el local por defecto **"Local Villa Liliam"** (política definida esta ronda — el primero de la semilla; si no existiera, el local activo de menor id), conservando su stock/mínimo tal cual estaban. Rollback: no hay una single-statement — restaurar desde un backup anterior a esta migración, o mover manualmente esas filas de `insumo_local` a otro local con `PUT /insumos/:id/locales/:localId` + `POST` en el nuevo.
- Como consecuencia de lo anterior, **ya se pudieron soltar `insumos.stock`, `insumos.stock_minimo` e `insumos.local_id`** (quedaban pendientes desde la ronda pasada por estos mismos 28 insumos) — rollback documentado en la Ronda 6.

### 3. Endpoints cambiados

- **`POST /pedidos`** — mismo contrato para Admin, Cajero y cliente/landing; ya NO acepta `domiciliario_id`. Si el token es de un **Cajero**, `local_id` y `atendido_por` del body se IGNORAN y se fuerzan a los del token (400 si el cajero no tiene local asignado); Administrador conserva la libertad de elegir cualquiera; sin token (cliente), igual que siempre.
- **`PUT /pedidos/:id`**, **`PATCH /pedidos/:id/estado`** — ya no aceptan/asignan `domiciliario_id`.
- **`POST /insumos`** — `local_id` y `stock_minimo` ahora OBLIGATORIOS (antes opcionales); `stock_minimo`/`stock` deben ser enteros si `unidadMedida='unidad'`, decimales para el resto. 400 con `requiereSeleccionLocal:true` si no se puede resolver el local.
- **`POST/PUT /insumos/:id/locales`** — misma validación entero-si-"unidad" para `stockActual`/`stockMinimo`.
- **`GET /insumos` / `GET /insumos/alertas-stock`** — `estadoStock` ahora es uno de `agotado | bajo_minimo | agotandose | ok` (antes `sin_stock | bajo | ok`); UMBRAL=1.2 (avisa 20% antes de tocar el mínimo).

### 4. Evidencia

- **Pedido sin domiciliario**: `POST /pedidos` con `domiciliario_id:999` en el body → la respuesta no tiene ese campo en absoluto (ni se guardó).
- **Un solo endpoint, defaults por rol**: mismo `POST /pedidos`, mismo payload — Cajero "juan" (local 3) mandando `local_id:4, atendido_por:999` → guardado con `local_id:3, atendido_por:4` (los suyos, no los del body). Administrador con el mismo endpoint, `local_id:4` → guardado tal cual (libre elección).
- **38→50 filas en insumo_local**: los 28 insumos sin local quedaron asignados a "Local Villa Liliam"; `insumos.stock/stock_minimo/local_id` ya no existen en la tabla.
- **`GET /insumos?local_id=3`**: estados `agotado`, `bajo_minimo`, `ok` presentes en datos reales; `agotandose` demostrado ajustando temporalmente un insumo a stock=210/mínimo=200 (dentro del 20%) y revertido después.
- **Compra en un solo local**: "Café molido" 0/0 en ambos → compra en Local 3 Esquinas (cantidad 3) → `{local 3: 0, local 4: 3 (agotandose)}` → anulada → `{0, 0}` en ambos. Filtro `?local_id=4` en `/compras` y en `/compras/historial` devolvió solo esa compra.
- **Local inactivo bloqueado**: al desactivar "Local 3 Esquinas", `POST /compras` con ese `local_id` → 400; desapareció de `GET /locales` (selector público); reactivado después.

---

## Ronda 6 (esta entrega) — Insumos por local, tipos de uso, empaques y compras por local

Reestructura completa del inventario: insumos pasan de "una fila duplicada
por local" a un catálogo único con stock por local en una tabla puente;
vasos/pitillos/desechables salen de "insumos" hacia una entidad propia
(Empaques); insumos ganan tipo de uso (normal/adición sin costo/topping);
compras y ventas descuentan SOLO el local correspondiente; y locales
devuelve más datos para el módulo de Empleados.

### 1. Archivos modificados

| Archivo | Cambio |
|---|---|
| `src/config/db.js` | Migración de datos `migrarInsumoLocalYEmpaques()` (consolida duplicados → `insumo_local`, migra empaques → `empaques`/`empaque_local`), nuevas tablas, nuevas columnas, nuevo CHECK, drop guardado de `insumos.stock/stock_minimo/local_id`, índice único global de nombre. |
| `src/config/schema.sql` | Forma final para instalaciones nuevas: `insumos` sin stock/local_id, con `es_insumo`/`es_adicion_sin_costo`; tablas nuevas `insumo_local`, `empaques`, `empaque_local`, `producto_empaque`, `movimientos_inventario`; `toppings`/`adiciones.empaque_id`; `locales.telefono`. |
| `src/routes/index.js` | Reescrito el módulo de Insumos (catálogo global + stock por local), nuevo módulo Empaques + `empaque_local`, nuevo módulo `producto_empaque`, Compras y el descuento de inventario por venta adaptados a `insumo_local`/`empaque_local`, `GET /disponibilidad` y `GET /locales/todos` actualizados. |

### 2. Migraciones creadas (todas en `config/db.js`, corren en cada arranque; idempotentes)

**Tablas nuevas** (rollback: `DROP TABLE <tabla>`, en este orden por las FK — `producto_empaque`, `movimientos_inventario`, `empaque_local`, `insumo_local`, `empaques`):
- `insumo_local(insumo_id, local_id, stock, stock_minimo, activo)` — `UNIQUE(insumo_id, local_id)`.
- `empaques(nombre, descripcion, unidad, precio_unitario, estado)` + `empaque_local` (mismo patrón que insumo_local).
- `producto_empaque(producto_id, tamano, vaso_empaque_id, lleva_pitillo, pitillo_empaque_id)` — `UNIQUE(producto_id, tamano)`.
- `movimientos_inventario(tipo, insumo_id, empaque_id, local_id, cantidad, referencia_tipo, referencia_id)` — kardex/auditoría, nadie más la lee todavía.

**Columnas nuevas** (rollback: `ALTER TABLE ... DROP COLUMN ...`):
- `insumos.es_insumo` (default `true`), `insumos.es_adicion_sin_costo` (default `false`) + `CHECK insumos_tipo_uso_check (es_insumo OR es_adicion_sin_costo OR es_topping)`.
- `toppings.empaque_id`, `adiciones.empaque_id` (+ FK a `empaques`).
- `locales.telefono`.

**Consolidación de datos** (`migrarInsumoLocalYEmpaques()`, en `config/db.js`): agrupa `insumos` por nombre normalizado; por grupo, la fila canónica (la de menor id con `local_id`, si hay alguna) se queda en `insumos`, cada fila con `local_id` pasa a una fila de `insumo_local` con su propio stock, y las filas "huérfanas" (de antes del multi-local, `local_id IS NULL` con stock real) se suman a la fila de `insumo_local` del local de menor id del grupo — **solo si la unidad es la misma o convertible** (kg/g/lb/oz entre sí, L/mL entre sí); si no es convertible, la fila huérfana se deja intacta y se loguea para revisión manual (pasó con "hielo": una fila en `unidad`, las otras en `kg`). Todo grupo cuya categoría sea "Empaques" se mueve completo a `empaques`/`empaque_local` en vez de consolidarse en `insumos`, y cualquier referencia de `toppings`/`adiciones.insumo_id` a esos ids se traslada a `empaque_id`. **Rollback de la consolidación**: no es una sola sentencia (los duplicados ya se borraron) — restaurar desde el backup tomado antes de aplicar este cambio: `sicaber_backup_20260905_172203.sql` (61 insumos originales, incluidos los 15 grupos duplicados). Se puede seguir dejando los datos como están (nada se pierde: cada duplicado quedó reflejado en `insumo_local`) o restaurar el dump completo si hace falta volver al modelo viejo.

**Columnas retiradas** (`insumos.stock`, `insumos.stock_minimo`, `insumos.local_id`) — se sueltan SOLO cuando ya no queda ningún insumo con `local_id` no-NULO ni con stock huérfano sin consolidar (guardado: si algo queda pendiente — como "hielo" — el DROP se salta y se reintenta en el próximo arranque, sin perder nada). Al día de esta entrega quedan **27 insumos de prueba sin local asignado desde antes de este cambio** (nunca se migraron, mismo criterio que ya existía) bloqueando el DROP — no es un error, es la protección funcionando; corrígelos (asígnales un local vía `POST /insumos/:id/locales`, o bórralos si son basura de pruebas) para que el DROP se complete solo.
Rollback si estas columnas ya se soltaron: `ALTER TABLE insumos ADD COLUMN stock NUMERIC(10,2) DEFAULT 0, ADD COLUMN stock_minimo NUMERIC(10,2) DEFAULT 0, ADD COLUMN local_id INTEGER;` — quedan en 0/NULL; para repoblarlas hay que sumar `insumo_local` de vuelta a mano o restaurar el backup.

**Índice único**: `insumos_nombre_local_uidx` (por nombre+local) → `insumos_nombre_uidx` (global, por nombre). Rollback: `DROP INDEX insumos_nombre_uidx; CREATE UNIQUE INDEX insumos_nombre_local_uidx ON insumos(lower(btrim(nombre)), local_id) WHERE local_id IS NOT NULL;` (necesita que `local_id` exista de nuevo en `insumos`).

### 3. Endpoints nuevos o cambiados

**Insumos** (`/api/insumos`):
- `GET /insumos?local_id=<id>` → stock de ESE local únicamente (un insumo sin fila ahí no aparece). `GET /insumos?local_id=all` (o sin el parámetro) → consolidado, `stockActual`/`stockMinimo` sumados de todos los locales + `porLocal: [{ localId, localNombre, stock, stockMinimo, activo, estadoStock }]`. Filtros combinables: `?estado=`, `?q=`, `?tipo=topping|adicion_sin_costo|insumo`, `?stockBajo=true`. Cada fila trae `estadoStock: 'sin_stock' | 'bajo' | 'ok'`.
- `POST /insumos` / `PUT /insumos/:id` → ya no reciben `stockActual`/`stockMinimo`/`local_id` como dueños del insumo (eso es de `insumo_local`); validan `esInsumo`/`esAdicionSinCosto`/`esTopping` (al menos uno en `true`, si no `400`) y bloquean `categoriaId` = "Empaques" con **`422`**.
- `GET/POST /insumos/:id/locales`, `PUT/DELETE /insumos/:id/locales/:localId` → CRUD de `insumo_local` (alta de un local nuevo para un insumo existente, ajuste de stock/mínimo, activar/desactivar en ese local).

**Empaques** (`/api/empaques`, nuevo módulo completo): mismo contrato que Insumos (`GET ?local_id=`, `POST/PUT/PATCH estado/DELETE`) + `GET/POST /empaques/:id/locales`, `PUT/DELETE /empaques/:id/locales/:localId`.

**Producto ↔ Empaque** (`/api/producto-empaque`, nuevo): `GET ?producto_id=`, `GET /:id`, `POST`, `PUT /:id`, `DELETE /:id` — `{ producto_id, tamano, vaso_empaque_id, lleva_pitillo, pitillo_empaque_id }`.

**Compras** (`/api/compras`): `POST /compras` sigue exigiendo `local_id` (ya lo hacía); ahora resuelve el insumo por nombre contra el catálogo GLOBAL (antes, contra los insumos de ese local) y suma stock solo en la fila `insumo_local` de ese local (la crea en 0 si el insumo nunca había tenido stock ahí). `PATCH /:id/anular` revierte en el mismo local de la compra. Ambos registran su movimiento en `movimientos_inventario`.

**Locales** (`/api/locales/todos`): ahora incluye `telefono`, `empleadosAsignados` y `insumosConStock` (conteo de filas en `insumo_local`). `POST`/`PUT /locales/:id` aceptan `telefono`.

### 4. Evidencia

- **Consolidación**: "Canela en polvo" — antes 3 filas (`id 8` sin local con 32 g, `id 105`/`106` por local en 0) — ahora 1 fila (`id 105`) + `insumo_local(105,3)=32`, `insumo_local(105,4)=0`. Ídem "Pitillos" → `empaques(id 1)` + `empaque_local` (16 en local 3, 0 en local 4), con el topping "Pitillos" repuntado de `insumo_id` a `empaque_id` automáticamente.
- **Estado calculado**: `GET /insumos/93?local_id=all` → `"estadoStock":"bajo"`/`"sin_stock"`/`"ok"` por local, sin que el frontend calcule nada.
- **`tipo=topping`**: `GET /insumos?tipo=topping` devolvió únicamente el insumo con `es_topping=true` (`#34 "chispas"`) de los 38 insumos activos.
- **422 Empaques**: `POST /insumos` con `categoriaId` de "Empaques" → `422 { error: "La categoría \"Empaques\" ya no aplica a insumos..." }`.
- **Compra en un solo local**: "Café molido" (`id 93`) antes: `{local 3: 0, local 4: 0}`. `POST /compras` (`local_id:3`, cantidad 5) → después: `{local 3: 5, local 4: 0}` (estadoStock local 3 pasó de `sin_stock` a `ok`; local 4 sin cambios) + fila en `movimientos_inventario` (`tipo:'compra', local_id:3, cantidad:5`). Anulada después de la prueba para no dejar datos de prueba en el inventario real (el `PATCH /:id/anular` revirtió el stock a `{0,0}` correctamente, también solo en el local 3).

### Limitaciones conocidas / a confirmar

- 27 insumos de prueba (de antes del multi-local) quedan sin `insumo_local` — nunca tuvieron un local asignado y no hay forma segura de adivinar cuál les corresponde. `insumos.stock/local_id` siguen existiendo en la base mientras tanto (el DROP se reintenta solo cuando se resuelvan).
- "Hielo" quedó como 2 registros (no se pudo fusionar automáticamente: una fila está en `unidad`, la otra en `kg` — dimensiones distintas). Hay que decidir a mano cuál es la real y fusionarlas (o convertir la unidad de una de las dos).
- 12 insumos "vaso de cartón/plástico de X oz" quedaron como insumos normales (no como Empaques) porque su categoría es "Vasos de cartón"/"Vasos de plástico", no literalmente "Empaques" — si quieres que también se conviertan en Empaques, recategorízalos a "Empaques" desde la API/UI y el servidor los migra solo en el próximo arranque (la migración corre en cada boot).
- `fichas_tecnicas.vaso_id` sigue apuntando a `insumos` (sin cambios) — `producto_empaque` es el mecanismo NUEVO para vaso/pitillo por producto/tamaño y convive con él sin reemplazarlo, para no romper fichas ya creadas.
- El descuento automático de `producto_empaque` al vender (vía `calcularRecetaEfectiva`/`descontarInventarioPorVenta`) se verificó por revisión de código y por la migración de `toppings.empaque_id`, pero no se probó con un pedido real de punta a punta en esta sesión (crear pedido → confirmar pago → marcar entregado) para no dejar datos de prueba en Pedidos/Ventas.

---

## Ronda 5 (esta entrega)

### El bloqueo al marcar "entregado" — resuelto

Este es el punto que quedó pendiente en la ronda 3 ("la ficha técnica no debe
impedir la creación de productos"). El mensaje real era:

> No se puede marcar el pedido #16 como entregado: en el local del pedido no
> existe(n) como insumo activo: Crema chantilly.

**No era por stock en cero.** `ajustarStockInsumoPorId` usa
`GREATEST(stock + delta, 0)`, así que un insumo en cero se descuenta hasta
cero y la venta pasa. El bloqueo era otra cosa: `descontarInventarioPorVenta`
exigía que **cada** insumo de la receta existiera como insumo ACTIVO en el
local del pedido. Si faltaba uno, `ROLLBACK` y el pedido no se podía entregar.

En la práctica eso dejaba pedidos ya servidos atascados por un problema de
catálogo: el ingrediente registrado en otro local, dado de baja, o escrito
distinto (`Crema chantilly` vs `Crema Chantilly`).

**Ahora no bloquea.** Se descuenta todo lo que se puede y los faltantes se
devuelven en `avisoInventario`, que admin y cajero muestran como advertencia
en rojo. El razonamiento: el producto ya se preparó y se entregó — impedir el
registro no devuelve el insumo al almacén, solo esconde la venta.

**Lo que hay que tener presente:** el stock de esos insumos NO se descuenta,
porque no hay fila que descontar en ese local. El aviso es lo que evita que
la diferencia pase inadvertida. Sigue bloqueando un solo caso: que el pedido
no tenga un local válido, porque ahí no hay inventario contra el cual
registrar nada.

| Archivo | Cambio |
|---|---|
| `sicaber-back-main/src/routes/index.js` | `descontarInventarioPorVenta` devuelve `{ faltantes }` en vez de un error; las dos rutas propagan `avisoInventario`. |
| `sicaber-front-main/.../PedidosPage.jsx` | Muestra el aviso al entregar. |
| `sicaber-front-main/.../CajeroPage.jsx` | Igual, desde la vista del cajero. |

### Márgenes — corregidos de verdad

En la ronda 4 la regla nueva quedaba seguida de la original
(`.pd-badge, .pd-estado-select { padding: 2px 8px }`), que la pisaba
parcialmente y dejaba las etiquetas descompensadas. Se eliminó la duplicada.

Además el espaciado sube: celdas de 7px → **15px** (antes 11px, poco visible),
cabeceras de 8px → 12px, y las etiquetas de estado crecen con la fila.

---

## Ronda 4 (esta entrega)

### 1. Estados de pedidos — admin y cajero unificados

Cada vista tenía su propia tabla de colores y se habían desincronizado:

| estado | Admin | Cajero |
|---|---|---|
| entregado | verde `#388E3C` | morado `#7E57C2` |
| pendiente | `#F57F17` | `#FFB300` |
| en_proceso | `#1565C0` | `#42A5F5` |
| cancelado | `#B71C1C` | `#EF5350` |
| **anulado** | existía | **no existía** |

El último era un bug de verdad: el cajero hacía `STATUS_CFG[order.estado]`
sin normalizar y con respaldo a `pendiente`, así que **un pedido ANULADO se
le mostraba como "Pendiente"** — un pedido cerrado apareciendo como activo.

Ahora existe `ESTADO_PEDIDO_CFG` en `shared/utils/pedidoEstados.js` como
fuente única. `ESTADO_CONFIG` (admin) y `STATUS_CFG` (cajero) conservan sus
nombres pero apuntan ahí, así que ningún import existente cambió.

También se corrigieron dos sitios más que indexaban con el estado crudo
(`PedidosPage` y `ModalDetallePedido`): un valor legado de la base (`listo`)
caía al objeto vacío y dejaba la etiqueta sin color ni texto.

### 2. El botón "Crear pedido" desaparecía

El carrito del modal de Admin tiene muchos más campos que el del Cajero. Con
el carrito vacío entraban justo; al agregar el primer producto aparecían el
ítem y el campo "Nota para el bartender", el contenido superaba el alto del
modal y —como `.cj-nuevo__cart` tiene `overflow: hidden`— el pie con el botón
quedaba recortado fuera de la caja, sin scroll que lo alcanzara.

Ahora el carrito scrollea completo y el pie queda fijo abajo con
`position: sticky`. Acotado a `.pb-modal__body`: la vista del Cajero no tiene
el problema y no se tocó.

### 3. Módulo de Ventas en la vista del Cajero

Nuevo `VentasTab` en `CajeroPage.jsx`, con las funciones básicas del módulo
del Admin: contadores, búsqueda, filtro por estado, tabla paginada y detalle
de la venta. Respeta el mismo filtro por local que los otros tabs.

**Diferencia deliberada:** no se ofrece "registrar venta manualmente". La
venta se crea sola al marcar el pedido como entregado, dentro de la misma
transacción que descuenta inventario. Dejar que el cajero la cree a mano
abriría la puerta a ventas duplicadas del mismo pedido.

### 4. Márgenes en el listado de pedidos

Las celdas pasan de 7px a 11px de alto, con línea divisoria entre filas y
realce al pasar el ratón.

### Extra — regresión evitada

La validación de motivo de rechazo que se añadió en la ronda 3 habría roto el
rechazo de devoluciones **desde el cajero**: enviaba el PATCH sin motivo y
habría recibido un 400. Se le agregó el mismo campo obligatorio.

---

## Ronda 3 (esta entrega)

### 1. Motivo de rechazo en devoluciones

Rechazar una devolución solo cambiaba el estado a `rechazada`, sin guardar
ninguna explicación: ni el cliente ni el siguiente cajero podían saber por qué.

| Archivo | Cambio |
|---|---|
| `sicaber-back-main/src/config/db.js` | Migración: `devoluciones.motivo_rechazo`. |
| `sicaber-back-main/src/routes/index.js` | `PATCH /devoluciones/:id/estado` exige el motivo al rechazar (mínimo 10 caracteres) y lo guarda. `GET /devoluciones` lo devuelve. |
| `sicaber-front-main/.../DevolucionesPage.jsx` | El modal de rechazo pide el motivo; la tabla lo muestra en las rechazadas. |
| `sicaber-front-main/src/shared/services/api.js` + `devolucionesService.js` | Propagan el motivo. |

El motivo se limpia si la devolución sale del estado rechazada.

**El rechazo de comprobantes ya estaba resuelto** desde antes: el backend
guarda `comprobante_motivo_rechazo` y el cliente lo ve en "Mis pedidos".
No se tocó.

### 2. Pedidos entregados salen de la lista

La venta ya se creaba sola al marcar "entregado" (`crearVentaDesdePedido`,
en la misma transacción). Lo que faltaba era que el pedido dejara de aparecer
en Pedidos.

| Archivo | Cambio |
|---|---|
| `sicaber-front-main/.../PedidosPage.jsx` | Los entregados se excluyen de la lista, y un aviso indica que el pedido pasó a Ventas. |

**Se filtra en el frontend, no en `GET /pedidos`, a propósito.** Esa misma
ruta la usan el historial del cliente ("Mis pedidos"), el Cajero, el Bartender
y la campana de domicilios, y todos ellos **sí** necesitan ver los entregados.
Filtrarlo en el backend los dejaría a todos sin historial.

### 3. Ficha técnica e insumos en cero — SIN CAMBIOS

No encontré el código que bloquea. Revisé `POST /productos` (no valida stock),
`ProductoFormPage.jsx` (tampoco), las validaciones de `FichasTecnicasPage.jsx`
(piden al menos un insumo, cantidad > 0, sin repetidos y un vaso — ninguna
mira existencias) y `InsumoSearchSelect.jsx` (filtra por `estado !== 'Inactivo'`,
no por stock).

Lo único que bloquea por existencias es el pedido del CLIENTE en la landing
(`/disponibilidad` calcula cuántas unidades se pueden producir). Eso no
impide crear productos, y cambiarlo permitiría vender lo que no se puede
preparar — por eso no lo toqué sin confirmar.

Hace falta el mensaje exacto y la pantalla donde ocurre.

---

# Rondas anteriores — permisos por rol

## Qué hace esto

Los roles que creas en `/admin/roles` ahora funcionan de verdad: el sidebar,
las rutas y los botones de cada módulo se filtran según los permisos que le
marcaste al rol.

Antes el backend nunca enviaba la lista de permisos, así que todo rol que no
fuera Administrador veía el panel vacío por más permisos que tuviera
guardados.

## Archivos

### Backend (`sicaber-back-main`)

| Archivo | Cambio |
|---|---|
| `src/middleware/permisos.js` | **NUEVO** — lee los permisos de un rol desde la tabla `roles`. Exporta `permisosDeRol`, `clavePermiso`, `requierePermiso`. |
| `src/routes/auth.js` | `POST /auth/login` y `GET /auth/me` ahora devuelven `permisos`. |
| `src/routes/index.js` | **Bug corregido** en `POST` y `PUT /usuarios` (ver abajo). |

Los permisos se consultan en cada petición, **no viajan dentro del JWT**: si
cambias los permisos de un rol desde el panel, el cambio se ve enseguida sin
que esos usuarios tengan que volver a iniciar sesión.

### Frontend (`sicaber-front-main`)

| Archivo | Cambio |
|---|---|
| `src/shared/components/HomeRedirect.jsx` | Administrador → Dashboard. Cualquier otro rol → su primer módulo con permiso. |
| `src/features/proveedores/pages/ProveedoresPage.jsx` | Era la única página del panel sin `hasPermiso`; ahora oculta Agregar / Editar / Eliminar según el permiso. |

No se tocó `AuthContext.jsx` ni `Layout.jsx`: el sidebar dinámico y el
filtrado por permisos ya estaban escritos y correctos, solo les faltaba que
el backend mandara el dato.

## El bug del rol en usuarios

`UsuarioFormPage.jsx` manda `rolId` (el id de la fila en `roles`). El backend
solo leía `rol` (el nombre), que nunca llegaba, así que el `INSERT` recibía
`undefined`.

Como `usuarios.rol` guarda el nombre como texto suelto y **no es una llave
foránea**, un usuario cuyo rol no coincide con ninguna fila de `roles` se
queda sin permisos para siempre — por más módulos que le marques al rol.

`resolverNombreRol()` ahora acepta `rolId` o `rol`, traduce el id a nombre, y
normaliza mayúsculas contra lo guardado para que `usuarios.rol` coincida
siempre exactamente con `roles.nombre`.

Si tienes usuarios creados antes de este arreglo, vuelve a guardarlos desde
`/admin/usuarios` (editar → elegir rol → guardar).

## Cómo levantarlo

Los zips vienen **sin `node_modules`**. En cada carpeta:

```
npm install
npm start
```

**El backend hay que reiniciarlo** para que los cambios tengan efecto. Si al
arrancar sale `EADDRINUSE: address already in use :::4000`, hay un proceso
viejo aferrado al puerto y el navegador va a seguir hablando con él:

```
Stop-Process -Id (Get-NetTCPConnection -LocalPort 4000 -State Listen).OwningProcess -Force
```

### Verificar que el backend quedó bien

Desde la carpeta del backend, sin necesidad de contraseñas:

```
node -e "require('./src/middleware/permisos').permisosDeRol('NOMBRE_DEL_ROL').then(p=>console.log(p.length, p))"
```

Debe imprimir los permisos que le marcaste a ese rol.

## Lo que NO está hecho

`requierePermiso()` queda exportado pero **sin aplicar a ningún endpoint**.
Esto **oculta**, no **bloquea**: con Postman el backend todavía deja pasar
cualquier petición autenticada. Aplicarlo módulo por módulo es la Tarea 1,
todavía en pausa.
