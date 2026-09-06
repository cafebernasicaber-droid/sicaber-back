# Cambios aplicados

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
