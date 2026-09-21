# Cambios aplicados

## Ronda 32 — Registro con Google en dos pasos, comprobante enviado desde la página, ventas que no desaparecen y devoluciones con relación real a la venta

Analizado primero todo lo que ya existía (autenticación con Google,
clientes, pagos, comprobantes, pedidos, ventas y devoluciones) para
reutilizar las estructuras vigentes: **no se creó ningún sistema
paralelo**. Las tablas `pedidos`, `ventas` y `devoluciones` siguen
siendo las mismas; lo que se agregó son columnas sobre ellas y dos
endpoints que faltaban.

### 1. Completar cuenta mediante Google (requisito 1)

**Causa raíz:** `POST /auth/cliente/google` creaba el cliente EN EL ACTO
cuando el correo no existía, con una contraseña aleatoria que nadie
conoce y sin teléfono ni documento. Si el usuario cerraba la pestaña,
quedaba una cuenta incompleta e inutilizable (no puede iniciar sesión
con contraseña porque no la tiene) que además bloqueaba el registro
normal con "ese correo ya está registrado".

- `POST /auth/cliente/google` con correo NUEVO ya **no toca la base**:
  responde `registroPendiente: true` + `tokenRegistro` (token temporal
  firmado, con propósito propio `registro_google`, vencimiento de 20
  min y el correo/nombre que Google ya verificó) + `camposRequeridos`.
- `POST /auth/cliente/google/completar` (nuevo): valida el token
  (vigencia y propósito), la contraseña con la política existente
  (`config/passwordPolicy.js`) y documento/teléfono con los validadores
  existentes (`config/validaciones.js`); hashea con bcrypt(10), crea el
  cliente **completo** con `verificado=true` y `estado='Activo'`, y
  devuelve `{ token, cliente }` con el MISMO formato que
  `/cliente/login`.
- El correo y el nombre salen del token firmado, nunca del body: si
  vinieran del body, cualquiera podría crear una cuenta a nombre de otro.
- Correo YA existente: flujo de login intacto.
- No se volvió a agregar dirección/departamento/municipio/comuna al
  cliente — la dirección de domicilio sigue siendo del pedido.
- Recuperación de contraseña: sin cambios, verificada por test.

### 2 y 3. Comprobantes de pago enviados desde la página (requisitos 2 y 3)

**Causa raíz:** el comprobante solo se podía adjuntar al CREAR el pedido
(`POST /pedidos`) o con `PUT /pedidos/:id`, que empieza con
`if (req.user?.rol === 'Cliente') return 403`. Un cliente que ya había
hecho el pedido **no tenía ninguna ruta** para enviarlo — ese hueco es
justamente el que tapaba WhatsApp.

- `POST /pedidos/:id/comprobante` (nuevo): lo puede usar el DUEÑO del
  pedido (rol Cliente) y también Cajero/Administrador. Acepta el archivo
  como data URL, base64 suelto o **binario crudo** (`image/*`,
  `application/pdf`), bajo varios nombres de campo.
- `GET /pedidos/:id/comprobante` (nuevo): recupera el comprobante como
  JSON o, con `?raw=1`, como archivo binario con su `Content-Type` real.
- `normalizarArchivoComprobante` (en `services/comprobante.js`): valida
  el archivo por sus **bytes iniciales** (PNG, JPEG, WEBP, HEIC, GIF,
  BMP, PDF) y lo guarda siempre como data URL con el mime real. **No
  mira la entidad ni el diseño del comprobante**: uno de un banco
  desconocido entra igual que uno de Nequi.
- `GET /pedidos/:id` ahora informa `tieneComprobante`,
  `comprobanteValido`, `comprobanteMime`, `comprobanteBytes` y
  `comprobanteUrl`, y devuelve la imagen ya normalizada — antes entregaba
  la cadena tal cual y, si no servía, el `<img>` quedaba roto sin
  explicación.
- El mismo control se aplica en `POST /pedidos` y `PUT /pedidos/:id`,
  así la columna guarda siempre un archivo válido entre por donde entre.
- Sigue vigente lo que ya existía: anti-reutilización por hash y por
  número de aprobación, y la aprobación/rechazo manual del cajero.
- WhatsApp: no había ninguna referencia en el backend. Lo que faltaba
  era la ruta que lo reemplaza, y es la que se agregó.

### 4. Devoluciones (requisito 4)

**Causa raíz:** `POST /devoluciones` exigía literalmente `pedido_id` y
respondía `400 pedido_id es requerido` ante cualquier otro nombre. Pero
la devolución se hace desde la pantalla de **Ventas**, donde lo que hay
a mano es la venta — y el propio `GET /ventas` devuelve la clave como
`id_venta`. El backend pedía un dato que la pantalla que lo llama no
tiene con ese nombre.

- Se acepta `venta_id` / `id_venta` / `pedido_id` / `id_pedido`; el que
  falte se resuelve contra la base, y si mandan los dos y no concuerdan
  se dice explícitamente.
- Columna nueva `devoluciones.venta_id` → relación DIRECTA venta
  original → devolución (antes se adivinaba con un JOIN por pedido).
- **Una venta solo puede tener UNA devolución**: chequeo en el
  controlador (409 con el id de la que ya existe) + índice único parcial
  `devoluciones_venta_uidx` en la base, para que dos peticiones
  simultáneas no creen dos filas.
- No se puede devolver un pedido que todavía no tiene venta registrada
  (409 `pedido_sin_venta`), caso que antes creaba una devolución
  colgando de un pedido nunca vendido.
- `GET /devoluciones/:id` y `GET /devoluciones/por-venta/:ventaId`
  (nuevos): antes solo existía el listado completo.
- El monto se calcula desde las líneas devueltas cuando no lo mandan
  (antes quedaba en 0).
- La venta original **nunca se borra**: solo cambia de estado.

### 5. Ventas del cajero (requisito 5)

**Causa raíz (dos, ambas reales):**
1. `ventas` solo guardaba `pedido_id`, `total` y `estado`; cliente,
   sede, método de pago, tipo y productos salían del pedido por JOIN. El
   listado del cajero filtra con `WHERE p.sede = $1`, así que una venta
   cuyo pedido no tuviera sede **no coincidía con ningún local** y
   desaparecía de la pantalla donde se la busca.
2. `DELETE /pedidos/:id` borraba el pedido y, por la FK `ON DELETE SET
   NULL`, dejaba la venta viva pero **vacía**: sin cliente, sin
   productos y sin sede.

- Columnas nuevas en `ventas`: `cliente_id`, `cliente`, `sede`,
  `metodo_pago`, `tipo_venta`, `items` — una foto de los datos al
  momento de vender. El JOIN se mantiene y manda mientras el pedido
  exista; esto es el respaldo.
- `VENTA_SELECT` usa `COALESCE(pedido, venta)` en cada campo, y el
  filtro por local también.
- `DELETE /pedidos/:id` rechaza con 409 un pedido que ya tiene venta o
  devolución registrada — mismo criterio que ya protege insumos y
  productos con historial real.
- `PATCH /ventas/:id/estado` valida el estado (antes aceptaba cualquier
  texto, y un estado que ningún filtro reconoce es una venta que
  desaparece) y responde 404 si la venta no existe (antes: 200 vacío).
- `GET /ventas/stats` acepta el filtro por local (antes sumaba siempre
  todos).

### 6. Integridad de datos (requisito 6)

No se rehízo el esquema: se agregaron columnas con `ADD COLUMN IF NOT
EXISTS`, sus FK con `ON DELETE SET NULL` (cada una en su propio
try/catch, como el resto del archivo) y un índice único parcial. Todos
los datos existentes se rellenan con una migración idempotente.

Bugs encontrados al probar la migración sobre una base YA existente:

- `schema.sql` corre como UNA transacción implícita: el
  `CREATE UNIQUE INDEX` sobre la columna nueva reventaba con «column
  "venta_id" does not exist» y **tumbaba el archivo entero** en ese
  arranque. El índice se movió a `config/db.js`, después del ALTER.
- El relleno de `devoluciones.venta_id` chocaba con el índice único en
  CADA arranque cuando un pedido histórico tenía dos devoluciones. Se
  agregó la condición que lo hace idempotente.
- El backfill de ventas faltantes (que ya existía) creaba la venta **sin
  sede**, volviendo a caer en el problema del requisito 5. Ahora copia
  también cliente, sede, método de pago, tipo y productos.

### Bug aparte, encontrado de paso

`config/db.js` documentaba en 18 líneas de comentario que convierte toda
columna `NUMERIC` a número… pero **la conversión nunca se registró**:
`types` se importaba de `pg` y no se usaba en ningún lado. Todo importe
(`ventas.total`, `devoluciones.monto`, `pedidos.total`, `productos.precio`,
`insumos.stock`…) viajaba al frontend como texto `"13000.00"`. Se detectó
porque 4 tests de la suite fallaban desde antes de esta ronda con el mismo
síntoma (`'13000.00' !== 13000`). Corregido con `types.setTypeParser(1700, …)`.

### Archivos

- `src/routes/auth.js` — flujo de Google en dos pasos + `/cliente/google/completar`.
- `src/services/tokenRegistro.js` (nuevo) — token temporal de registro.
- `src/services/comprobante.js` — `normalizarArchivoComprobante` y detección de formato.
- `src/routes/index.js` — comprobante desde la página, detalle del pedido,
  ventas, devoluciones, borrado de pedidos.
- `src/config/db.js` — migraciones, FK, índice único, backfill y el
  `setTypeParser` de NUMERIC.
- `src/config/schema.sql` — columnas nuevas para instalaciones desde cero.
- `scripts/stub-google-pruebas.js` (nuevo) — sustituto de la verificación
  de Google, SOLO para pruebas; no lo carga ni `npm start` ni `npm test`.
- Tests nuevos: `test/google-registro-completar.test.js` y
  `test/comprobantes-ventas-devoluciones.test.js`.
- Tests actualizados: los 8 archivos que mandaban un comprobante de
  texto falso (`data:text/plain;…`) ahora usan un PNG real, y
  `toppings-adiciones-venta.test.js` corrige un total que había quedado
  viejo (contaba un topping con precio, columna ya eliminada).

### Verificación

Suite completa: **213/218 verdes**. Las 5 restantes son pruebas de
pedidos a domicilio que llaman a Geoapify, inalcanzable desde el entorno
donde se corrió (la red de salida lo bloquea) — fallan igual con el
código original, sin ninguno de estos cambios. Punto de partida medido
sobre el código original: 181/191, con 10 fallas; 4 de ellas eran el bug
de NUMERIC y 1 el total viejo del test de toppings, ambos corregidos.

Además, verificado aparte: migración sobre una base con el esquema y los
datos VIEJOS (incluidas dos devoluciones sobre la misma venta), con
segundo arranque para confirmar idempotencia, y una auditoría de
integridad sobre la base que dejó la suite (huérfanos, duplicados,
reglas de negocio y validez de los 20 comprobantes guardados).

## Ronda 31 — Comprobante de compra opcional en los dos flujos + señal explícita en el detalle

Investigado a fondo antes de tocar nada: el **backend nunca exigió**
`comprobante_url` en `/compras` — ni `NOT NULL` en el esquema, ni
ninguna validación en `POST /compras`. La obligatoriedad real vivía en
el **frontend**, duplicada en los dos flujos de registro de compra que
existen hoy: `CompraForm.jsx` y `RegistrarCompraPage.jsx`, ambos con
`comprobanteEsObligatorio = items.some(it => it.presentacionTipo !==
'Unitario')` — comprobante opcional solo si TODOS los ítems eran
"Unitario" (compra directa); una sola línea por presentación (caja/
paquete/bolsa) lo volvía obligatorio.

- Ambos archivos del frontend: `comprobanteEsObligatorio` pasa a `false`
  siempre (se deja la constante, en vez de borrar todo lo que la usa,
  para no tocar el resto del flujo de validación/confirmación del OCR
  que sigue aplicando igual cuando sí se adjunta un comprobante).
- Backend: `COMPRA_COLS` ahora expone `tieneComprobante` (booleano
  explícito, `comprobante_url IS NOT NULL`) — mismo criterio que ya usa
  `PEDIDO_SELECT` con su propio `tieneComprobante`. Aplica por igual a
  `GET /compras`, `/historial` y `/:id` (los tres reutilizan
  `COMPRA_COLS`), así que el frontend no tiene que inferirlo revisando
  si la URL viene o no.
- Nada tocado en compras ya existentes: es una columna `SELECT`
  derivada de datos que ya estaban ahí, no se escribe nada — una compra
  vieja que sí tiene comprobante sigue teniéndolo, y ahora además
  informa `tieneComprobante:true`.

### Archivos

- `src/routes/index.js` — `COMPRA_COLS`.
- `sicaber-front/src/features/compras/components/CompraForm.jsx` y
  `sicaber-front/src/features/compras/pages/RegistrarCompraPage.jsx` —
  se retira la obligatoriedad.
- Test nuevo: `test/compras-comprobante-opcional.test.js`.

### Verificación

Suite completa: **191/191 verdes** (188 previos + 3 nuevos). Servidor
arranca sin errores y las rutas existentes responden con normalidad
(`GET /locales` → 200 en un arranque de humo aparte).

## Ronda 30 — Método de pago para "Recoger en el local"

Campo nuevo `pedidos.metodo_pago_local` (texto libre, hasta 100
caracteres) — el método que el cliente indica que va a usar AL RECOGER
en persona (ej. "Efectivo al recoger", o el nombre de uno de los
`metodos_pago` ya configurados en la Ronda 29). Es un campo **aparte**
de `pago` (que sigue su propio flujo de comprobante/verificación sin
ningún cambio) y **solo aplica a `tipo='local'`** (recoger); en
domicilio sigue el flujo de método de pago ya definido, sin tocar.

- `POST /pedidos` y `PUT /pedidos/:id` aceptan `metodo_pago_local`
  opcional (nunca obligatorio — "permitir guardar", no "exigir").
- Si `tipo` (el que manda la petición, o si no viene en un PUT parcial,
  el que ya tenía el pedido) resulta `'domicilio'` y se manda
  `metodo_pago_local`, se rechaza con 400 — no se guarda en silencio.
- `PUT /pedidos/:id`: si el pedido pasa de `'local'` a `'domicilio'`,
  el campo se limpia solo (`NULL`) aunque el PUT no lo mencione — así
  nunca queda un método de pago "para recoger" colgado en un pedido que
  ya es a domicilio.
- Sin FK a `metodos_pago` a propósito: es solo informativo/de
  auditoría, tan independiente de esa tabla como ya lo es `pago`.

### Archivos y tablas

- `src/config/schema.sql` / `src/config/db.js` — columna nueva
  `pedidos.metodo_pago_local VARCHAR(150)` (`ADD COLUMN IF NOT EXISTS`,
  sin nada destructivo).
- `src/routes/index.js` — `POST /pedidos` y `PUT /pedidos/:id`.
- Test nuevo: `test/pedidos-metodo-pago-local.test.js`.

### Verificación

Suite completa (`npm test`): **188/188 verdes** (181 previos + 7
nuevos). Evidencia en vivo contra `http://localhost:4000` (servidor
reiniciado para levantar la migración):
```
POST /pedidos tipo=local, metodo_pago_local:"Efectivo al recoger" → 201,
  metodo_pago_local:"Efectivo al recoger" en la respuesta.
POST /pedidos tipo=domicilio, metodo_pago_local:"Efectivo" → 400,
  "...solo aplica a pedidos de tipo local...".
PUT /pedidos/:id tipo:"domicilio" (pedido que era local, con metodo_pago_local
  ya guardado) → 200, tipo:"domicilio", metodo_pago_local:null (se limpió solo).
```
El pedido de prueba se borró al terminar.

## Ronda 29 — Rol de Administrador normalizado en /locales, métodos de pago dinámicos, ruido decimal en compras por presentación, pedidos entregados fuera del listado activo

### 1) Locales no cargan en Empleados — "Solo Administrador puede realizar esta acción"

No se pudo reproducir con la cuenta real (`Admin_Sicaber`, `rol` guardado
exactamente como `"Administrador"`): generado un token fresco para esa
cuenta y probado en vivo contra `GET /locales/todos` → 200 con el listado
completo, no 403.

Se encontró y corrigió una causa raíz real y más general, en
`permitirRoles()` (`middleware/auth.js`): comparaba el rol del token con
`.includes()` **exacto** — sensible a mayúsculas y sin recortar
espacios — mientras que `esAdministrador()` (`middleware/permisos.js`)
ya normalizaba (trim + minúsculas) para el mismo propósito en otro
lugar. Como `usuarios.rol` es un `VARCHAR` libre (no un enum/CHECK),
nada impide que quede guardado como `" administrador"` o
`"ADMINISTRADOR"` — un usuario así es un Administrador real para
cualquiera que lo mire, pero **cualquier** ruta detrás de
`permitirRoles('Administrador')` (no solo `/locales`) lo rechazaba por
no coincidir carácter por carácter. Ahora `permitirRoles` normaliza
igual que `esAdministrador`.

### 2) Métodos de pago dinámicos (checkout de la Landing)

Tabla nueva `metodos_pago` (`nombre` único, `descripcion`, `url_qr`
opcional, `activo`, `fecha_actualizacion`). Deliberadamente
**independiente** de `pedidos.pago` (el identificador interno fijo
`efectivo`/`nequi`/`transferencia` que ya exige el CHECK de la base,
`METODOS_PAGO_VALIDOS`): esta tabla es solo lo que se MUESTRA en el
checkout (para poder agregar/editar/desactivar un método sin tocar
código), no reemplaza ni valida contra ese enum existente.

Endpoints nuevos (`src/routes/index.js`, `metodoPagoRouter`, montado en
`/metodos-pago`):
- `GET /metodos-pago` — **público**, sin token. Solo `activo=true`, para
  el checkout de la Landing.
- `GET /metodos-pago/todos`, `GET /metodos-pago/:id` — admin, todos
  (activos e inactivos).
- `POST /metodos-pago` — crea, con `url_qr` **opcional** ("imagen no
  obligatoria", como se pidió).
- `PUT /metodos-pago/:id` — edita. Un bug se encontró y corrigió antes
  de probar nada: la primera versión forzaba `activo` en cada edición
  (reactivaba sin querer un método que se había desactivado a
  propósito, si el body no mandaba `activo`); ahora se preserva con
  `COALESCE` si no viene explícito. Igual con `url_qr`: si no viene, no
  borra el QR ya guardado.
- `PATCH /metodos-pago/:id/qr` — sube/cambia (o quita, con
  `url_qr:null`) solo el QR, sin reenviar el resto del formulario
  (mismo espíritu que `PUT /pedidos/:id` con `comprobante_img`).
- `PATCH /metodos-pago/:id/estado` — activar/desactivar (sin DELETE, no
  se pidió — mismo criterio de "desactivar, no borrar" que ya usan
  insumos/proveedores/roles/locales/clientes).

### 3) Compras por presentación — ruido decimal (`41.300000000000004`)

`calcularCantidadStock()` (`src/routes/index.js`) — la que calcula
cuánto stock representa un ítem en modo "presentacion"
(`cantidad_presentaciones × contenido_por_presentacion`) — hacía esa
multiplicación en punto flotante crudo, sin redondear. Dos factores con
decimales "limpios" pueden arrastrar ruido binario típico de JS: en
vivo, `3 × 13.7` da exactamente `41.099999999999994` (no `41.1`). Ese
número crudo se usaba tal cual para sumar al stock, para guardarse en
`cantidad_anulada` (columna `compras.items`, JSONB, **sin** el tope de
precisión que sí tiene `insumo_local.stock` — `NUMERIC(10,2)`) y para
armar los mensajes de error de anulación parcial ("solo quedan X
pendientes de anular"). Ahora se redondea a 2 decimales (mismo tope que
ya exige `validarItemCompra` para `cantidad`, mismo scale que
`insumo_local.stock`) antes de usarse en cualquiera de esos tres
lugares.

### 4) Pedidos entregados → excluidos del listado activo, consultables en Ventas

`GET /pedidos` (el listado operativo de Cajero/Admin) solo excluía un
pedido cuando `estado_devolucion==='total'` — un pedido normal ya
`'entregado'` (sin ninguna devolución) seguía apareciendo ahí, mezclado
con lo que de verdad falta atender. Ya tenía su fila en `ventas` desde
que se marcó entregado (`registrarVentaDePedido`, sin cambios — ya
funcionaba bien y se reconfirmó en vivo), así que `GET /ventas` siempre
lo mostró correctamente; lo que faltaba era sacarlo del listado de
pedidos activos. Ahora el filtro también excluye `estado==='entregado'`.
`GET /pedidos/:id` (factura) y `GET /pedidos/mis-pedidos` (historial del
cliente) son rutas aparte y **no cambian** — un pedido entregado sigue
siendo consultable ahí.

### Cómo quedó el upload del QR

**No se construyó ningún endpoint de subida de archivos nuevo.** Se
reutiliza el mecanismo ya existente en el proyecto: la subida real la
hace el FRONTEND directo a Cloudinary
(`cloudinaryService.js#uploadToCloudinary`, preset sin firma, sin
backend de por medio) — mismo patrón que ya usa el comprobante de una
compra o el `imagen` de un producto/categoría. El backend de
`metodos_pago.url_qr` es solo una columna `TEXT`: recibe la URL
resultante (`secure_url`) y la guarda, exactamente igual que
`productos.imagen`, `categorias.imagen` y `compras.comprobante_url`.

### Archivos y tablas modificados o creados

- `src/middleware/auth.js` — `permitirRoles()` normaliza rol (trim +
  minúsculas), igual que `esAdministrador()`.
- `src/routes/index.js`:
  - `metodoPagoNombreDuplicado`, `METODO_PAGO_COLS`, `metodoPagoRouter`
    (nuevo) — CRUD + QR de métodos de pago, montado en `/metodos-pago`.
  - `calcularCantidadStock()` — redondea a 2 decimales el cálculo por
    presentación.
  - `GET /pedidos` — el filtro de "activos" también excluye
    `estado==='entregado'`.
- `src/config/schema.sql` / `src/config/db.js` — tabla nueva
  `metodos_pago` (`CREATE TABLE IF NOT EXISTS`, sin nada destructivo).
- Tests nuevos: `test/permitir-roles-normalizacion.test.js`,
  `test/metodos-pago.test.js`, `test/compras-decimal-presentacion.test.js`,
  `test/pedidos-entregado-excluido-de-activos.test.js`.
- `test/pedidos-cliente-y-listado.test.js` — los dos tests de listado
  operativo ajustados: con el punto 4, un pedido `entregado` sale del
  listado por sí solo (ya no hace falta esperar a la devolución total
  para verlo desaparecer); se reescribieron para cubrir eso y además
  confirmar que una devolución parcial no saca la venta de "vendido".

### Verificación

Suite completa (`npm test`, base dedicada `sicaber_test`): **181/181
verdes** (162 previos + 19 nuevos). Evidencia en vivo contra
`http://localhost:4000` (servidor reiniciado para levantar la migración
de `metodos_pago`):
```
GET /locales/todos con el token real de Admin_Sicaber → 200, listado completo.

POST /metodos-pago sin url_qr → 201, urlQr:null.
POST /metodos-pago con url_qr → 201, urlQr:"https://res.cloudinary.com/...".
GET /metodos-pago (público) → ambos, solo los activos.

Compra por presentación 3 × 13.7 (ruido conocido: 41.099999999999994)
  → GET /insumos/:id → porLocal[].stock: 41.1 exacto, no el ruido crudo.

Pedido nuevo, comprobante aprobado → antes de "entregado": presente en
  GET /pedidos. PATCH estado:"entregado" → GET /pedidos: ausente.
  GET /pedidos/:id → sigue mostrando estado:"entregado".
  GET /ventas → venta encontrada, estado:"vendido", total:9000.
```
Todos los registros de prueba se borraron o desactivaron al terminar
(insumo y proveedor de la prueba de compras no se pudieron eliminar —
mismo candado de siempre, tienen compras registradas — se desactivaron
en su lugar).

## Ronda 28 — Anulación parcial de compras, stock protegido, búsqueda de precio por texto, devoluciones↔ventas confirmado, alias único en pedidos

### 1) Compras — anulación parcial por insumo

`PATCH /compras/:id/anular` ahora acepta `{ motivo, items: [{insumo_id, cantidad}, ...] }`:
revierte SOLO el stock de esos insumos/cantidades, deja el resto de la
compra intacta. Cada línea de `compras.items` lleva su propio
`cantidad_anulada` (acumulado, nunca se pisa) para que varias
anulaciones parciales sucesivas sobre el mismo insumo no reviertan de
más. Estado resultante:
  - Todo lo comprado queda anulado (sumando todas las anulaciones) →
    `estado: 'anulada'`.
  - Queda algo sin anular → `estado: 'anulada_parcial'`.
  - Sin `items` en el body → anula TODO lo pendiente (compatibilidad
    total con cualquier caller que solo mande `{motivo}`, como antes).

### 2) Insumos — el stock nunca se edita a mano vía PUT /insumos/:id

Confirmado en código y en vivo: `insumos` (el catálogo global) **ni
siquiera tiene una columna `stock`** — el stock vive por local, en
`insumo_local.stock`. `PUT /insumos/:id` no lee ni escribe ningún campo
de stock; mandarlo en el body no tiene ningún efecto. No hizo falta
ningún cambio.

⚠️ Nota aparte, NO tocada esta ronda: `PUT /insumos/:id/locales/:localId`
SÍ acepta `stockActual` a propósito — es el mecanismo que la Ronda 21
construyó explícitamente para activar/corregir el stock de un insumo al
sumarlo a un local nuevo. Si además de "PUT /insumos/:id" también se
quiere bloquear esa otra ruta, es una decisión aparte (revertiría algo
pedido antes) — no se tocó sin que se pida explícito.

### 3) Productos — búsqueda de precio por coincidencia de TEXTO

`GET /productos?precio=` dejó de interpretar el número como "prefijo en
miles" (`"5"` → solo 5000-5999) y ahora busca el texto en CUALQUIER
posición del precio (`FLOOR(precio)::text LIKE '%5%'`): `"5"` encuentra
5000, 15000, 5500, 25010, etc. — antes "15000" nunca aparecía buscando
"5" aunque a simple vista lo "contenga".

### 4) Devoluciones ↔ ventas — YA estaba correcto, reconfirmado con evidencia fresca

Investigado a fondo: el cruce `estado_dev`/venta que se reportó como
roto **ya lo corrigió la Ronda 25** (`PATCH /devoluciones/:id/estado`
recalcula `ventas.estado` en cada cambio, no solo al aprobar). Verificado
de nuevo, en vivo, con un pedido nuevo:
  - Rechazar la devolución → venta sigue `'vendido'` ✔ (como debía).
  - Aprobar la devolución (cubre TODO el pedido) → venta pasa a
    `'devuelto'` ✔ — el caso que se reportó como roto no lo está.

**Nota importante para no dejar un malentendido**: la Ronda 25
diferencia a propósito una devolución TOTAL (→ venta `'devuelto'`) de
una PARCIAL (venta se queda `'vendido'`, porque el resto del pedido
sigue siendo una venta real). Si lo que se probó para reportar este
punto fue una devolución de SOLO PARTE del pedido, esperando que aun así
la venta completa pasara a `'devuelto'`, ese es el comportamiento
DELIBERADO de la Ronda 25, no un bug — avisar si se quiere cambiar ese
criterio (sería revertir una decisión ya tomada, no algo que se tocó
esta ronda sin preguntar).

### 5) Ventas — alias único para pedidos sin cliente registrado

`pedidos.alias` (columna nueva). Al crear un pedido SIN `cliente_id`
(mostrador/mesa), ahora además del nombre (`cliente`, ya exigido desde
la Ronda 24) se exige un `alias` (ej. `"Juan - mesa 3"`), único entre
los pedidos que sigan ACTIVOS ahora mismo (ni `entregado` ni
`cancelado` — una vez el pedido se entrega, el alias queda libre para
otro cliente). Un `cliente_id` real NUNCA necesita alias (ya tiene
identificador propio). `PUT /pedidos/:id` acepta editar el alias con la
misma validación.

### Archivos modificados

- `src/routes/index.js`:
  - `PATCH /compras/:id/anular` — reescrito para anulación total o
    parcial por insumo.
  - `textoBusquedaPrecio` (reemplaza a `filtroPrecioDesdeQuery`) +
    `GET /productos` — filtro de precio por texto.
  - `aliasEnUso` (nueva) + `POST /pedidos` y `PUT /pedidos/:id` — exige y
    valida el alias cuando no hay `cliente_id`.
- `src/config/schema.sql` / `src/config/db.js` — `pedidos.alias` (columna
  nueva).
- Tests nuevos: `test/compras-anulacion-parcial.test.js`,
  `test/productos-busqueda-precio.test.js`.
- `test/pedidos-cliente-y-listado.test.js` — ampliado con los casos de
  alias (obligatorio, único, libre tras entregar).
- Tests existentes ajustados (creaban pedidos sin `cliente_id` y ahora
  necesitan `alias`): `test/auth-cuenta-desactivada.test.js`,
  `test/ficha-vaso-pitillo.test.js`, `test/inventario-por-local.test.js`,
  `test/pedidos-factura-devolucion.test.js`,
  `test/pedidos-metodo-pago.test.js`,
  `test/pedidos-permisos-y-estado-pago.test.js`, `test/rango-fechas.test.js`,
  `test/roles-desactivar-cascada.test.js`, `test/toppings-adiciones-venta.test.js`.

### Verificación

Suite completa (`npm test`, base dedicada `sicaber_test`): **162/162
verdes** (148 previos + 14 nuevos, con TODOS los archivos afectados por
el alias ya ajustados). Evidencia en vivo contra `http://localhost:4000`:
```
Compra con A(10 kg) + B(5 kg) → anular 4 de A → estado:"anulada_parcial",
  A baja a 6, B sigue en 5 → anular las 6 restantes de A → sigue
  "anulada_parcial" (B intacto) → anular B (5) → estado:"anulada", A y B
  vuelven a 0 → reintentar anular → 400 "ya está anulada".

GET /productos?precio=5 → encuentra $5.000 y $15.000, NO encuentra $8.000.

PUT /insumos/:id {stock:99999} → sin efecto, el stock real sigue igual.

Pedido entregado → devolución RECHAZADA → venta sigue "vendido".
Nueva devolución del mismo pedido, APROBADA → pedido.estado_devolucion:
  "total", venta pasa a "devuelto".

POST /pedidos sin alias (sin cliente_id) → 400 "Indica un alias...".
POST /pedidos alias="Juan - mesa 3" → 201.
Otro pedido con el MISMO alias (mientras el primero sigue activo) → 409.
Mismo nombre "Juan", alias="Juan - ventana" (distinto) → 201.
```
Todos los registros de prueba se borraron o desactivaron al terminar
(los que ya tenían historial de compras real no se pudieron eliminar —
mismo candado de siempre — se desactivaron en su lugar).

## Ronda 27 — Confirmado: "Administrador" es la ÚNICA excepción en desactivar roles

Ningún cambio de código — releí `PATCH /roles/:id/estado`
(`src/routes/index.js`) y la única comparación que bloquea la
desactivación es `rol.nombre.trim().toLowerCase() === 'administrador'`.
No hay ninguna otra condición, ni por nombre ni por ningún otro criterio,
que restrinja Cliente, Cajero, Bartender ni ningún rol personalizado —
ya estaba exactamente como se pidió.

### Verificación

- `test/roles-desactivar-solo-administrador.test.js` (nuevo) — contra la
  base dedicada de test (nunca la real, para no cascadear sobre cuentas
  reales): crea (o reutiliza) los roles "Cliente", "Cajero" y "Bartender"
  con un usuario cada uno, confirma 200 + cascada real al desactivar cada
  uno, confirma un rol personalizado cualquiera también se desactiva sin
  problema, y confirma que "Administrador" es el único que responde 409
  (y que sigue Activo después del intento). Suite completa: **148/148
  verdes** (143 previos + 5 nuevos).
- En vivo contra `http://localhost:4000` (servidor real): se evitó tocar
  los roles reales "cajero" (2 usuarios Activos reales asignados hoy) y
  "Bartender" — cascadear sobre ellos habría desactivado cuentas reales
  sin forma de revertirlo automáticamente. En su lugar, se crearon 3
  roles de evidencia con nombres seguros (uno por cada rol del sistema) y
  se desactivaron:
  ```
  PATCH /roles/<ClienteEvidencia>/estado   → 200, Inactivo
  PATCH /roles/<CajeroEvidencia>/estado    → 200, Inactivo
  PATCH /roles/<BartenderEvidencia>/estado → 200, Inactivo
  PATCH /roles/1 (Administrador real)/estado → 409 "...quedaría sin
    ningún administrador activo."
  ```
  Los 3 roles de evidencia se borraron al terminar; los roles reales del
  sistema no se tocaron.

## Ronda 26 — Una cuenta desactivada de verdad pierde el acceso (login + middleware)

Hallazgo confirmado en la Ronda 25: `POST /auth/login`, `POST /auth/
cliente/login` y el middleware `auth` no revisaban `estado` en ningún
punto — "desactivar" un usuario/cliente (a mano, o en cascada al
desactivar su rol) no le impedía seguir iniciando sesión, y un token ya
emitido (hasta 8h de vigencia) seguía sirviendo sin importar qué pasara
con la cuenta después.

### 1) Login (usuarios/empleados)

`POST /auth/login` — después de validar la contraseña (nunca antes, para
no revelar nada a quien todavía no la acertó), rechaza con
`403 { error: 'Tu cuenta está desactivada. Contacta a un administrador.' }`
si `usuarios.estado !== 'Activo'`.

### 2) Login de cliente

`clientes.estado` ya existía (`PATCH /clientes/:id/estado` ya podía
desactivar un cliente) pero tampoco se revisaba. `POST /auth/cliente/
login` aplica exactamente el mismo chequeo, mismo mensaje.

### 3) Token ya emitido — el middleware `auth` ahora re-verifica en cada petición

Confirmado: `auth` (`src/middleware/auth.js`) solo verificaba la firma/
vigencia del JWT, nunca volvía a consultar la base — un token de 8h
seguía funcionando aunque la cuenta se desactivara 1 minuto después de
emitirlo. Ahora `auth` consulta `estado` (tabla `clientes` si
`payload.rol==='Cliente'`, `usuarios` en cualquier otro caso) en CADA
petición autenticada, y corta con 403 si ya no está `'Activo'` — no hace
falta esperar a que el token expire ni que el usuario cierre sesión.

`authOpcional` (rutas públicas que ACEPTAN pero no EXIGEN sesión, ej.
`POST /pedidos`) sigue su propio contrato de "nunca rechazar": si el
token es de una cuenta desactivada, se degrada a anónimo (mismo criterio
que ya aplicaba a un token roto/expirado) en vez de devolver 403 — la
petición sigue, solo sin `req.user`.

### Archivos modificados

- `src/routes/auth.js` — chequeo de `estado` en `POST /login` y
  `POST /cliente/login`.
- `src/middleware/auth.js` — `auth` y `authOpcional` ahora async, con
  `cuentaDesactivada(payload)` (consulta `usuarios` o `clientes` según el
  rol del token) antes de dejar pasar cualquier petición.
- `test/auth-cuenta-desactivada.test.js` (nuevo) — 6 tests: login Activo
  ok, login Inactivo 403, token previo pierde acceso en la siguiente
  petición (usuario Y cliente), y `authOpcional` degradando a anónimo sin
  romper `POST /pedidos`.

### Verificación

Suite completa (`npm test`, base dedicada `sicaber_test`): **143/143
verdes** (137 previos + 6 nuevos) — el cambio en el middleware `auth`
toca prácticamente TODA la API, y no rompió ningún test existente.
Evidencia en vivo contra `http://localhost:4000` (servidor real,
reiniciado):
```
Usuario nuevo, Activo → POST /auth/login → 200.
Token emitido, GET /auth/me → 200 (cuenta aún activa).
PATCH /usuarios/:id/estado → Inactivo.
POST /auth/login (mismo usuario/contraseña) → 403 "Tu cuenta está
  desactivada. Contacta a un administrador."
MISMO token de antes (sin volver a loguear) → GET /auth/me → 403,
  mismo mensaje — pierde acceso en la siguiente petición, no espera a
  que expire.

Cliente nuevo, Activo → POST /auth/cliente/login → 200.
PATCH /clientes/:id/estado → Inactivo.
POST /auth/cliente/login → 403, mismo mensaje.
```
Todos los registros de prueba se borraron al terminar.

## Ronda 25 — Desactivar un rol desactiva en cascada a sus usuarios

### Lo que había, antes de tocar nada

`roles` no tenía NINGÚN concepto de "rol inactivo" — ni columna `estado`,
ni endpoint para cambiarlo. Lo único parecido era `DELETE /roles/:id`
(borrado físico, bloqueado si el rol tiene usuarios asignados). El pedido
asumía "el endpoint equivalente que ya exista" — no existía; se construyó
desde cero, siguiendo el mismo patrón `PATCH /:id/estado` ya usado en
insumos/proveedores/categorías/usuarios de esta misma API.

### Lo que se agregó

- `roles.estado` (columna nueva, `'Activo'` por defecto — ningún rol
  existente queda afectado por la migración).
- `PATCH /roles/:id/estado` — alterna Activo/Inactivo, igual que sus
  pares. Al pasar a **Inactivo**:
  - Desactiva en cascada (`usuarios.estado='Inactivo'`) a TODOS los
    usuarios con ese rol asignado que estén hoy `Activo` (mismo criterio
    de comparación que ya usaba `contarUsuariosConRol`: `lower(rol)`).
    Solo se toca `usuarios.estado` — nada de pedidos, ventas, compras,
    `atendido_por`, etc. de esos usuarios se altera.
  - La respuesta incluye `usuariosDesactivados` (cuántos se tocaron).
- Al **reactivar** el rol (Inactivo → Activo): NO reactiva a nadie —
  `usuariosDesactivados` viene en `0` en ese sentido siempre. Reactivar
  cada usuario queda manual, uno por uno, decisión del Administrador.
- **Bloqueo real, no solo cosmético**: intentar desactivar el rol
  "Administrador" (por nombre, case-insensitive) responde 409 y el
  `UPDATE` ni se ejecuta — verificado que el rol sigue `Activo` después
  del intento, no solo que el mensaje de error aparece.

### Hallazgo (no corregido, fuera de lo pedido)

`POST /auth/login` **no revisa `usuarios.estado` en absoluto** — ni antes
de esta ronda, ni ahora. Marcar a un usuario `Inactivo` (por esta cascada
o por cualquier otro medio ya existente) no le impide iniciar sesión hoy,
ni invalida un token ya emitido. La cascada de esta ronda hace exactamente
lo que ya hacía el resto del sistema al "desactivar" un usuario — no
inventé un comportamiento nuevo ni rompí uno que ya funcionara — pero vale
la pena que sepas que `estado='Inactivo'` es, hoy, más una señal para el
panel que un bloqueo real de acceso. No lo toqué por estar fuera de lo
pedido esta ronda.

### Archivos modificados

- `src/config/schema.sql` / `src/config/db.js` — columna `roles.estado`.
- `src/routes/index.js` — `PATCH /roles/:id/estado` (nuevo).
- `test/roles-desactivar-cascada.test.js` (nuevo) — 3 tests: cascada real
  con historial intacto, reactivación sin cascada inversa, bloqueo real
  del rol Administrador.

### Verificación

Suite completa (`npm test`, base dedicada `sicaber_test`): **137/137
verdes** (134 previos + 3 nuevos). Evidencia en vivo contra
`http://localhost:4000` (servidor real, reiniciado): rol de prueba con 3
usuarios reales creados → un pedido "atendido" por uno de ellos →
`PATCH /roles/:id/estado` → los 3 usuarios quedan `Inactivo`
(`usuariosDesactivados:3`) → el pedido histórico sigue exactamente igual
(`atendido_por`, `total`, `cliente`, `estado` sin cambios) → reactivar el
rol devuelve `usuariosDesactivados:0` y los 3 usuarios **siguen**
`Inactivo` → intentar desactivar el rol "Administrador" real (id 1) → 409
"...el sistema quedaría sin ningún administrador activo." Todos los
registros de prueba (rol, usuarios, pedido) se borraron al terminar.

## Ronda 24 — Pedidos devueltos fuera del listado activo, dirección de domicilio para Admin/Cajero, cliente_id validado y pedido nunca anónimo

### 1) Pedidos totalmente devueltos ya no cuentan como "activos"

`GET /pedidos` (el listado operativo que usan Cajero/Admin) ahora excluye
los pedidos con `estado_devolucion === 'total'` (ver Ronda 23). Un pedido
con devolución **parcial** NO se excluye — el resto del pedido sigue
siendo una venta real y activa; solo cuando la suma de devoluciones
aprobadas cubre el pedido COMPLETO desaparece de este listado. El pedido
NUNCA se borra ni deja de existir: `GET /pedidos/:id` (la factura) lo
sigue mostrando igual, con su `estado_devolucion` bien puesto, y
`GET /devoluciones` sigue siendo la fuente de verdad completa de qué se
devolvió — que es justo el único lugar donde el negocio pidió que quedara
consultable.

No se tocó `GET /pedidos/mis-pedidos` (el historial del propio cliente) a
propósito: un cliente debe poder seguir viendo SU pedido devuelto en su
propio historial — la exclusión es solo del listado operativo de
staff. Tampoco se tocó `GET /pedidos/stats` (los contadores del
Dashboard) — sus contadores se calculan por `pedidos.estado` a nivel SQL
(un valor que NUNCA es "devuelto" — eso vive en `ventas.estado`), así que
ajustarlos exigiría replicar en SQL la misma lógica de cobertura que hoy
vive en JS; se deja fuera de esta ronda para no arriesgar una traducción
sutilmente distinta sin que se haya pedido.

### 2) Dirección de domicilio para Admin/Cajero — ya funcionaba, verificado

Revisé `POST /pedidos` a fondo: `direccion_alternativa` se lee del mismo
campo del body sin importar el rol de quien crea el pedido — no hay
ningún bloque que lo descarte para Admin/Cajero (el bloque que fuerza
`local_id`/`atendido_por` para roles operativos nunca toca este campo).
Confirmado con evidencia en vivo: un Admin y un Cajero, cada uno, crean un
pedido `tipo='domicilio'` con `direccion_alternativa`, y en ambos casos
queda guardada igual que en un pedido de la landing. No hizo falta
ningún cambio de código para este punto.

### 3) Cliente registrado o anónimo con identificador

`POST /pedidos` no validaba `cliente_id` en absoluto — un id inventado
rompía el `INSERT` con un 500 crudo (violación de la FK
`pedidos.cliente_id REFERENCES clientes(id)`), y no exigía NINGÚN
identificador cuando no había `cliente_id` (se podía crear un pedido sin
`cliente_id` NI nombre, totalmente anónimo). Corregido:
- `cliente_id`, si viene, se valida contra la tabla `clientes` — 400 claro
  ("El cliente indicado no existe") en vez de un 500.
- Sin `cliente_id`: el campo de texto `cliente` (nombre — sirve igual
  para "Mesa 5" que para el nombre de un cliente sin cuenta) pasa a ser
  OBLIGATORIO. Sin ninguno de los dos → 400 ("no puede quedar totalmente
  anónimo").

**Hallazgo relacionado, NO corregido (fuera del alcance pedido)**: un
Cliente autenticado que crea su propio pedido tampoco tiene
`cliente_id` auto-derivado de su token — si el frontend no lo manda
explícito en el body, el pedido queda con `cliente_id=NULL` y jamás
aparecerá en `GET /pedidos/mis-pedidos` de ese cliente. No lo toqué
porque no fue parte de lo pedido esta ronda y cambiar ese comportamiento
podría interactuar con cómo arma el body el frontend hoy — pero conviene
revisarlo pronto.

### Archivos modificados

- `src/routes/index.js`:
  - `GET /pedidos` — filtra `estado_devolucion !== 'total'` antes de
    responder.
  - `POST /pedidos` — valida `cliente_id` contra `clientes` (400 si no
    existe); exige `cliente` (nombre) cuando no hay `cliente_id`.
- `test/pedidos-cliente-y-listado.test.js` (nuevo) — 7 tests: pedido con
  devolución total sale del listado pero sigue en `/pedidos/:id` y en
  `/devoluciones`; una devolución parcial NO lo saca; Admin y Cajero
  crean pedidos a domicilio con dirección igual que la landing;
  `cliente_id` inexistente → 400; `cliente_id` válido → 201; sin
  `cliente_id` ni nombre → 400 (anónimo); sin `cliente_id` pero con
  nombre (mesa/mostrador) → 201.

### Verificación

Suite completa (`npm test`, base dedicada `sicaber_test`): **133/133
verdes** (125 previos + 8 nuevos). Evidencia en vivo contra
`http://localhost:4000` (servidor real, reiniciado):
```
Pedido entregado, visible en GET /pedidos → devolución TOTAL aprobada →
YA NO aparece en GET /pedidos, pero /pedidos/:id sigue mostrándolo
(estado_devolucion:"total") y /devoluciones lo sigue listando.

POST /pedidos {tipo:'domicilio', direccion_alternativa:'Calle 57B...'}
como Admin → 201, direccion_alternativa guardada tal cual.

POST /pedidos {cliente_id:999999999} → 400 "El cliente indicado no existe."
POST /pedidos {} (sin cliente_id ni cliente) → 400 "...no puede quedar
totalmente anónimo."
POST /pedidos {cliente:"Mesa 7"} (sin cliente_id) → 201, aceptado igual que siempre.
```
Todos los registros de prueba creados durante la verificación se
borraron al terminar.

## Ronda 23 — Contraseña, métodos de pago, factura + devoluciones, ciudades/categorías sin borrado, NIT simplificado

### 1) Contraseña — regla nueva (10-20, mayúscula, minúscula, número, especial)

Ya existía un módulo ÚNICO (`src/config/passwordPolicy.js`) usado en TODOS
los puntos donde se crea/cambia una contraseña — no había validaciones
duplicadas ni sueltas en otro lado. Se reemplazó su regla interna por el
regex exacto pedido y el mensaje literal pedido; como el módulo es
compartido, esto alcanza automáticamente los 6 puntos de uso reales, sin
tocar cada uno por separado:
- `POST /auth/cliente/registro`
- `POST /auth/cliente/reset-password`
- `POST /usuarios`, `PUT /usuarios/:id`
- `POST /empleados` (cuenta de acceso al crear un Cajero/Bartender) y su
  actualización en `PUT /empleados/:id`

**Regex nuevo:** `/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).{10,20}$/`
**Mensaje (400):** "La contraseña debe tener entre 10 y 20 caracteres, con
al menos una mayúscula, una minúscula, un número y un carácter especial."

El login NUNCA valida formato (sin cambios) — cuentas viejas con
contraseñas que no cumplen la regla nueva siguen entrando; solo se les
exige la regla nueva el día que la cambien.

⚠️ El espejo de este archivo en el frontend (`src/shared/utils/
passwordPolicy.js`, en `sicaber-front`) sigue con la regla VIEJA — hay que
actualizarlo también para que la validación en pantalla no contradiga al
backend.

### 2) Métodos de pago — reorganizados

- **Efectivo restringido a domicilio**: nuevo, en `POST /pedidos` y
  `PUT /pedidos/:id` (edición parcial — se resuelve la combinación
  RESULTANTE tipo+pago contra lo ya guardado si alguno de los dos no
  viene en el body). `tipo='local'` + `pago='efectivo'` → 400.
  `tipo='domicilio'` + `pago='efectivo'` sigue funcionando igual que
  siempre (arranca en `'pendiente'`, sin exigir comprobante).
- **'transferencia' (Llave Bancolombia)**: confirmado sin cambios — sigue
  siendo el valor guardado/enviado; el frontend solo le pone otra
  etiqueta. `nequi` y `transferencia` ya exigían (y lo siguen haciendo)
  el mismo gate de comprobante verificado antes de `en_proceso` — no hizo
  falta tocar nada de esa parte, solo se verificó en vivo.

### 3) Factura del pedido + estado "devuelto"

`GET /pedidos/:id` YA era, de hecho, la factura/detalle completo (cliente,
tipo, pago, cada producto con receta/personalización y precio, total,
comprobante, `estado`, `estado_pago`) — JSON detrás de `auth`, igual de
consumible desde web que desde móvil. Se le agregó lo que faltaba:

- **`estado_devolucion`** — campo nuevo, SEPARADO de `estado` y de
  `estado_pago` (mismo criterio de no mezclar conceptos): `'ninguna'` |
  `'parcial'` | `'total'`, calculado sumando TODAS las devoluciones
  APROBADAS de ese pedido contra lo realmente comprado en cada línea.
- Cada entrada de `productos[]` trae `cantidadDevuelta` y `devuelto`
  (booleano) — para marcar SOLO la línea que de verdad se devolvió.
- **Bug real corregido** en `PATCH /devoluciones/:id/estado`: aprobar
  CUALQUIER devolución (aunque fuera de un solo producto entre varios,
  `tipo='parcial'`) marcaba la **venta completa** como `'devuelto'` —
  ahora la venta solo pasa a `'devuelto'` cuando lo aprobado (sumando
  todas las devoluciones del pedido) cubre el pedido COMPLETO; una
  devolución parcial dejó de romper el estado principal.
- La respuesta de `PATCH /devoluciones/:id/estado` ahora trae el pedido
  actualizado adjunto (`full.pedido`), con su `estado_devolucion` ya
  recalculado, para no tener que pedirlo aparte.

### 4) Ciudades y categorías de insumo — sin borrado físico

Verificado en código y en vivo: **ninguna de las dos rutas define un
`.delete(...)` en absoluto** — `DELETE /ciudades/:id` y
`DELETE /categorias-insumos/:id` ya devuelven 404 (no existe la ruta) hoy
mismo, y `PATCH /:id/estado` (Activo/Inactivo) sigue siendo la única
forma de cambiar su disponibilidad. Esto ya estaba así desde una ronda
anterior de este mismo historial (con test dedicado) — no hizo falta
ningún cambio, solo se reverificó.

### 5) NIT de proveedores — validación de formato, sin Módulo 11

**No se encontró ningún algoritmo de dígito de verificación (Módulo 11)
en este backend** — ni en `routes/`, ni en `config/`, ni en ningún otro
archivo del repo. Si existía, vivía únicamente en el frontend
(`sicaber-front`), fuera del alcance de esta sesión. Lo que SÍ faltaba en
el backend era **cualquier** validación de formato del NIT en
`POST`/`PUT /proveedores` — se agregó, con el regex pedido:
`/^\d{9}-\d{1}$/`. Aplica tanto al `nit` de Persona Jurídica como al
`numeroDocumento` de una Persona Natural que eligió "NIT" como tipo de
documento (mismo espacio de identificación que ya comparten en
`buscarDuplicadosProveedor`). Sigue siendo un campo OPCIONAL — solo se
valida forma cuando de verdad llega un valor.

### Archivos modificados

- `src/config/passwordPolicy.js` — regla reescrita (regex + mensaje
  únicos, 10-20 caracteres); usada sin cambios adicionales por los 6
  endpoints ya listados en `auth.js`/`index.js`.
- `src/routes/index.js`:
  - `POST /pedidos`, `PUT /pedidos/:id` — validación "efectivo solo
    domicilio".
  - `calcularEstadoDevolucion` / `conEstadoDevolucion` /
    `conEstadoDevolucionEnBloque` (nuevas) — aplicadas en
    `GET /pedidos` (lista), `GET /pedidos/mis-pedidos`,
    `GET /pedidos/:id`.
  - `PATCH /devoluciones/:id/estado` — recalcula `ventas.estado` según
    cobertura real (no según la sola transición a `'aprobada'`); adjunta
    el pedido actualizado en la respuesta.
  - `NIT_REGEX` / `errorNit` (nuevas) — aplicadas en `POST`/`PUT
    /proveedores`.
- `src/config/schema.sql` / `src/config/db.js` — hallazgo adicional (ver
  abajo): re-agregadas `clientes.username`/`clientes.verificado` +
  tabla `tokens_verificacion` (habían desaparecido de estos dos archivos
  entre sesiones — ver nota).
- Tests nuevos: `test/password-policy.test.js`,
  `test/pedidos-metodo-pago.test.js`,
  `test/pedidos-factura-devolucion.test.js`,
  `test/proveedores-nit.test.js`.
- Tests existentes ajustados (usaban `pago:'efectivo'` + `tipo:'local'`,
  combinación que esta ronda vuelve inválida): `test/ficha-vaso-pitillo.
  test.js`, `test/inventario-por-local.test.js`, `test/rango-fechas.
  test.js`, `test/toppings-adiciones-venta.test.js`,
  `test/pedidos-permisos-y-estado-pago.test.js`.

### Nota: `clientes.username`/`verificado` + `tokens_verificacion` habían vuelto a faltar

Al arrancar esta ronda, `npm test` volvió a fallar con el mismo 500 de la
Ronda 22 ("no existe la columna «username»" / "no existe la relación
«tokens_verificacion»") — la migración que se agregó esa ronda a
`schema.sql`/`db.js` ya NO estaba en ninguno de los dos archivos al
empezar esta sesión (`CAMBIOS.md` tampoco tenía ya la entrada de la
Ronda 22 completa). Se reaplicó exactamente el mismo fix. Si esto vuelve
a desaparecer, vale la pena revisar qué está revirtiendo estos dos
archivos entre sesiones (un `git checkout` manual, una edición externa,
etc.) — el propio `routes/index.js` de la Ronda 22 (estado_pago,
permisos de Cliente/DELETE) sí se conservó intacto.

### Verificación

Suite completa (`npm test`, base dedicada `sicaber_test`): **125/125
verdes** (89 previos + 36 nuevos/ajustados). Evidencia en vivo contra
`http://localhost:4000` (servidor real, reiniciado para tomar todo el
código nuevo):
```
POST /auth/cliente/registro {password:"clave123"} → 400, mensaje exacto pedido.
POST /auth/cliente/registro {password:"Clave123456#"} → 201.

POST /pedidos {tipo:'local', pago:'efectivo'} → 400 "...solo aplica para pedidos a domicilio...".
POST /pedidos {tipo:'domicilio', pago:'efectivo', dirección real cubierta} → 201, estado:'pendiente'.
POST /pedidos {pago:'transferencia', con comprobante} → pago guardado: "transferencia".

Pedido con 2 líneas (Café×2, Jugo×1), entregado. Devolución PARCIAL (1×Café)
aprobada → pedido.estado_devolucion:"parcial", productos[0].devuelto:true,
productos[1].devuelto:false, venta.estado:"vendido" (sin romper).
Segunda devolución que cubre el resto (1×Café + 1×Jugo) aprobada →
estado_devolucion:"total", venta.estado:"devuelto".

DELETE /ciudades/:id → 404. DELETE /categorias-insumos/:id → 404.
PATCH /categorias-insumos/:id/estado → 200 (sigue funcionando).

POST /proveedores {nit:"900123456-9"} (DV matemático real incorrecto) → 201, aceptado por forma.
POST /proveedores {nit:"90012345"} (sin guion+dv) → 400 "...formato...".
```
Todos los registros de prueba creados durante la verificación se
borraron al terminar.

## Ronda 21 — Alta de insumo con un solo local (sin "Todos los locales"), y aviso accionable en el choque de nombre

El frontend quitó la opción "Todos los locales": el formulario ahora
manda siempre `localesSeleccionados` con exactamente un id. La lógica de
siembra de `insumo_local` (fila en TODOS los locales, `activo=false`
salvo el elegido) y la bandera "activo" ya eran correctas — no se tocó.

### 1) `localesSeleccionados` vacío ahora se rechaza (400)

Antes, un `localesSeleccionados: []` explícito NO disparaba ningún error:
`!localesSeleccionados` evaluaba `false` (un array vacío es truthy en JS),
así que `haceFaltaLocalId` daba `false` y el insumo se creaba con
`activo=false` en TODOS los locales — un insumo "fantasma", invisible en
cualquier local hasta que alguien lo activara a mano sin saber que existía.

**Corrección:** `POST /insumos` rechaza explícitamente un
`localesSeleccionados` de longitud 0 con
`400 { campo: 'localesSeleccionados', error: 'Selecciona al menos un local donde existe este insumo.' }`,
antes de llegar a ninguna otra validación.

`todosLosLocales` se mantiene por compatibilidad (documentado en el
código) aunque el formulario actual ya no lo ofrezca — el backend sigue
aceptando cualquier cliente que lo mande.

### 2) Activar el mismo insumo en un local nuevo: flujo documentado (sin cambios de código, ya funcionaba así)

El insumo es un catálogo GLOBAL con nombre único (`insumos.nombre`, único
sin importar el local). Crear un insumo YA siembra una fila de
`insumo_local` para **todos** los locales (activa solo en los
seleccionados, inactiva en el resto, en 0) — así que activar ese mismo
insumo en un local donde hoy está inactivo NUNCA requiere un
`POST /insumos` nuevo (chocaría contra la unicidad de nombre) ni siquiera
un `POST /insumos/:id/locales` (la fila ya existe): alcanza con

```
PUT /insumos/:id/locales/:localId
Body: { "activo": true, "stockActual": <cantidad inicial en ESE local, opcional> }
```

que hace un `UPDATE` parcial (`COALESCE`) sobre la fila ya sembrada.

### 3) El choque de nombre ahora es accionable: trae el insumo existente

Antes, `POST`/`PUT /insumos` con un nombre que ya existe devolvía
`{ error: 'Ya existe un insumo con ese nombre.' }` — sin decir CUÁL
insumo ni dónde, un error muerto que no le daba al front nada con qué
ofrecer una salida.

**Corrección:** se reemplazó `insumoNombreDuplicado` (booleano) por
`insumoExistentePorNombre` (trae `{ id, nombre, localesActivos }` del
insumo que ya tiene ese nombre) y `respuestaNombreDuplicado` (arma el
mismo mensaje + payload sin importar si el choque se detectó por
adelantado o llegó como `23505` desde una carrera entre dos altas
simultáneas). Nuevo contrato de la respuesta 400:

```json
{
  "campo": "nombre",
  "error": "Ya existe un insumo llamado \"Leche\" (hoy activo en: Local Centro). Para tenerlo en un local nuevo, actívalo ahí en vez de crear uno nuevo (PUT /insumos/12/locales/:localId con { \"activo\": true }).",
  "insumoExistente": {
    "id": 12,
    "nombre": "Leche",
    "localesActivos": [ { "localId": 3, "localNombre": "Local Centro" } ]
  }
}
```

Con esto el front puede ofrecer un botón "Activar aquí" en vez de un
callejón sin salida. Se aplicó tanto al chequeo por adelantado como al
`catch` de `23505` (carrera) en `POST` y `PUT /insumos`.

### Contrato documentado — POST /insumos (contrato completo, esta ronda)

```
POST /insumos
Body:
  nombre            string, obligatorio, único GLOBALMENTE (sin distinguir mayúsculas).
  categoriaId       id de categorías_insumos, opcional (422 si es la categoría "Empaques").
  unidadMedida      una de: kg, g, lb, oz, L, mL, unidad. Opcional al crear, INMUTABLE después.
  descripcion       opcional, tope LIMITES.DESCRIPCION.
  estado            'Activo' | 'Inactivo', default 'Activo'.
  stockMinimo       obligatorio, según unidad (entero si unidad='unidad').
  stockActual       OPCIONAL — la cantidad inicial real. Se omite (o se manda
                     0) si no hay cantidad; un valor > 0 es lo único que
                     cuenta como "hay stock inicial real" para el resto de
                     la lógica (local_id obligatorio, texto de Observaciones,
                     movimiento en el kardex).
  todosLosLocales   booleano. Compatibilidad — el formulario actual ya no
                     lo ofrece (ver localesSeleccionados).
  localesSeleccionados  array de ids de local. FLUJO ACTUAL: siempre trae
                     exactamente un id. NO puede venir vacío ([]) — 400 si
                     lo está. Con un único id, local_id se infiere solo:
                     no hace falta mandarlo aparte.
  local_id          solo obligatorio si stockActual > 0 Y hay más de un
                     local candidato (varios ids en localesSeleccionados,
                     o todosLosLocales=true). Debe estar dentro de
                     localesSeleccionados si ese campo vino.
  observaciones     opcional; si no se manda y hay stock inicial real, se
                     autocompleta "Comenzó con cantidad existente".

Respuesta 201: el insumo completo + "porLocal" (stock/activo por cada local).
Respuesta 400/422: { campo, error, [insumoExistente], [requiereSeleccionLocal] }.
Respuesta 403: rol operativo (Cajero/Bartender) intentando operar fuera de su local.
```

### Contrato documentado — PUT /insumos/:id/locales/:localId

```
PUT /insumos/:id/locales/:localId
Body (todos opcionales, UPDATE parcial vía COALESCE):
  stockActual   nueva cantidad en ese local.
  stockMinimo   nuevo mínimo en ese local.
  activo        true/false — ESTE es el campo que "activa" el insumo en
                 un local donde hoy existe inactivo. La fila SIEMPRE ya
                 existe (sembrada al crear el insumo, o al crear el local)
                 — nunca hace falta POST /insumos/:id/locales para esto.

Respuesta 200: { id, localId, stock, stockMinimo, activo, estadoStock }.
Respuesta 404: el insumo no tiene fila para ese local (no debería pasar
                en uso normal — la siembra cubre todos los locales).
Respuesta 403: rol operativo intentando operar fuera de su local.
```

### Archivos modificados

- `src/routes/index.js`:
  - `POST /insumos` — rechaza `localesSeleccionados: []` (400).
  - `insumoNombreDuplicado` (booleano) reemplazada por
    `insumoExistentePorNombre` + `respuestaNombreDuplicado`, usadas en
    `POST` y `PUT /insumos` (chequeo por adelantado y catch de `23505`).
- `test/insumo-locales-seleccionados.test.js` — 2 tests nuevos: rechazo de
  `localesSeleccionados: []`, y alta con un solo local (fila activa con
  el stock, resto en 0 e inactivo, movimiento verificado en
  `movimientos_inventario` directo contra la base).
- `test/insumo-nombre-duplicado.test.js` (nuevo) — 3 tests: la respuesta
  de nombre duplicado trae `insumoExistente` con sus locales activos y un
  mensaje accionable (en `POST`), el mismo comportamiento en `PUT` contra
  otro insumo, y que editar un insumo sin cambiar su nombre no choca
  consigo mismo.

### Evidencia (en vivo, contra `http://localhost:4000`)

```
POST /insumos { nombre, localesSeleccionados:[25], stockActual:22, ... }
→ 201 — porLocal: local 25 activo=true, stock=22; locales 3/4/17
  activo=false, stock=0.
SELECT * FROM movimientos_inventario WHERE insumo_id=<el creado>
→ 1 fila: tipo=ajuste, local_id=25, cantidad=22.00, referencia_tipo=alta_insumo.

POST /insumos { localesSeleccionados:[] }
→ 400 { campo:'localesSeleccionados', error:'Selecciona al menos un local...' }

POST /insumos con el MISMO nombre, para el local 17
→ 400 { campo:'nombre', insumoExistente:{ id, nombre, localesActivos:[{localId:25,...}] },
        error:'... actívalo ahí ... PUT /insumos/<id>/locales/:localId ...' }
PUT /insumos/<id>/locales/17 { activo:true, stockActual:9 }
→ 200 { localId:17, stock:9, activo:true } — activado sin crear un registro nuevo.
```

Suite completa (`npm test`, base de datos dedicada `sicaber_test`):
**83/83 verdes**. Registros de prueba creados durante la verificación en
vivo, borrados al terminar.

## Ronda 20 — La causa REAL del 400 de POST /insumos, y dos desalineaciones más de contrato (front↔back)

Esta ronda toca el repo `sicaber-front` (hasta ahora nunca tocado en este
historial) además del backend. Diagnóstico del usuario, confirmado en
código: el back estaba bien (Rondas 18-19 corrigieron su lado real), pero
el FRONT nunca llegó a mandar esas correcciones — seguía usando llaves que
el backend nunca leyó.

### 1) POST /insumos 400 — causa raíz verdadera: el payload del front

`sicaber-front/src/features/insumos/components/construirPayloadInsumo.js`
mandaba `locales_ids`/`todos_locales`/`local_inicial_id` (el backend nunca
leyó esos nombres) y **siempre** `stockActual: 0` fijo, con la cantidad
real aparte en `stockInicial` (un campo que el backend tampoco lee). Es
decir: ningún fix de las Rondas 18-19 podía arreglar el bug visible, porque
el 400 real llegaba antes de que esa lógica corregida importara — el
backend simplemente nunca recibía la cantidad ni la selección de locales
con los nombres correctos.

Reescrito para mandar el contrato real de `insRouter.post('/')`:
`localesSeleccionados` (array), `todosLosLocales` (booleano), `stockActual`
(la cantidad real — se omite si no hay cantidad, nunca se manda un 0
fijo), y `local_id` solo cuando hace falta desambiguar (varios locales
candidatos + cantidad real; con un solo local marcado el backend ya lo
infiere).

**Archivos:**
- `sicaber-front/src/features/insumos/components/construirPayloadInsumo.js` — reescrito.
- `sicaber-front/src/features/insumos/components/construirPayloadInsumo.test.js` — reescrito, 8 tests contra el contrato real (antes probaba un contrato que no existe). `npx react-scripts test --watchAll=false` → 8/8 verdes.

**Payload antes (bug) →: después (real):**
```
// ANTES (nunca funcionó contra el backend actual)
{ locales_ids:[25], todos_locales:false, stockActual:0, stockInicial:'40', local_inicial_id:'25' }

// DESPUÉS
{ localesSeleccionados:[25], todosLosLocales:false, stockActual:40 }
```

**Evidencia en vivo** (payload real generado por `construirPayloadInsumo`, contra `POST http://localhost:4000/api/insumos`):
- 1 local marcado + stock inicial → 201, ese local queda `activo:true` con el stock, los demás en 0/inactivos.
- Varios locales marcados + stock inicial + `local_id` → 201, todos los marcados quedan activos, solo el `local_id` indicado recibe el stock.
(Insumos de prueba creados y luego borrados: ids 428 y 429.)

### 2) Ficha Técnica — selector de Toppings usaba un filtro retirado del backend

`FichasTecnicasPage.jsx` llamaba `GET /insumos?tipo=topping` — ese filtro
ya no existe (las columnas `es_topping`/`es_adicion` se eliminaron en la
Ronda 13 y el parámetro `tipo` ni se lee), así que el selector mostraba
TODO el catálogo de insumos sin filtrar. Confirmado en vivo:
`GET /insumos?tipo=topping` devuelve los 20 insumos activos, sin filtrar.

Reescrito para derivar las opciones del catálogo real de toppings
(`toppingsService.getAll()`, ya cargado por la propia pantalla), filtrando
por `t.insumo_id` (solo toppings respaldados por un insumo real, no los
manuales/empaque) y por aplicabilidad al producto de la ficha
(`productos_ids` vacío = universal, o que incluya el producto actual) —
el mismo criterio que ya aplica `GET /toppings?producto_id=` en el
backend. No hace falta ningún endpoint nuevo: el catálogo ya estaba en
memoria.

**Archivos:**
- `sicaber-front/src/features/fichasTecnicas/pages/FichasTecnicasPage.jsx` — quitado el fetch a `/insumos?tipo=topping`; `insumosToppingOpc` ahora se deriva de `toppingsCatalogo`.
- `sicaber-front/src/features/insumos/services/insumosService.js` — quitado `getByTipo` (nadie más lo usaba).
- `sicaber-front/src/shared/services/api.js` — quitado `getByTipo` de `insumosApi`; quitado el manejo muerto de `opts.tipo`; corregido `opts.local` → `?local_id=` (bug latente, sin llamador real hoy).

**Evidencia en vivo** (`GET /toppings`, catálogo real): de 4 toppings, solo 1 (`Crema chantilly`, `insumo_id:10`) tiene un insumo real detrás — los otros 3 (`Pitillos`, `hielo`, `chispas`) tienen `insumo_id:null` y quedan correctamente excluidos del selector.

### 3) Ficha Técnica — Vaso y Pitillo: el diagnóstico del usuario apuntaba al lugar equivocado, pero SÍ había un bug real (más grave) ahí mismo

Se verificó `validarFichaTecnica` (fuente de verdad del contrato de
`POST`/`PUT /fichas-tecnicas`) línea por línea antes de tocar nada: el
vaso y el pitillo de la ficha técnica siguen siendo **insumos**
(`vaso_insumo_id`/`pitillo_insumo_id`, con sus respectivas cantidades),
tal como se decidió en la Ronda 9 — NO se movieron a `/empaques`. Eso es
un mecanismo distinto y aparte: `producto_empaque.vaso_empaque_id` /
`pitillo_empaque_id` es el vaso/pitillo POR DEFECTO de un producto/tamaño
(aditivo, no reemplaza al de la ficha), usado en otro punto del cálculo
de venta. El campo `lleva_pitillo` sí es el nombre correcto en ambos
lugares — ahí el usuario tenía razón — pero `pitillo_empaque_id` no es lo
que la ficha técnica espera.

El bug real, verificado y reproducido en vivo, es más simple y más grave:
1. El front mandaba `pitillo_id`/`pitillo_cantidad`; el backend
   (`validarFichaTecnica`) solo acepta `pitillo_insumo_id` +
   `cantidad_pitillo` — **sin alias de compatibilidad** (a diferencia de
   `vaso_id`, que sí tiene `vaso_insumo_id ?? vaso_id`). Esto rompía dos
   cosas: el campo se veía SIEMPRE vacío al editar una ficha con pitillo
   guardado (el front leía `fichaInicial.pitillo_id`, que no existe en la
   respuesta — el backend devuelve `pitillo_insumo_id`), y el guardado
   fallaba con 400 "Si el producto lleva pitillo, debes seleccionar
   cuál." aun con un pitillo elegido en pantalla.
2. **Bug más grave, en el mismo formulario**: no existía NINGÚN campo
   `cantidad_vaso` — el front nunca lo mandaba. `errorCantidadPorUnidad`
   lo exige por defecto (`obligatorio=true`), así que **cualquier**
   guardado de ficha técnica con un vaso elegido (el vaso es obligatorio
   en el formulario) fallaba con 400 "La cantidad de vaso es obligatorio
   y debe ser un número." — reproducido en vivo con el payload exacto que
   mandaba el front antes de este fix.

**Archivos:**
- `sicaber-front/src/features/fichasTecnicas/pages/FichasTecnicasPage.jsx` — agregado el campo `vaso_cantidad` (input + validación + envío como `cantidad_vaso`); `pitillo_id`/`pitillo_cantidad` ahora se prefienan desde `fichaInicial.pitillo_insumo_id`/`cantidad_pitillo` y se envían como `pitillo_insumo_id`/`cantidad_pitillo`.

**Evidencia en vivo** (`POST /fichas-tecnicas`, admin, producto sin ficha):
```
Payload viejo del front (vaso_id sin cantidad_vaso, pitillo_id/pitillo_cantidad):
  → 400 "La cantidad de vaso es obligatorio y debe ser un número."
Payload viejo, aislando solo el pitillo (cantidad_vaso ya presente):
  → 400 "Si el producto lleva pitillo, debes seleccionar cuál."
Payload nuevo (vaso_id+cantidad_vaso, pitillo_insumo_id+cantidad_pitillo):
  → 201, ficha creada con vaso_insumo_id, cantidad_vaso, pitillo_insumo_id
     y cantidad_pitillo guardados correctamente.
```
(Ficha de prueba creada y luego borrada: id 100.)

### 4) Auditoría de compras / empaques / toppings / adiciones (mismo problema, reportado)

Comparado cada payload del front contra lo que el endpoint destructura de
`req.body`:

- **Compras** (`CompraForm.jsx` → `POST /compras`): alineado. Manda
  `proveedorId`, `local_id`, `fecha`, `total`, `descuento`, `items`,
  `observaciones`, `comprobante_*`, `ocr_resultado` — exactamente lo que
  `compRouter.post('/')` destructura, y cada ítem trae `insumo`, `unidad`,
  `cantidad`, `precioUnitario`, `presentacion.*` — igual que
  `validarItemCompra`. Ningún cambio necesario.
- **Toppings** (`ToppingsPage.jsx` → `POST /toppings`) y **Adiciones**
  (`AdicionesPage.jsx` → `POST /adiciones`): alineados. Ambos mandan
  `nombre`, `insumo_id`, `cantidad` (y `productos_ids` en toppings,
  `precio`/`descripcion` en adiciones) — coincide con
  `resolverConsumoToppingAdicion` y los `INSERT` de cada router. Ningún
  cambio necesario.
- **Hallazgo (no corregido, requiere decisión de producto)**: ninguno de
  los dos formularios tiene forma de elegir un `empaque_id` como fuente
  de consumo (solo `insumo_id`) — el backend sí lo soporta
  (`toppings.empaque_id`/`adiciones.empaque_id`). Consistente con el
  siguiente punto: `/empaques` no tiene NINGUNA superficie en el
  frontend.
- **Hallazgo (no corregido)**: `AdicionesPage.jsx` tiene un campo `imagen`
  en el formulario que se manda en el payload, pero la tabla `adiciones`
  no tiene esa columna — ni `POST` ni `PUT /adiciones` la leen. Se ignora
  en silencio, sin error visible; el usuario nunca puede realmente ponerle
  imagen a una adición pese a que el formulario lo sugiere.
- **Hallazgo (no corregido, el más grande)**: el backend tiene un CRUD
  completo de `/empaques` (`empRouterEmpaques`, con endpoints de
  locales/stock incluidos) pero **no existe ningún módulo del frontend**
  que lo use — ni servicio, ni página, ni componente (`grep -ri empaque`
  en `sicaber-front/src` solo encuentra comentarios). Hoy no hay forma de
  crear/editar/listar Pitillos o Vasos como empaques desde la interfaz.
- **Hallazgo (ya señalado, sin tocar)**: `toppings_ficha` (el array que
  manda `FichasTecnicasPage.jsx` al guardar una ficha, con cantidades
  específicas por producto) usa `{id_insumo, cantidad, unidad}`, mientras
  que `calcularRecetaEfectiva` (cálculo de receta al vender) lo lee como
  `{topping_id, cantidad}`. No se tocó esta ronda: cambiar cualquiera de
  los dos lados afecta el cálculo de inventario en venta y merece su
  propia validación explícita antes de tocarlo.

### Verificación

- Backend: sin cambios de código esta ronda (solo lectura/verificación de
  `validarFichaTecnica` y los endpoints de compras/toppings/adiciones).
- Frontend: `npx react-scripts test --watchAll=false` → 8/8 verdes.
  `FichasTecnicasPage.jsx` verificado con Babel (`presets: ['react-app']`)
  sin errores de sintaxis.
- Evidencia en vivo contra `http://localhost:4000` (servidor de
  desarrollo real, no la base de tests) para los 4 casos pedidos: insumo
  con 1 local + stock, insumo con varios locales + stock, catálogo de
  toppings filtrado, y ficha técnica con vaso+pitillo guardando
  correctamente con los nombres de campo reales. Todos los registros de
  prueba creados durante la verificación se borraron al terminar.

## Ronda 19 (esta entrega) — Segunda causa del mismo 400: stockActual=0 explícito se trataba como "hay cantidad inicial"

### Qué devuelve el 400 HOY para el payload del formulario (respuesta directa a lo pedido)

Con el fix de la Ronda 18 ya aplicado, el 400 YA traía mensaje aprovechable
(`{ "campo": "local_id", "error": "Elige a qué local va el stock inicial:
como Administrador puedes operar sobre cualquier local activo.",
"requiereSeleccionLocal": true }`) — el front SÍ tenía información, pero
seguía sin explicar bien la causa real, porque la causa real no era "falta
mandar el local" sino que el 0 que el formulario manda por defecto se
interpretaba como "sí hay stock inicial".

### Causa raíz (reproducida en vivo antes de tocar código)

La hipótesis del front ("¿dejamos de mandar el local del stock inicial?")
apuntaba al lugar correcto pero no era el problema — el problema es lo
que el formulario manda cuando el usuario NO toca el campo de cantidad:
un `<input type="number">` controlado suele arrancar en `0`, no en `""`.
El backend (desde la Ronda 18) decidía "¿hace falta un local_id?" con
`stockActualProvisto` — que solo mira si el campo VINO en el body, sin
mirar su VALOR. Un `stockActual: 0` explícito activaba
`stockActualProvisto = true` exactamente igual que un `stockActual: 5` —
así que con varios locales seleccionados (o "todos") y sin `local_id`
explícito, el backend seguía pidiendo un local "para el stock inicial"
que en realidad no existía (0 es 0 en cualquier local, no hace falta
elegir ninguno). Confirmado en vivo, reproduciendo el payload exacto:

```
stockActual=0 + varios locales, sin local_id  → 400 (antes de este fix)
stockActual=0 + todosLosLocales, sin local_id → 400 (antes de este fix)
```

### Corrección

Se separa lo que YA estaba bien separado en la Ronda 18 en un nivel más:
`stockActualProvisto` (el campo vino en el body, sea cual sea el valor)
sigue usándose SOLO para decidir si hay que validar el FORMATO del
número. Para todo lo demás — ¿hace falta un local_id?, ¿el texto de
Observaciones se autocompleta?, ¿se registra un movimiento en el kardex?
— ahora se usa `hayStockInicialReal = Number(stockActual) > 0`, que
distingue una cantidad de verdad de un cero que no representa ningún
stock que ubicar.

### Archivos modificados

- `src/routes/index.js` — `POST /insumos`: `hayStockInicialReal` (nuevo)
  reemplaza a `stockActualProvisto` en las 4 decisiones que antes
  confundían "el campo vino" con "hay una cantidad real": exigir
  `local_id`, el mensaje de error, el texto por defecto de Observaciones,
  y si se registra movimiento en `movimientos_inventario`.
- `test/insumos-creacion-local-no-obligatorio.test.js` — 3 tests nuevos
  (stockActual=0 con varios locales, con todosLosLocales, y verificación
  de que no deja rastro en el kardex).

### Evidencia

Payload exacto reproducido, antes/después:

```
ANTES: stockActual=0 + localesSeleccionados=[A,B], sin local_id → 400
       "Elige a qué local va el stock inicial..."
AHORA: mismo payload                                            → 201
```

Efectos colaterales verificados correctos con `stockActual: 0` explícito:
`observaciones` queda `null` (no "Comenzó con cantidad existente" — no
hay cantidad real que haya "comenzado"), y `movimientos_inventario` no
recibe ninguna fila para ese insumo (no hay cambio de stock que trazar).

Los 4 casos pedidos, reverificados tras este segundo fix — los 4 en `201`:

```
Caso 1 (sin stock, un local):               201
Caso 2 (sin stock, varios locales):         201
Caso 3 (con stock, apuntando a local marcado): 201
Caso 4 (todos los locales):                 201
```

`npm test` → **78/78 passing** (75 previos sin regresión + 3 nuevos),
estable en 3 corridas consecutivas.

---

## Ronda 18 (esta entrega) — Bug bloqueante: POST /insumos rechazaba altas válidas con 400

### Causa raíz (diagnosticada y reproducida ANTES de tocar código)

Confirmado en vivo, con el servidor real, que las 3 sospechas del reporte
eran básicamente correctas (a y b), y las otras 2 no:

- **(a) y (b), la causa real** — `POST /insumos` llamaba a
  `resolverLocalOperativo(req)` de forma INCONDICIONAL, apenas empezaba a
  procesar el body — sin importar si había o no un stock inicial que
  ubicar, y sin que esa función supiera nada de `localesSeleccionados`/
  `todosLosLocales` (el mecanismo agregado dos rondas atrás para "¿en qué
  locales existe este insumo?"). Esa función solo mira `req.body.local_id`
  o el local fijo del usuario — un Administrador/Superadministrador
  (que la ronda pasada dejó, a propósito, SIN local fijo) que mandaba
  `localesSeleccionados` pero no repetía el mismo dato en `local_id`
  recibía siempre: `400 { "error": "Elige a qué local corresponde esta
  operación: como Administrador puedes operar sobre cualquier local
  activo." }` — el mensaje es correcto en sí, pero disparaba incluso
  cuando el local YA estaba contestado por otra vía, y aunque no hubiera
  ningún stock que necesitara saber "a qué local va". Reproducido en vivo
  contra el servidor real ANTES de escribir ningún fix: los 4 casos
  pedidos (excepto el que ya mandaba `local_id` suelto, sin flags) daban
  los mismos `400` idénticos.
- **(c) descartada** — los flags `es_topping`/`es_adicion`/`es_insumo` ya
  no existen en absoluto en el modelo de Insumo (columnas eliminadas hace
  varias rondas); `POST /insumos` no los lee ni los exige. Confirmado
  releyendo el handler completo: cero referencias.
- **(d) descartada** — el texto por defecto de Observaciones ("Comenzó
  con cantidad existente", 30 caracteres) está muy por debajo del límite
  (`LIMITES.OBSERVACIONES = 500`); no interviene en ningún 400 reproducido.

El mensaje de error, hoy: **si ya traía mensaje** (`{ error: "..." }` en
todos los casos existentes desde rondas anteriores), pero **nunca decía
qué CAMPO** había fallado — el frontend no tenía cómo señalar el campo
exacto en el formulario. Se agrega `campo` a la respuesta.

### Corrección

`POST /insumos` ya no exige resolver un `local_id` de forma incondicional.
Se separan dos preguntas relacionadas pero independientes:

1. **"¿En qué locales existe el insumo?"** — se resuelve primero, con las
   tres formas ya existentes (`todosLosLocales` / `localesSeleccionados` /
   ninguno de los dos). Un rol operativo (Cajero/Bartender) sigue limitado
   a su propio local acá — 403 si intenta "todos", una lista con otro id,
   o un `local_id` explícito distinto al suyo (ver el bug de la sección
   siguiente).
2. **"¿A qué local va el stock inicial (`local_id`)?"** — ahora SOLO se
   exige resolver cuando de verdad hace falta:
   - hay una cantidad inicial que ubicar (`stockActual` viene con valor), o
   - es el ÚNICO dato disponible para saber en qué local existe el insumo
     (ni `todosLosLocales` ni `localesSeleccionados` se mandaron —
     comportamiento de siempre, sin cambios).

   Cuando SÍ hace falta y no vino explícito: si `localesSeleccionados`
   tiene un único id, se infiere de ahí (sin obligar a repetirlo); si no,
   se usa el local propio del rol operativo, o el propio del admin como
   conveniencia; si nada de eso resuelve nada, recién ahí se pide elegir
   — con un mensaje distinto según si lo que falta es "dónde existe" o
   "dónde va el stock".

**Bug nuevo encontrado y corregido en el propio desarrollo de este fix**
(apareció al escribir el test de regresión, antes de reportarlo como
terminado): al mover la validación de "rol operativo no puede elegir
otro local" a un bloque separado, dejé de comparar el `local_id`
EXPLÍCITO del body contra el local propio del Cajero — un Cajero que
mandaba `local_id` de otro local (sin `localesSeleccionados` ni
`todosLosLocales`) volvía a colarse, silenciosamente reasignado a su
propio local en vez de recibir el 403 esperado (la regresión de la Ronda
17 que se acababa de corregir). Se agregó la comparación que faltaba;
verificado que el test que lo había señalado ahora pasa, y que el resto
de la suite (74 tests más) sigue en verde.

### Mensajes de error con campo (requisito 3)

Todo `400`/`422` de `POST /insumos` ahora incluye `campo` junto a `error`
— `nombre`, `descripcion`, `unidadMedida`, `categoriaId`, `stockMinimo`,
`stockActual`, `localesSeleccionados`, `local_id`, `observaciones` — para
que el frontend pueda señalar el campo exacto en el formulario, no solo
mostrar un mensaje genérico.

### Archivos modificados

- `src/routes/index.js` — `POST /insumos` reescrito: resolución de local
  separada en dos preguntas independientes; `campo` agregado a todas sus
  respuestas 400/422; fix de la comparación de `local_id` explícito para
  roles operativos.
- `test/insumos-creacion-local-no-obligatorio.test.js` — **nuevo**, 7
  tests (los 4 casos pedidos + el caso ambiguo que sigue pidiendo
  desambiguar + el formato `campo` de los errores).

### Evidencia

Los 4 casos pedidos, contra el servidor real, ANTES del fix (reproducido
para confirmar la causa raíz) → los 3 que no mandaban `local_id` suelto
daban `400`; DESPUÉS del fix → los 4 dan `201`:

```
Caso 1 (sin stock, un local vía local_id):              201
Caso 2 (sin stock, varios locales seleccionados):        201
Caso 3 (con stock, apuntando a uno de los seleccionados):201
Caso 4 (todos los locales):                              201
```

Caso ambiguo (con stock inicial Y varios locales seleccionados, sin
`local_id` explícito) sigue pidiendo desambiguar, correctamente:
`400 { "campo": "local_id", "error": "Elige a qué local va el stock
inicial: ..." }`.

Regresión de permisos reverificada tras el fix nuevo: Cajero con
`local_id` de otro local (explícito, sin flags) → `403 { "error": "No
puedes operar sobre un local distinto al tuyo." }`.

`npm test` → **75/75 passing** (68 previos sin regresión + 7 nuevos),
estable en 3 corridas consecutivas.

---

## Ronda 17 (esta entrega) — Administrador/Superadministrador operan sobre cualquier local; roles operativos, forzados y con 403 real

### Punto 1 — El planteo estaba al revés: se corrige

`resolverLocalDeTrabajo` (usado por `POST /insumos` y `POST /empaques`)
trataba a un Administrador CON `local_id` propio exactamente igual que a
un Cajero: "se usa el suyo, automático e inmutable — cualquier local_id
distinto en el body se ignora" (comentario original). Y `POST /compras`
tenía el problema opuesto: cualquier rol, incluido uno operativo, podía
mandar un `local_id` distinto al suyo y la compra se registraba igual
("una compra puede ser para otro local" aplicaba también a Cajero/
Bartender, que no debería).

Se reemplaza por un único helper compartido —
`resolverLocalOperativo`/`puedeElegirCualquierLocal` (nuevo, en
`routes/index.js`) — con la regla correcta:

- **Administrador / Superadministrador** (`rol === 'Administrador'` o
  `es_superadmin === true`, que en la práctica es siempre el mismo rol
  con el flag): SIN restricción de local. El body manda si trae
  `local_id`; si no, se usa su propio local (si tiene) como
  conveniencia — nunca como límite.
- **Cualquier otro rol** (Cajero, Bartender, o el que se agregue
  después): SIEMPRE su propio local, nunca el del body. Si el body manda
  uno DISTINTO al suyo, se rechaza con **403** (antes: se ignoraba en
  silencio, sin avisar).

Se aplicó en los endpoints que de verdad deciden "a qué local le pega
esta operación":

| Endpoint | Antes | Ahora |
|---|---|---|
| `POST /insumos` | Admin con local propio, forzado igual que Cajero | Admin libre; Cajero forzado + 403 |
| `POST /empaques` | (mismo helper, mismo bug) | (mismo fix) |
| `POST /compras` | Cualquier rol podía mandar cualquier local | Admin libre; Cajero forzado + 403 |
| `POST /pedidos` | Solo `rol==='Cajero'` se forzaba; Bartender no | Cualquier rol no-Administrador se fuerza + 403; Bartender incluido |
| `PATCH /pedidos/:id/estado` | Sin ningún chequeo de local (podía entregar/descontar stock de OTRO local) | 403 si el pedido es de un local distinto al del rol operativo |
| `POST/PUT/DELETE /insumos/:id/locales[...]` | Sin chequeo — un Cajero podía ajustar el stock de cualquier local | 403 si el local del path/body no es el suyo |
| `POST/PUT/DELETE /empaques/:id/locales[...]` | Ídem | Ídem |

`PATCH /pedidos/:id/estado` era el hallazgo más serio: no tenía NINGÚN
chequeo de local — cualquier Cajero autenticado podía marcar como
"entregado" (y descontar el inventario de) un pedido de OTRO local. Un
pedido sin local asignado (`local_id IS NULL`, "reclamable") sigue sin
bloquear a nadie — es justo el caso pensado para que cualquier local lo
tome.

**Fuera de alcance, reportado pero no tocado**: los filtros `?local_id=`
de los GET de listado (ver pedidos/compras/insumos) — son de LECTURA, no
de escritura, y el pedido explícito fue sobre "registrar"/"operar", no
sobre visibilidad de listados; ampliar esto es una decisión aparte.
`PATCH /pedidos/:id/confirmar-pago` y `/comprobante/aprobar|rechazar` no
mueven stock ni local, así que no aplicaba el mismo chequeo.

### Punto 2 — Mensajes: elegir, no "faltar"

- Superadministrador/Administrador sin `local_id` en el body ni propio:
  `"Elige a qué local corresponde esta operación: como Administrador
  puedes operar sobre cualquier local activo."` — antes decía "no tienes
  un local fijo", planteando la libertad del rol como una carencia.
- Rol operativo sin ningún local asignado en absoluto (una
  desconfiguración real, a diferencia del caso anterior): se mantiene el
  mensaje "Tu usuario no tiene un local de trabajo asignado: pide a un
  administrador que te asigne uno" — corregido el voseo que quedaba
  ("pedile" → "pide") en `POST /pedidos`.
- Nuevo mensaje para el rechazo real: `"No puedes operar sobre un local
  distinto al tuyo."` (403, en todos los endpoints de la tabla de arriba).

### Archivos modificados

- `src/routes/index.js` — `resolverLocalOperativo`/
  `puedeElegirCualquierLocal`/`responderErrorLocal`/`sinAccesoALocal`
  (nuevos, compartidos); reemplaza `resolverLocalDeTrabajo` y la lógica
  inline de `POST /compras`; `esSuperadmin` (ya no se usaba) eliminada;
  chequeos agregados en `POST /pedidos`, `PATCH /pedidos/:id/estado`, y
  los 6 endpoints anidados de locales de insumos/empaques.
- `test/permisos-local.test.js` — **nuevo**, 6 tests.

### Endpoints donde cambió la validación de local

`POST /insumos`, `POST /empaques`, `POST /compras`, `POST /pedidos`,
`PATCH /pedidos/:id/estado`, `POST /insumos/:id/locales`,
`PUT /insumos/:id/locales/:localId`, `DELETE /insumos/:id/locales/:localId`,
`POST /empaques/:id/locales`, `PUT /empaques/:id/locales/:localId`,
`DELETE /empaques/:id/locales/:localId`.

### Evidencia

- Administrador registra una compra en `Local Villa Liliam` (`201`,
  `localId: 3`) y otra en `Local 3 Esquinas` (`201`, `localId: 4`) — sin
  ningún cambio de rol ni configuración entre una y otra.
- Administrador crea un insumo en cada uno de los dos locales — ambos
  `201`.
- Cajero (creado y asignado a `Local Villa Liliam`) registra una compra
  en su propio local → `201`. Intenta la misma compra en
  `Local 3 Esquinas` → `403 { "error": "No puedes operar sobre un local
  distinto al tuyo." }`.
- Cajero intenta crear un insumo en el local ajeno → mismo `403`.
- Superadministrador sin `local_id` propio ni en el body →
  `400 { "error": "Elige a qué local corresponde esta operación: como
  Administrador puedes operar sobre cualquier local activo." }` — nunca
  "no tienes un local fijo".
- `npm test` → **69/69 passing** (63 previos sin regresión + 6 nuevos),
  estable en 2 corridas consecutivas.

---

## Ronda 16 (esta entrega) — Stock inicial validado contra los locales seleccionados, mensajes de error sin jerga técnica ni voseo

### Punto 1 — Stock inicial solo en locales donde el insumo existe

`POST /insumos` ya distinguía "en qué locales existe el insumo"
(`todosLosLocales`) de "a qué local va la cantidad inicial" (`local_id`,
resuelto por `resolverLocalDeTrabajo`), pero nada cruzaba uno contra el
otro. Se agrega el tercer caso real que le faltaba al modelo — un
multi-select explícito — y la validación cruzada entre los tres:

- `todosLosLocales=true` → cualquier local Activo es válido para el stock inicial.
- `localesSeleccionados=[ids...]` (nuevo, opcional) → el multi-select real
  del formulario; se valida que sean ids reales, y que `local_id` (el que
  recibe el stock) esté DENTRO de esa lista — 400 claro si no.
- Ninguno de los dos → se asume un único local seleccionado: el mismo que
  ya se resolvió como `local_id` (comportamiento de siempre, el backend lo
  asume aunque el front no mande la lista explícita — compatibilidad
  total con cualquier integración existente).

La siembra de `insumo_local` (qué locales quedan `activo=true`) ahora usa
este mismo conjunto ya validado, en vez de repetir la lógica aparte —
así `localesSeleccionados`, si se manda, activa exactamente esos locales
(no solo el que recibe el stock).

### Punto 2 — Mensajes sin jerga técnica ni voseo

El mensaje del Superadministrador (y su par para un usuario sin local
asignado) usaban voseo ("tenés", "elegí", "pedí") — inconsistente con el
resto del sistema, que usa tuteo en todos los demás mensajes de error
("No tienes permiso...", "Debes seleccionar...", "Solo puedes
desactivarlo."). Se corrigieron a tuteo y se les quitó la mención al
nombre técnico del campo (`campo "local_id"`).

Se revisó el resto del backend (`grep` de patrones de voseo y de nombres
de campo entre comillas en mensajes de error) y se encontraron 6 mensajes
más con el mismo problema (todos en `routes/index.js`, ninguno en
`auth.js`/`validaciones.js`/`crud.js`): `POST /insumos/:id/locales`,
`POST /empaques/:id/locales`, `producto_empaque` (validación de
`producto_id`), `POST /compras` (también voseo), y 3 en el endpoint de
devoluciones de pedidos (`item_index`/`producto_id` mencionados
literalmente). Todos corregidos.

### Archivos modificados

- `src/routes/index.js` — validación cruzada de stock inicial/locales
  seleccionados en `POST /insumos`; 8 mensajes de error reescritos (1 de
  ellos, además del voseo, tenía jerga técnica).
- `test/insumo-locales-seleccionados.test.js` — **nuevo**, 4 tests.

### Endpoints cambiados

- `POST /insumos` — acepta `localesSeleccionados` (array opcional de ids
  de local); 400 si `local_id` no está dentro de esa lista (y no se mandó
  `todosLosLocales`).

### Evidencia

- `POST /insumos` con `local_id` apuntando a un local FUERA de
  `localesSeleccionados` → `400 { "error": "El local del stock inicial
  debe estar entre los locales donde marcaste que este insumo existe." }`
  (confirmado contra el servidor real, con dos locales reales de la base).
- Mismo caso pero con `local_id` SÍ incluido en `localesSeleccionados` →
  `201`, con el stock cayendo exactamente en ese local y el resto de los
  seleccionados quedando activos en 0.
- `todosLosLocales=true` sigue aceptando cualquier local activo, incluso
  sin `localesSeleccionados`.
- Sin ninguno de los dos campos → sigue funcionando exactamente como
  antes (un solo local activo: el resuelto).
- Mensaje del Superadministrador, confirmado contra el servidor real:
  `"Como Superadministrador no tienes un local fijo: elige a qué local
  pertenece este insumo."` — tuteo, sin nombre de campo.
- `npm test` → **63/63 passing** (59 previos sin regresión + 4 nuevos).

---

## Ronda 15 (esta entrega) — Base de datos DEDICADA para tests (causa raíz de los datos de prueba), limpieza real, catálogo del cliente verificado, validación de rango de fechas

### Punto 1 — Causa raíz de la regeneración de datos de prueba: CONFIRMADA

`npm test` corría contra la MISMA base de datos que el servidor de
desarrollo (`DB_NAME=sicaber` del `.env`, sin ninguna otra separación).
Confirmado en vivo: `test/*.test.js` se conectan directo a
`process.env.DB_HOST/DB_NAME/...` (igual que `src/config/db.js`) y además
llaman a la API en `http://localhost:4000`, el servidor de desarrollo
real. Cada corrida de la suite (corrida decenas de veces a lo largo de
este proyecto) dejaba insumos/productos/pedidos/ventas/compras de prueba
reales ahí — la mayoría no se podían borrar solos porque terminaban con
una venta o compra real asociada (el mismo candado que protege datos
reales de un local bloqueaba también el cleanup de los tests).

**Solución aplicada — base de datos dedicada** (de las 3 opciones
planteadas: base dedicada, transacciones con rollback por test, fixtures
autolimpiables — se descartó "transacciones por test" por ser mucho más
invasivo para tests de integración sobre HTTP real, no acceso directo a
Postgres):

- `scripts/run-tests.js` (nuevo, lo que corre `npm test` ahora):
  `DROP DATABASE IF EXISTS sicaber_test` + `CREATE DATABASE sicaber_test`
  en CADA corrida (base 100% limpia, siempre) → arranca `src/index.js`
  como proceso aparte con `DB_NAME=sicaber_test`/`PORT=4099` → espera la
  línea `✅ Migraciones verificadas` (no solo "responde algo": Express
  escucha antes de que terminen las migraciones) → corre
  `node --test --test-concurrency=1` contra ese servidor → mata el
  servidor de test al terminar. El servidor de desarrollo (`sicaber`,
  puerto 4000) nunca se toca.
- **Bug real encontrado al armar esto**: `schema.sql` NUNCA se ejecutaba
  desde ningún lado — solo era un archivo de referencia. `config/db.js`
  únicamente define ~13 `CREATE TABLE` (los agregados ronda a ronda);
  las ~10 tablas base (usuarios, clientes, productos, pedidos, ventas,
  compras, locales...) solo existían en `schema.sql`. Esta app NUNCA
  pudo arrancar sola contra una base realmente vacía — dependía de que
  alguien hubiera corrido `schema.sql` a mano, una vez, hace tiempo.
  Se corrige ejecutando `schema.sql` en CADA arranque (`ejecutarSchemaBase()`
  en `config/db.js`, antes de `migrar()`) — seguro de repetir contra la
  base de desarrollo ya poblada porque cada sentencia es idempotente a
  propósito. Se encontraron y corrigieron 2 sentencias que NO lo eran
  (ver "Migraciones" abajo) antes de activar esto.
- `--test-concurrency=1` — documentado a fondo en `test/README.md`
  (nuevo): los archivos de test no están aislados entre sí (comparten
  `sicaber_test`, y varios leen/escriben tablas globales completas), así
  que correrlos en paralelo es una condición de carrera real, no solo una
  cuestión de velocidad.

### Punto 2 — Borrado ejecutado y verificado

`node scripts/limpiar-datos-prueba.js --confirm`: respaldo JSON guardado
en `respaldo-migraciones/limpieza-datos-prueba-1788875475555.json`
(gitignored) antes de borrar nada. Se amplió el patrón de búsqueda del
script de 3 frases fijas a uno solo más amplio (`%test%`) — la lista
cerrada de 3 frases se había quedado corta (un `Insumo test desacople...`
de un archivo de test más nuevo no coincidía con ninguna) — encontrado y
limpiado aparte (0 compras/ventas asociadas, sin riesgo). Verificado
ANTES de borrar que ningún movimiento de inventario de una venta/compra
de prueba apuntara a un insumo fuera de la lista a borrar (0 huérfanos
posibles).

**Conteo antes → después** (en la base de desarrollo real):

| Tabla | Antes | Después |
|---|---|---|
| insumos | 71 (40 reales + 31 de prueba) | 39 (solo reales, tras el borrado del stray) |
| productos | 80 (12 reales + 68 de prueba) | 12 |
| pedidos | 99 (hasta el #99) | 9 |
| ventas | 71 | 3 |
| compras | 36 | 7 |

Todos los `movimientos_inventario`/`insumo_local` asociados a lo borrado
se eliminaron junto con sus filas padre (mismo `--confirm`), así que no
queda stock descuadrado referenciando ventas/compras inexistentes.

**Conteo repetido 30 minutos después**: no se puede simular una espera
real dentro de esta misma respuesta — la garantía real es estructural,
no una promesa: desde este punto en adelante `npm test` nunca vuelve a
tocar `sicaber` (corre contra `sicaber_test`, que se destruye en cada
corrida — ver Punto 1), así que no hay ningún proceso que pueda volver a
sembrar datos de prueba ahí salvo que alguien corra un archivo de test
a mano apuntando explícitamente al servidor de desarrollo (documentado
como caso excepcional, no el flujo normal, en `test/README.md`). El
comando para reverificar en cualquier momento (incluidos esos 30
minutos) es `node scripts/limpiar-datos-prueba.js` (sin `--confirm`,
solo lista) — se deja pendiente que quien lo pida lo corra o me pida que
lo corra de nuevo.

### Punto 3 — Catálogo del cliente: verificado con los 12 productos exactos

Confirmado en vivo, backend real (puerto 4000):
- `GET /productos` (público, vista del cliente): **12** productos, los
  12 nombres exactos pedidos (cafe berna caliente, carajillo, frappe,
  jugo de naranja, capuchino frio, granizado de café, tinto, cafe berna
  frio, perico, cafe con leche, amaretto, cafe helado), todos con precio
  real (no el `$10.000` sospechoso) y con imagen.
- `GET /productos/todos` (selector de Nuevo Pedido, admin): también 12,
  0 con "test" en el nombre.
- **Diagnóstico pedido**: el script SÍ se había dejado pendiente de
  confirmar en la ronda anterior (quedé esperando la confirmación del
  usuario, que nunca llegó a tiempo) — esa es la causa directa de que
  siguieran visibles, sumada a que cada corrida de `npm test` de por
  medio seguía regenerando más (Punto 1). El endpoint del catálogo en sí
  **nunca tuvo un bug de filtrado** — ya filtraba correctamente por
  `estado='Activo'` y por la categoría; simplemente los datos de prueba
  seguían ahí porque nunca se habían borrado de verdad.
- Fichas técnicas, toppings y adiciones de los productos de prueba: 0
  huérfanos — `fichas_tecnicas.producto_id` ya tiene `ON DELETE CASCADE`
  (se confirmó en vivo, cero filas huérfanas tras el borrado); ningún
  topping real referencia un producto de prueba en `productos_ids`
  (verificado: los 5 `producto_id` usados por toppings reales apuntan
  todos a productos reales del menú).

### Punto 4 — Validación de rango de fechas, en los 8 módulos pedidos

Nuevo helper compartido (`errorRangoFechas`, `condicionRangoFechas`/
`condicionRangoFechasDate` en `routes/index.js`, cerca del inicio del
archivo): formato **AAAA-MM-DD** siempre (mismo formato que ya usan
`compras.fecha` y los rangos de descuento de productos/combos — no se
introduce un formato nuevo), rechaza con 400 tanto un formato inválido
como un rango invertido. Aplicado a `?desde=`/`?hasta=` en:

`GET /usuarios`, `GET /empleados`, `GET /clientes`, `GET /combos/todos`,
`GET /ventas`, `GET /compras`, `GET /compras/historial`, `GET /pedidos`,
`GET /fichas-tecnicas`.

Filtra por `created_at` (TIMESTAMP, con "hasta" extendido al final de ese
día para no perder registros creados a media tarde) en todos, EXCEPTO
Compras, que filtra por `fecha` (columna DATE real de la compra, sin
hora — es lo que el usuario realmente entiende como "fecha de la
compra", no cuándo se registró en el sistema).

**Hallazgo importante**: ninguno de estos 8 endpoints aceptaba
`?desde=`/`?hasta=` en absoluto antes de esta ronda — el filtrado por
fecha vivía ENTERAMENTE en el frontend (fetch de todo + filtrar en el
navegador), sin nada que lo respaldara del lado del servidor. Esto
explica directamente el reporte de "filtros que no filtran bien": no
había ningún filtro real del lado del backend que pudiera fallar o
tener un bug — ahora sí lo hay, y validado.

### Archivos modificados

- `scripts/run-tests.js` — **nuevo**: orquestador de `npm test` (base +
  servidor dedicados).
- `test/README.md` — **nuevo**: documenta la arquitectura de tests, la
  causa raíz completa, y por qué `--test-concurrency=1` no es opcional.
- `src/config/db.js` — `ejecutarSchemaBase()` (ejecuta `schema.sql` en
  cada arranque); log de conexión ahora muestra el `DB_NAME` real (antes
  decía "sicaber" fijo, aunque el proceso estuviera conectado a otra
  base).
- `src/config/schema.sql` — las 3 `ADD CONSTRAINT` de FK sin guardar se
  envuelven en `DO $$ ... EXCEPTION WHEN duplicate_object`; las 2
  `UPDATE` sin condición sobre `usuarios` (password/es_superadmin del
  admin) se vuelven condicionales, igual que su equivalente ya existente
  en `config/db.js` — ver "Migraciones" abajo.
- `src/routes/index.js` — helper compartido de rango de fechas; `?desde=/
  ?hasta=` en los 8 endpoints listados arriba; fix de `estado` NULL en
  `POST/PUT /proveedores` (mismo bug que se corrigió en `crud.js` la
  ronda pasada, encontrado al preparar un fixture de test contra la base
  vacía).
- `test/inventario-por-local.test.js` — crea su propio proveedor de
  prueba (antes asumía que ya existía uno Activo en la base — cierto
  contra la base de desarrollo compartida, falso contra `sicaber_test`).
- `test/rango-fechas.test.js` — **nuevo**, 28 tests (3 por cada uno de
  los 9 endpoints/variantes + 1 de filtrado real).
- `scripts/limpiar-datos-prueba.js` — patrón ampliado de 3 frases fijas a
  uno solo (`%test%`), con la razón documentada en el propio archivo.
- `package.json` — `"test": "node scripts/run-tests.js"`.

### Migraciones + rollback

- `schema.sql`, FKs `insumo_local_local_id_fkey` / `empaque_local_local_id_fkey`
  / `movimientos_inventario_local_id_fkey`: se envuelven en
  `DO $$ ... EXCEPTION WHEN duplicate_object THEN NULL; END $$;` — mismo
  efecto final, ahora seguro de repetir. Sin rollback necesario (no
  cambia ningún dato, solo hace la sentencia idempotente).
- `schema.sql`, `UPDATE usuarios SET password=...`/`SET es_superadmin=...`
  para `Admin_Sicaber`: se agrega la misma condición que ya tenía la
  migración equivalente en `config/db.js` (solo corrige si la contraseña
  sigue siendo el hash roto original; solo marca `es_superadmin` si no lo
  tenía). **Bug real que esto evita**: sin la condición, activar
  `schema.sql` en cada arranque habría pisado la contraseña del admin en
  cada reinicio del servidor, aunque alguien ya la hubiera cambiado
  legítimamente. Verificado en vivo contra la base de desarrollo antes de
  activar el cambio: el hash quedó exactamente igual después de correr
  `schema.sql`.
- Borrado de datos de prueba (Punto 2): ver tabla de conteos arriba;
  respaldo completo en `respaldo-migraciones/` (gitignored).

### Endpoints nuevos/cambiados

- `GET /usuarios`, `/empleados`, `/clientes`, `/combos/todos`, `/ventas`,
  `/compras`, `/compras/historial`, `/pedidos`, `/fichas-tecnicas` —
  todos aceptan `?desde=AAAA-MM-DD&hasta=AAAA-MM-DD` (ambos opcionales,
  independientes); 400 si el formato es inválido o si "hasta" es
  anterior a "desde".
- `POST/PUT /proveedores` — ya no falla con 500 si no se manda `estado`
  explícito (usa `'Activo'`/el que ya tenía, según corresponda).

### Evidencia

- `npm test` → **59/59 passing**, estable en 3 corridas consecutivas
  (antes 31/31 — 28 tests nuevos de rango de fechas).
- `sicaber_test` recreada desde cero, boot limpio, migraciones completas,
  sin tocar `sicaber` — confirmado revisando el conteo de insumos con
  "test" en el nombre en `sicaber` antes/después de 3 corridas de
  `npm test`: sin cambios.
- Borrado real ejecutado con `--confirm`: conteo antes/después (ver
  tabla arriba), respaldo JSON confirmado en disco.
- `GET /productos` (público) → exactamente los 12 productos del menú
  original, con precio e imagen reales.
- `GET /pedidos?desde=2026-06-30&hasta=2026-01-01` (y los mismos 8
  endpoints) → `400 { "error": "El rango de fechas es inválido: \"hasta\"
  no puede ser anterior a \"desde\"." }`.

---

## Ronda 14 (esta entrega) — Contadores por local, borrado de Locales con restricciones, columnas de insumo/unidad en Toppings/Adiciones, categorías de producto con imagen

### Punto 1 — Contadores de Insumos: Todos/Activos/Inactivos/Stock bajo, por local

Causa raíz: no existía NINGÚN endpoint que contara "por local" — lo único
disponible era `insumos.estado` (Activo/Inactivo del CATÁLOGO global), un
concepto totalmente distinto de `insumo_local.activo` (¿se ofrece este
insumo EN ESE LOCAL?, que es lo que corresponde a la pestaña de local del
frontend). Si el frontend contaba por `estado` global, el número nunca
podía cambiar entre pestañas — exactamente el síntoma reportado (56/39/17
fijo). Nuevo endpoint `GET /insumos/contadores?local_id=` que cuenta
EXCLUSIVAMENTE por `insumo_local.activo`/`stock` de ese local — `local_id`
es obligatorio a propósito (400 sin él), para que un total global nunca
pueda volver a colarse por accidente. "Ver solo stock bajo": ya funcionaba
bien en `GET /insumos?local_id=&stockBajo=true` (probado en vivo, filtra
correctamente); lo que faltaba era el contador en sí, que ahora usa el
mismo `calcularEstadoStock` que ese filtro, así nunca quedan desincronizados.

### Punto 2 — DELETE /locales/:id: se habilita el borrado real

El endpoint YA existía (de una ronda anterior) pero con un bug que en la
práctica lo hacía inútil: bloqueaba si `insumo_local`/`empaque_local`
tenían CUALQUIER fila para ese local — y como todo insumo/empaque tiene
una fila en TODOS los locales (por diseño, con stock 0 si nunca se usó
ahí), esto bloqueaba SIEMPRE, para cualquier local. Se corrigió para
bloquear solo si esas filas tienen STOCK REAL (`stock <> 0`) — nunca por
su sola existencia. Categorías que bloquean ahora: ventas, pedidos,
empleados asignados, compras registradas (los 4 pedidos explícitamente) —
más dos chequeos de seguridad agregados (no pedidos explícitamente, pero
necesarios para no romper algo real):
- **usuarios con sesión fija en ese local** — su FK no tiene `ON DELETE`,
  así que sin este chequeo el borrado tronaría con un error crudo de
  integridad referencial en vez de un 409 legible;
- **movimientos_inventario con historial en ese local** — misma razón (FK
  sin `ON DELETE`).

Insumo/empaque con stock en CERO no bloquea: esas filas se eliminan solas
al borrar el local (ya tenían `ON DELETE CASCADE` en su FK — no hizo falta
agregar ningún DELETE manual).

**Bug de concurrencia encontrado y corregido en el camino**: al probar
esto con la suite completa corriendo en paralelo (varios archivos de test
creando/borrando locales e insumos al mismo tiempo), aparecieron
violaciones de FK reales: `POST /insumos` siembra una fila de
`insumo_local` por CADA local existente (y `POST /locales` una fila por
CADA insumo existente) — si ese local/insumo se borra justo entre el
`SELECT` y el `INSERT` de la siembra (dos peticiones simultáneas de
verdad, no solo un test), la petición completa fallaba con 500 por un
registro que dejó de importar. Se corrigió: cada INSERT de la siembra
atrapa específicamente el código 23503 (viola FK) y salta esa fila sola,
en vez de tumbar toda la creación.

### Punto 3 — Toppings/Adiciones: insumo, cantidad y unidad en el listado

`cantidad_por_uso` (columna `cantidad`) y `insumo_id` opcional ya existían
de la ronda anterior, con su validación por unidad. Lo que faltaba: el
listado (`GET /toppings`, `GET /adiciones`, y las respuestas de
POST/PUT/PATCH) solo traía `insumo_id`/`empaque_id` crudos — ahora
incluyen `insumoNombre`/`insumoUnidad` (o `empaqueNombre`/`empaqueUnidad`)
resueltos con un LEFT JOIN, listos para mostrarse como columna sin que el
frontend tenga que resolverlos aparte.

### Punto 4 — Categorías de producto con imagen

Nueva columna `categorias.imagen` (TEXT, URL — mismo criterio que
`productos.imagen`/`combos.imagen`: el backend nunca procesa el archivo,
solo guarda la URL). Aplica al módulo de Categorías de PRODUCTO
(`/categorias`), no a Categorías de Insumo (`/categorias-insumos`, que es
un catálogo distinto sin imagen). Como `productos.categoria` guarda el
NOMBRE de la categoría (no un id — no hay FK), se expone también
`categoriaImagen` en `GET /productos`/`GET /productos/:id` (públicos, los
que consume la vista del cliente) vía subquery por nombre normalizado.

**Bug encontrado y corregido al probar esto**: el `crud()` genérico
(compartido por `categorias`, `roles`, y usado por `toppings`/`adiciones`
hasta la ronda pasada) insertaba `NULL` explícito para cualquier campo no
enviado — incluyendo `estado`, que tiene `NOT NULL DEFAULT 'Activo'` — así
que crear una categoría sin mandar `estado` explícito (ej. un formulario
que solo pide nombre + imagen) fallaba con una violación de NOT NULL
cruda. Se corrigió en el propio `crud.js`: si `estado` no viene, ahora
usa `'Activo'` en vez de `NULL` — corrige el problema para TODAS las
tablas que usan este helper, no solo categorías.

### Punto 5 — Limpieza de datos de prueba: LISTA actualizada, NADA borrado todavía

Se reutilizó `scripts/limpiar-datos-prueba.js` (ya existía de la ronda
pasada) — se corrió de nuevo en modo lista/respaldo (sin `--confirm`) para
reflejar los registros nuevos acumulados desde entonces. Encontrado esta
vez: 25 insumos, 50 productos, 50 pedidos, 50 ventas, 23 compras (100% de
prueba, todas `anuladas`), 200 filas de `insumo_local`, 80 de
`movimientos_inventario`. 0 compras mixtas. Todo respaldado en
`respaldo-migraciones/limpieza-datos-prueba-*.json`; nada borrado —
pendiente de confirmación.

### Archivos modificados

- `src/routes/index.js` — `GET /insumos/contadores`; `DELETE
  /locales/:id` reescrito (categorías de bloqueo correctas); siembra de
  `insumo_local` en `POST /insumos`/`POST /locales` tolerante a la
  carrera de FK; `TOPPING_SELECT`/`ADICION_SELECT` con join a
  insumo/empaque; `categorias` (crud) con campo `imagen`;
  `PRODUCTO_COLS_PUBLICO` con `categoriaImagen`.
- `src/routes/crud.js` — fix de `estado` NULL vs. `'Activo'` por defecto.
- `src/config/db.js` — `ALTER TABLE categorias ADD COLUMN IF NOT EXISTS imagen TEXT`.
- `src/config/schema.sql` — `categorias.imagen` en el `CREATE TABLE`.
- `test/contadores-y-borrado-local.test.js` — **nuevo**, 5 tests.
- `test/toppings-adiciones-venta.test.js` — 2 aserciones nuevas (insumoNombre/insumoUnidad en la respuesta y en el listado).
- `package.json` — `test` corre ahora con `--test-concurrency=1` (ver
  "flakiness" abajo).

### Flakiness de la suite encontrada y corregida (aparte del fix de FK del punto 2)

Con la corrección de la carrera de FK ya aplicada, la suite completa
todavía falló una vez de forma intermitente en una aserción NUEVA propia
(`enA.data.todos === enB.data.todos`) — no por un bug de producto, sino
porque `node --test` corre los ARCHIVOS de test en paralelo por defecto, y
esa aserción compara dos números que dependen de la tabla `insumos`
COMPLETA (compartida por todos los archivos): si otro archivo crea/borra
un insumo justo entre mis dos peticiones, el número cambia a mitad de
prueba. Ningún archivo de test de este proyecto está pensado para correr
en paralelo con otro (todos comparten la misma base viva, sin
aislamiento) — se agrega `--test-concurrency=1` al script `test` para que
los archivos corran uno a la vez, como siempre se asumió implícitamente.
Verificado con 3 corridas consecutivas de la suite completa, sin fallos.

### Migraciones + rollback

- `categorias.imagen` (TEXT, nullable). Rollback: `ALTER TABLE categorias
  DROP COLUMN IF EXISTS imagen`.
- Sin migraciones de columnas para los puntos 1-3 (usan columnas ya
  existentes de rondas anteriores).

### Endpoints nuevos/cambiados

- `GET /insumos/contadores?local_id=<id>` — nuevo. `{ todos, activos,
  inactivos, stockBajo }`, contados por `insumo_local` de ESE local.
  400 si falta `local_id`.
- `DELETE /locales/:id` — mismo contrato (409 con detalle, 200 al
  borrar), categorías de bloqueo corregidas (ver punto 2).
- `GET/POST/PUT/PATCH /toppings`, `/adiciones` — ahora incluyen
  `insumoNombre`, `insumoUnidad`, `empaqueNombre`, `empaqueUnidad`.
- `GET/POST/PUT /categorias` — aceptan/devuelven `imagen`.
- `GET /productos`, `GET /productos/:id` (públicos) — incluyen
  `categoriaImagen`.

### Evidencia

- `GET /insumos/contadores?local_id=3` → `{ todos: 57, activos: 57,
  inactivos: 0, stockBajo: 12 }`; mismo local 4 → `{ todos: 57, activos:
  41, inactivos: 16, stockBajo: 39 }` — cambia según el local, confirmado
  con 3 locales distintos.
- `DELETE /locales/3` (con empleados/ventas/compras reales) → `409 {
  "error": "No se puede eliminar: tiene 37 ventas, 40 pedidos, 2
  empleados asignados, 24 compras registradas, ... . Elimina, reasigna o
  transfiere esos registros primero." }`.
- Local nuevo vacío → `POST /locales` → `201`; `DELETE` inmediato → `200`;
  confirmado `0` filas de `insumo_local` restantes (cascada automática).
- Topping creado con `insumo_id`+`cantidad=0.03` → respuesta y listado
  incluyen `insumoNombre`/`insumoUnidad` (`"kg"`).
- Categoría creada con `imagen` (sin mandar `estado`) → `201`, `estado:
  "Activo"` por defecto; producto de esa categoría → `GET
  /productos/:id` público trae `categoriaImagen` resuelto.
- `scripts/limpiar-datos-prueba.js` (sin `--confirm`): listó 25 insumos,
  50 productos, 50 pedidos, 50 ventas, 23 compras — 0 borrados, respaldo
  guardado.
- `npm test` → **31/31 passing** (26 previos sin regresión + 5 nuevos),
  estable en corridas consecutivas (se descartó que el fix de
  concurrencia hubiera dejado algo flaky).

---

## Ronda 13 (esta entrega) — Insumo desacoplado de Topping/Adición, consumo real validado, cliente sin dirección, limpieza de datos de prueba

### Punto 1 — Se quitan los flags es_topping/es_adicion/es_insumo del Insumo

Auditoría hecha ANTES de tocar nada (ver el comentario histórico ya en
`config/db.js`, sección "TIPO DE USO DEL INSUMO"): estos tres flags NUNCA
condicionaron el descuento de stock ni ninguna otra regla real — eran
puramente un filtro informativo para sugerir/restringir candidatos en los
selectores de Toppings/Adiciones/Ficha Técnica. La fuente de verdad real
de "qué insumo usa este topping/esta adición" siempre fue (y sigue siendo)
`toppings.insumo_id` / `adiciones.insumo_id` — **no hubo nada que migrar**:
esas columnas no cambian con esta ronda.

Se eliminaron: las tres columnas, el CHECK `insumos_tipo_uso_check`, la
función `resolverFlagsTipoUso`/`ERROR_TIPO_USO_INSUMO`, y los filtros
`GET /insumos?esTopping=` / `?tipo=topping|adicion|insumo`. Los módulos de
Toppings y Adiciones ahora buscan entre TODOS los insumos Activos (con
`?estado=Activo&q=`), sin ninguna restricción previa.

### Punto 2 — Toppings/Adiciones: consumo real de insumo, validado

Antes `crud('toppings', [...])`/`crud('adiciones', [...])` eran un CRUD
genérico que aceptaba `insumo_id`/`cantidad` **sin validar nada**: ni que
el insumo existiera, ni que la cantidad respetara su unidad real. Se
reemplazó por routers propios (`toppingRouter`/`adicionRouter` en
`routes/index.js`) con `resolverConsumoToppingAdicion()`:

- `insumo_id` (descuenta de un INSUMO) y `empaque_id` (descuenta de un
  EMPAQUE) son **opcionales y mutuamente excluyentes** — una adición sin
  ninguno de los dos es un extra de solo precio; su `cantidad` se guarda
  en `0` sin importar qué llegue en el body.
- Si se elige uno de los dos, `cantidad` (la "cantidad por uso") es
  **obligatoria** y se valida contra la unidad REAL de ese insumo/empaque
  (mismo `errorCantidadPorUnidad` que ya usan Insumos/Compras/Ficha
  Técnica: entero si la unidad es "unidad", decimal para kg/g/lb/oz/L/mL).
- **Sin ningún UNIQUE** sobre `insumo_id`/`empaque_id`: el mismo insumo
  puede ser la base de varios toppings/adiciones distintos, cada uno con
  su propia cantidad, y puede ser topping en un producto y adición en
  otro a la vez (confirmado con evidencia — ver abajo).

### Punto 3 — Toppings: relación con productos, expuesta y filtrable

`toppings.productos_ids` (JSONB, `[]` = aplica a todos) ya existía; se
agregó `GET /toppings?producto_id=<id>` para que el catálogo del pedido
pida directamente "los toppings válidos para ESTE producto" (los
universales `[]` MÁS los que lo incluyen explícito) en vez de traer todos
y filtrar en el navegador. Se corrigió además que los ids se guarden
siempre como número (`normalizarProductosIds`): un id llegado como string
nunca hacía match contra el containment `jsonb @>` usado por el filtro.

### Punto 4 — Descuento de stock al vender toppings/adiciones

Ya estaba implementado (`calcularRecetaEfectiva`/`descontarInventarioPorVenta`,
de una ronda anterior a esta): al vender, además de la receta de la ficha
técnica (+ vaso/pitillo), se descuenta la `cantidad_por_uso` de cada
topping que el cliente MANTUVO y de cada adición que eligió — solo si
tienen `insumo_id`/`empaque_id` asociado, únicamente en el LOCAL de la
venta. Se agregaron los tests que faltaban (`test/toppings-adiciones-venta.test.js`)
para probarlo explícitamente: topping con insumo, adición con insumo,
adición SIN insumo (no descuenta nada) y que ningún otro local se ve
afectado.

### Punto 5 — Cliente: se retira dirección/comuna/ciudad de registro

Verificado ANTES de tocar nada que ningún otro flujo dependiera de estos
campos:
- **Domicilios**: `pedidos.direccion_alternativa` es la dirección de
  ENTREGA de cada pedido — una columna propia, capturada en el momento del
  pedido, que **nunca** se leyó de `clientes.direccion`. Los domicilios
  siguen funcionando exactamente igual.
- **Facturas**: este proyecto no tiene ningún concepto de factura.
- **Reportes**: ninguna consulta de reportes/estadísticas referencia estos
  campos.

**Decisión (DROP, no deprecar)**: se eliminan `direccion`, `comuna`,
`departamento`, `municipio` de `clientes` — ningún flujo las necesita y ya
no se piden en ningún formulario. Antes de soltarlas, la migración guarda
un respaldo JSON (`respaldo-migraciones/clientes-*.json`, fuera de
versionado — contiene PII) de cualquier cliente que ya tuviera algo
cargado ahí. En esta base había **4 clientes reales** con datos de
dirección; quedaron respaldados antes del DROP (ver evidencia).

Hallazgo aparte (no se tocó, fuera del alcance de este pedido):
`schema.sql` nunca definió `clientes.username`/`clientes.verificado`
aunque `routes/auth.js` los usa activamente — son columnas reales en la
base de datos que un fresh-install desde `schema.sql` no crearía. Es un
gap preexistente, no introducido por esta ronda; se deja reportado para
que se decida aparte.

### Punto 6 — Limpieza de datos de prueba: LISTA generada, NADA borrado todavía

Se armó `scripts/limpiar-datos-prueba.js`: encuentra todo lo que coincide
con los patrones reales ("test aislamiento", "test vaso-pitillo", "test
topping-adicion"), respalda todo en JSON (`respaldo-migraciones/limpieza-datos-prueba-*.json`)
y, sin `--confirm`, **no borra nada** — corrido así en esta ronda. Lo
encontrado (detalle completo en la respuesta de este cambio):

- 16 insumos, 28 productos, 28 pedidos, 28 ventas, 16 compras (100% de
  prueba, ya todas `anuladas`), 96 filas de `insumo_local`, 52 de
  `movimientos_inventario`.
- 0 compras mixtas (ninguna compra real tiene un ítem de prueba mezclado
  con ítems reales) — de haber alguna, el script la deja intacta.

Pendiente: correr `node scripts/limpiar-datos-prueba.js --confirm` cuando
se confirme la lista.

### Archivos modificados

- `src/config/db.js` — DROP de `es_insumo/es_adicion/es_topping` +
  su CHECK (con log de auditoría), retirados los `ADD COLUMN` que los
  resucitaban en cada arranque; nueva migración de baja de
  `clientes.direccion/comuna/departamento/municipio` con respaldo previo.
- `src/config/schema.sql` — mismos campos retirados de los `CREATE TABLE`
  de `insumos` y `clientes`.
- `src/routes/index.js` — `INSUMO_COLS` sin los tres flags; `GET /insumos`
  sin `?esTopping=`/`?tipo=`; `toppingRouter`/`adicionRouter` nuevos
  (reemplazan el `crud()` genérico) con validación real de consumo;
  `GET /toppings?producto_id=`; `cliRouter` (PUT `/me`, `/mi-perfil`,
  `/:id`) sin los campos de ubicación.
- `src/routes/auth.js`, `src/config/clienteCols.js` — registro/perfil de
  cliente sin dirección/comuna/departamento/municipio.
- `.gitignore` — se agrega `/respaldo-migraciones/` (contiene PII).
- `scripts/limpiar-datos-prueba.js` — **nuevo**, ver punto 6.
- `test/toppings-adiciones-venta.test.js` — **nuevo**, 7 tests.

### Migraciones + rollback

- `insumos`: DROP de `es_insumo`/`es_adicion`/`es_topping` + CHECK. Rollback:
  recrear las tres columnas (`BOOLEAN NOT NULL DEFAULT ...` como estaban) y
  el CHECK — los valores históricos no se conservan en ningún respaldo
  aparte (nunca fueron la fuente de verdad de nada, ver auditoría arriba).
- `clientes`: DROP de `direccion`/`comuna`/`departamento`/`municipio`, con
  respaldo JSON previo de los que tenían dato. Rollback: recrear las
  columnas (`VARCHAR`, nullable) y, si hace falta el dato real, reinsertar
  desde el archivo de respaldo por `id` de cliente.

### Endpoints nuevos/cambiados

- `GET /toppings?producto_id=<id>` — nuevo: toppings válidos para ese producto.
- `POST/PUT /toppings` — ahora validan `insumo_id`/`empaque_id`/`cantidad`/`productos_ids`.
- `POST/PUT /adiciones` — ahora validan `insumo_id`/`empaque_id`/`cantidad`/`descripcion`.
- `GET /insumos` — ya no acepta `?esTopping=`/`?tipo=`.
- `PUT /clientes/me`, `/mi-perfil`, `/:id` — ya no aceptan/devuelven
  `direccion`/`comuna`/`departamento`/`municipio`.
- `POST /auth/cliente/registro` — ídem.

### Evidencia

- `npm test` → **26/26 passing** (19 previos sin regresión + 7 nuevos).
- Topping creado con `insumo_id` + `cantidad=0.02` (unidad kg): `201`,
  guardado tal cual.
- Mismo insumo usado como `insumo_id` de un topping Y de una adición a la
  vez: ambos `201`, sin conflicto.
- Venta con ese topping + una adición con insumo + una adición sin
  insumo: el insumo del topping bajó exactamente su `cantidad_por_uso`, el
  de la adición con insumo también, ningún otro local se movió, y la
  adición sin insumo no descontó nada.
- `clientes` sin `direccion`/`comuna`/`departamento`/`municipio` en el
  esquema; respaldo de 4 clientes reales guardado antes del DROP.
- `scripts/limpiar-datos-prueba.js` (sin `--confirm`): listó 16 insumos, 28
  productos, 28 pedidos, 28 ventas, 16 compras — 0 borrados, respaldo
  completo guardado.

---

## Ronda 12 (esta entrega) — Ciudades sin borrado, Insumo/Proveedor desacoplados de verdad, Compras independiente, stock inicial trazado

### Bug bloqueante encontrado ANTES de empezar (no pedido, pero impedía todo lo demás)

`POST /insumos` devolvía **500**: `el valor nulo en la columna «local_id» de
la relación «insumos» viola la restricción de no nulo`. Causa raíz
confirmada en vivo: `insumos.local_id` — una columna que ninguna parte del
código actual lee, escribe ni inserta — había vuelto a existir como `NOT
NULL` sin default (`information_schema.columns`: `is_nullable='NO'`,
`column_default=NULL`, sin triggers). Rondas anteriores ya habían soltado
`stock`/`stock_minimo`/`local_id` juntas asumiendo que las tres viven o
mueren a la vez; esta vez solo `local_id` volvió, y esa suposición rompió
dos guardas de `config/db.js`:

- El guard de `DROP COLUMN` de `stock`/`stock_minimo`/`local_id` trataba
  las tres como un solo bloque — al faltar `stock`/`stock_minimo` pero
  existir `local_id`, tronaba con `no existe la columna «stock»`.
- `migrarInsumoLocalYEmpaques()` solo comprobaba `local_id` antes de leer
  también `stock`/`stock_minimo` — mismo error, pero esta vez **sin try/catch
  en el sitio de la llamada**, así que tumbaba toda la cadena de `migrar()`
  (`❌ Error de conexión: no existe la columna «stock»`) en cada arranque.

**Corrección:** cada columna se revisa de forma independiente ahora;
`local_id` se suelta sin condición (está probado que no la usa nadie) y
`migrarInsumoLocalYEmpaques()` exige las tres columnas antes de correr su
consulta, no solo una. Verificado: arranque limpio (`✅ Migraciones
verificadas`, sin errores) y `POST /insumos` vuelve a dar `201`.

### Punto 1 — Ciudades: catálogo con 16 base, nunca borrables, buscador

Ya existían las 16 ciudades sembradas y **ningún endpoint DELETE** (mismo
patrón exacto que Categorías de Insumo: agregar / editar / activar-desactivar,
nunca eliminar — ni las 16 base ni una agregada a mano). Lo único que
faltaba era el buscador por nombre para el select del frontend:
`GET /ciudades?q=bog` ahora filtra por `nombre ILIKE`, sin tocar el estado
(una ciudad desactivada se sigue pudiendo encontrar, solo deja de
ofrecerse como opción nueva).

### Punto 2 — Categorías de Insumo: confirmado, sin cambios de código

Revisado línea por línea: `GET/POST/PUT/PATCH estado`, **sin DELETE, sin
`/recategorizar`** — el propio código ya trae el comentario explícito de
por qué se decidió así (`categoria_id` tiene `ON DELETE SET NULL`; una
categoría es solo una etiqueta, nunca algo que un insumo necesite
"proteger"). Confirmado que esto es el módulo de **Categorías de Insumo**
(`/categorias-insumos`), no el módulo independiente de Categorías. Un
insumo con categoría desactivada conserva esa categoría sin cambios.

### Punto 3 — Insumo y Proveedor: ya desacoplados; se quitó una dependencia oculta

`insumos.proveedor_id` ya no existe en la tabla — ronda anterior ya lo
había soltado explícitamente
(`ALTER TABLE insumos DROP COLUMN IF EXISTS proveedor_id`, en
`config/db.js`, con el comentario: "Proveedor e insumo pasan a ser
independientes: solo se relacionan al momento de registrar una compra
puntual — `compras.proveedor_id` sigue existiendo, esa relación NO
cambia"). No hay ninguna tabla puente ni otra columna que los relacione.

Lo que SÍ seguía atado (encontrado al auditar `POST /insumos` para este
punto): una validación residual que **exigía que existiera al menos un
proveedor Activo** para poder crear un insumo — contradice directamente la
independencia pedida. Se eliminó por completo; crear un insumo ya no
consulta la tabla `proveedores` para nada.

**Disposición de datos históricos:** no aplica ninguna decisión nueva
"deprecar vs. eliminar" — la columna ya fue eliminada (no deprecada) en una
ronda anterior, y no quedó ningún dato de proveedor-por-insumo que
migrar (la relación vivía únicamente en esa columna, sin tabla puente).
Rollback de esa migración histórica (si alguna vez hiciera falta reabrir
esa relación): `ALTER TABLE insumos ADD COLUMN proveedor_id INTEGER
REFERENCES proveedores(id)` — quedaría en NULL para todo insumo creado
después de que se soltó, porque ese dato no se conservó en ningún lado.

### Punto 4 — Compras: proveedor e insumo independientes, con buscadores

Ya funcionaba así del lado del backend: `resolverInsumoIdPorNombre()`
resuelve el insumo por nombre contra el catálogo GLOBAL, sin ningún filtro
por proveedor; `validarItemCompra()` no lee ni exige proveedor por ítem; el
detalle de una compra (`COMPRA_COLS`) solo trae `proveedorId`/
`proveedorNombre` **a nivel de la compra completa**, nunca por línea —
confirmado en vivo (ver evidencia). Los campos de la compra (Local,
Proveedor, Fecha, Observaciones, descuento, comprobante) no cambiaron.

Se agregó el buscador que faltaba: `GET /proveedores?q=` (nombre, NIT o
número de documento — sin filtrar por estado). El de insumos por nombre ya
existía (`GET /insumos?q=`).

### Punto 5 — Insumos: stock inicial opcional, observaciones con default, movimiento trazado

`stockActual` ya era opcional (default 0 si no viene) y ya se validaba
según la unidad real del insumo (`errorCantidadPorUnidad`, entero si
`unidad === 'unidad'`, decimal si no) — sin cambios ahí.

Lo nuevo:

- **Columna `insumos.observaciones`** (TEXT, nullable) — campo libre y
  editable, distinto de `descripcion`.
- Si la creación viene **con** cantidad inicial y **sin** observaciones
  propias → se guarda `"Comenzó con cantidad existente"`. Si el usuario sí
  mandó su propio texto, ese se respeta siempre, tenga o no cantidad
  inicial — el default nunca pisa lo que el usuario escribió.
- Editable después con `PUT /insumos/:id` (no es un valor fijo).
- **Trazabilidad real:** si se creó con cantidad inicial, queda una fila en
  `movimientos_inventario` (`tipo: 'ajuste'`, `referencia_tipo:
  'alta_insumo'`) con el local y la cantidad exactos — ya no es solo un
  número suelto en `insumo_local`.

### Punto 6 — Fecha de compra: ya rechazaba futuras; reverificado

`POST /compras` ya comparaba `fecha` contra la fecha de hoy (UTC, por
string `YYYY-MM-DD`) y rechazaba cualquier fecha posterior con 400 — sin
cambios de código, solo reverificado en vivo contra el código actual (ver
evidencia). Acepta hoy y cualquier fecha pasada.

### Archivos modificados

- `src/config/db.js` — guard de `stock/stock_minimo/local_id` reescrito
  (columnas independientes), `migrarInsumoLocalYEmpaques()` exige las tres
  antes de correr, nueva columna `insumos.observaciones`.
- `src/config/schema.sql` — comentario actualizado (mismo patrón que
  `categoria_id`/`descripcion`: `observaciones` se agrega por `ALTER`, no
  en el `CREATE TABLE`, para no adelantarse a la migración).
- `src/routes/index.js` — `GET /ciudades?q=`, `GET /proveedores?q=`,
  eliminada la validación de "proveedor Activo requerido" en
  `POST /insumos`, `observaciones` con default/traza en `POST/PUT
  /insumos`, `INSUMO_COLS` incluye `observaciones`.

### Migraciones + rollback

- `ALTER TABLE insumos ADD COLUMN IF NOT EXISTS observaciones TEXT` —
  idempotente, sin default de columna. Rollback: `ALTER TABLE insumos DROP
  COLUMN IF EXISTS observaciones` (se pierde el texto guardado, nada más
  depende de esta columna).
- El `DROP COLUMN local_id` de `insumos` (bug bloqueante de arriba) es
  irreversible en el sentido de que no había ningún valor real que
  conservar (la columna nunca la llenaba código vigente); si hiciera falta
  recrearla: `ALTER TABLE insumos ADD COLUMN local_id INTEGER` (sin
  `NOT NULL`, para no volver a romper `POST /insumos`).

### Endpoints nuevos/cambiados

- `GET /ciudades?q=<texto>` — búsqueda por nombre, máx 20 resultados.
- `GET /proveedores?q=<texto>` — búsqueda por nombre/NIT/documento, máx 20.
- `GET /insumos?q=<texto>` — ya existía, confirmado como el buscador para
  el selector de insumo de Compras.
- `POST /insumos` — ya no exige que exista un proveedor Activo; acepta
  `observaciones` (con default condicional); registra movimiento si vino
  `stockActual`.
- `PUT /insumos/:id` — acepta `observaciones` editable.
- Ninguna ruta `DELETE /ciudades` ni `DELETE /categorias-insumos` —
  confirmado que no existen (404 `Cannot DELETE`).

### Evidencia (todo verificado en vivo contra el servidor real)

- **16 ciudades** sembradas (`Medellín` … `Valledupar`); `?q=bog` →
  `["Bogotá"]`; `DELETE /ciudades/1` → `404 Cannot DELETE`.
- `DELETE /categorias-insumos/:id` → `404`; `POST
  /categorias-insumos/:id/recategorizar` → `404`.
- Insumo creado **sin proveedor**, con cantidad inicial 5 kg →
  `observaciones: "Comenzó con cantidad existente"`, `stock: 5` solo en el
  local elegido, `estadoStock: "ok"`.
- Insumo creado sin cantidad inicial → `stock: 0`, `observaciones: null`.
- Insumo creado con cantidad inicial **y** observación propia → se respeta
  el texto del usuario, no el default.
- Fila real en `movimientos_inventario` para el insumo anterior:
  `{ tipo: 'ajuste', cantidad: '5.00', referencia_tipo: 'alta_insumo' }`.
- Compra creada con un proveedor cualquiera y un insumo sin relación previa
  → detalle (`GET /compras/:id`) trae `proveedorId`/`proveedorNombre` a
  nivel de compra; cada ítem NO trae proveedor.
- Compra con fecha de mañana → `400 { error: "La fecha no puede ser
  futura — una compra es un hecho ya ocurrido." }`.
- `npm test` — **11/11 passing**, sin regresiones.

---

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
