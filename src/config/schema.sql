-- ─────────────────────────────────────────────────────────────
--  SICABER - Esquema PostgreSQL
--  Ejecutar una sola vez en pgAdmin > sicaber > Query Tool
-- ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS roles (
  id          SERIAL PRIMARY KEY,
  nombre      VARCHAR(100) NOT NULL UNIQUE,
  descripcion TEXT,
  permisos    JSONB DEFAULT '[]',
  color       VARCHAR(10),
  created_at  TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS usuarios (
  id            SERIAL PRIMARY KEY,
  nombre        VARCHAR(150) NOT NULL,
  username      VARCHAR(100) NOT NULL UNIQUE,
  password      VARCHAR(255) NOT NULL,
  rol           VARCHAR(100) NOT NULL DEFAULT 'Administrador',
  estado        VARCHAR(20)  NOT NULL DEFAULT 'Activo',
  es_superadmin BOOLEAN      NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMP DEFAULT NOW()
);
-- Migración segura para bases de datos ya existentes en las que la tabla
-- "usuarios" fue creada antes de que existiera la columna es_superadmin.
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS es_superadmin BOOLEAN NOT NULL DEFAULT FALSE;

-- Migración: cada usuario interno (Cajero/Bartender/Administrador) queda
-- asociado a un local físico. 'Local 1' y 'Local 2' son los locales reales;
-- 'Ambos' se usa para roles administrativos que deben ver los pedidos de
-- los dos locales (el Administrador, por ejemplo). Los usuarios ya
-- existentes quedan en 'Local 1' por defecto para no romper nada.
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS sede VARCHAR(20) NOT NULL DEFAULT 'Local 1';
UPDATE usuarios SET sede = 'Ambos' WHERE rol = 'Administrador' AND sede = 'Local 1';

-- Multi-local (Insumos/Compras): local de trabajo del usuario interno, como
-- referencia real a locales.id. Lo usa POST /insumos para asignar
-- automáticamente el local del insumo. NULL para el Administrador ('Ambos').
-- La FK se agrega en config/db.js (después de crear la tabla "locales").
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS local_id INTEGER;

CREATE TABLE IF NOT EXISTS clientes (
  id          SERIAL PRIMARY KEY,
  nombre      VARCHAR(150) NOT NULL,
  correo      VARCHAR(150) NOT NULL UNIQUE,
  password    VARCHAR(255) NOT NULL,
  telefono    VARCHAR(30),
  tipo_doc    VARCHAR(60),
  numero_doc  VARCHAR(30),
  departamento VARCHAR(80),
  municipio   VARCHAR(80),
  comuna      VARCHAR(80),
  direccion   VARCHAR(200),
  estado      VARCHAR(20)  NOT NULL DEFAULT 'Activo',
  created_at  TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS empleados (
  id          SERIAL PRIMARY KEY,
  nombre      VARCHAR(150) NOT NULL,
  cargo       VARCHAR(100),
  telefono    VARCHAR(30),
  correo      VARCHAR(150),
  estado      VARCHAR(20)  NOT NULL DEFAULT 'Activo',
  created_at  TIMESTAMP DEFAULT NOW()
);
-- Migración: local del empleado (solo aplica a Cajero/Bartender) y enlace
-- con su cuenta de acceso real en "usuarios" (username/password/rol).
ALTER TABLE empleados ADD COLUMN IF NOT EXISTS sede VARCHAR(20) NOT NULL DEFAULT 'Local 1';
ALTER TABLE empleados ADD COLUMN IF NOT EXISTS usuario_id INTEGER REFERENCES usuarios(id) ON DELETE SET NULL;
-- Migración: datos de identificación y residencia del empleado. El
-- formulario siempre los pidió y el frontend siempre los envió, pero estas
-- columnas no existían, así que se descartaban en silencio al guardar.
ALTER TABLE empleados ADD COLUMN IF NOT EXISTS tipo_doc   VARCHAR(50);
ALTER TABLE empleados ADD COLUMN IF NOT EXISTS numero_doc VARCHAR(30);
ALTER TABLE empleados ADD COLUMN IF NOT EXISTS direccion  TEXT;
ALTER TABLE empleados ADD COLUMN IF NOT EXISTS local_id   INTEGER;

CREATE TABLE IF NOT EXISTS categorias (
  id          SERIAL PRIMARY KEY,
  nombre      VARCHAR(100) NOT NULL UNIQUE,
  descripcion TEXT,
  estado      VARCHAR(20)  NOT NULL DEFAULT 'Activo',
  created_at  TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS productos (
  id               SERIAL PRIMARY KEY,
  nombre           VARCHAR(150) NOT NULL UNIQUE,
  categoria        VARCHAR(100),
  precio           NUMERIC(10,2) NOT NULL,
  descuento        NUMERIC(5,2)  DEFAULT 0,
  fecha_inicio_desc DATE,
  fecha_fin_desc    DATE,
  descripcion      TEXT,
  imagen           TEXT,
  estado           VARCHAR(20)  NOT NULL DEFAULT 'Activo',
  created_at       TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS toppings (
  id          SERIAL PRIMARY KEY,
  nombre      VARCHAR(100) NOT NULL UNIQUE,
  productos_ids JSONB      DEFAULT '[]',
  -- Insumo que se descuenta del stock al vender este topping, y cuánto de
  -- ese insumo consume una unidad (ej. topping "Shot extra de café" →
  -- insumo "Café en grano", cantidad 0.018 kg). Sin REFERENCES en línea:
  -- "insumos" se crea más abajo en este mismo archivo (después de
  -- "toppings"), y la FK real se agrega aparte una vez que existe — ver el
  -- mismo patrón para fichas_tecnicas.vaso_id en config/db.js.
  insumo_id   INTEGER,
  -- Igual que insumo_id, pero para descontar de un EMPAQUE (ej. "Pitillo
  -- extra") en vez de un insumo — mutuamente excluyente en la práctica.
  -- "empaques" se crea más abajo; FK real agregada aparte en config/db.js.
  empaque_id  INTEGER,
  cantidad    NUMERIC(10,3) DEFAULT 0,
  estado      VARCHAR(20)  NOT NULL DEFAULT 'Activo',
  created_at  TIMESTAMP DEFAULT NOW()
);
-- Migración segura: los toppings nunca tienen costo (se eliminó la
-- columna precio) y ahora se pueden asociar a productos específicos.
-- productos_ids = '[]' significa "aplica a todos los productos".
ALTER TABLE toppings DROP COLUMN IF EXISTS precio;
ALTER TABLE toppings ADD COLUMN IF NOT EXISTS productos_ids JSONB DEFAULT '[]';

CREATE TABLE IF NOT EXISTS adiciones (
  id          SERIAL PRIMARY KEY,
  nombre      VARCHAR(100) NOT NULL UNIQUE,
  precio      NUMERIC(10,2) DEFAULT 0,
  -- Igual que toppings.insumo_id/cantidad: insumo que se descuenta del
  -- stock al vender esta adición, y cuánto de ese insumo consume una
  -- unidad. A diferencia de los toppings, las adiciones no tienen override
  -- por producto (siguen siendo universales, sin producto_id — ver
  -- r.use('/adiciones', ...) en routes/index.js): siempre usan este
  -- "cantidad". Sin REFERENCES en línea por el mismo motivo que
  -- toppings.insumo_id: "insumos" se crea más abajo en este archivo, la FK
  -- real se agrega aparte en config/db.js una vez que existe.
  insumo_id   INTEGER,
  empaque_id  INTEGER, -- igual que toppings.empaque_id
  cantidad    NUMERIC(10,3) DEFAULT 0,
  estado      VARCHAR(20)  NOT NULL DEFAULT 'Activo',
  created_at  TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS combos (
  id          SERIAL PRIMARY KEY,
  nombre      VARCHAR(150) NOT NULL UNIQUE,
  descripcion TEXT,
  precio      NUMERIC(10,2) NOT NULL,
  imagen      TEXT,
  items       JSONB DEFAULT '[]',
  estado      VARCHAR(20)  NOT NULL DEFAULT 'Activo',
  created_at  TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS proveedores (
  id          SERIAL PRIMARY KEY,
  nombre      VARCHAR(150) NOT NULL,
  nit         VARCHAR(50),
  telefono    VARCHAR(30),
  correo      VARCHAR(150),
  direccion   TEXT,
  estado      VARCHAR(20)  NOT NULL DEFAULT 'Activo',
  created_at  TIMESTAMP DEFAULT NOW()
);

-- Insumo: catálogo GLOBAL (un solo registro, sin importar en cuántos
-- locales tenga stock). El stock por local vive en insumo_local, la tabla
-- puente justo debajo — NO en columnas de esta tabla (antes "stock"/
-- "stock_minimo"/"local_id" vivían acá, y un mismo insumo se duplicaba en
-- una fila completa por cada local; ver migrarInsumoLocalYEmpaques en
-- config/db.js para la consolidación de instalaciones existentes).
CREATE TABLE IF NOT EXISTS insumos (
  id              SERIAL PRIMARY KEY,
  nombre          VARCHAR(150) NOT NULL,
  -- Unidad de medida REAL del insumo (nunca una presentación de compra
  -- como caja/paquete/bolsa/docena — eso se resuelve por ítem al registrar
  -- la compra, ver POST /compras). Es inmutable una vez creado el insumo
  -- (ver PUT /insumos/:id): cambiarla después dejaría el stock histórico
  -- expresado en una unidad distinta a la actual, sin ninguna conversión.
  unidad          VARCHAR(50) CHECK (unidad IN ('kg','g','lb','oz','L','mL','unidad')),
  precio_unitario NUMERIC(10,2) DEFAULT 0,
  estado          VARCHAR(20) NOT NULL DEFAULT 'Activo',
  -- categoria_id/descripcion: agregadas por ALTER en config/db.js (junto
  -- con la tabla "categorias_insumos", que se crea ahí, no acá) — no se
  -- duplican en este CREATE TABLE para no adelantarse a esa migración.
  -- Tipo de uso del insumo — un insumo puede ser uno, dos o los tres a la
  -- vez, pero AL MENOS uno debe quedar en true (ver insumos_tipo_uso_check
  -- más abajo). "Empaques" (vasos/pitillos/desechables) NUNCA se crean acá:
  -- ver categoria_id bloqueado a la categoría "Empaques" en POST/PUT
  -- /insumos (routes/index.js) y la tabla "empaques" más abajo.
  -- Definiciones (ver auditoría en CAMBIOS.md): "topping" = adición
  -- GRATUITA y opcional dentro de la ficha técnica (la tabla "toppings"
  -- nunca tiene columna de precio); "adición" = extra que el cliente
  -- agrega y que SÍ tiene costo (la tabla "adiciones" sí tiene "precio").
  -- Esta columna se llamó "es_adicion_sin_costo" hasta que se corrigió el
  -- nombre (contradecía la definición real de "adición").
  es_insumo   BOOLEAN NOT NULL DEFAULT TRUE,  -- ingrediente normal de receta
  es_adicion  BOOLEAN NOT NULL DEFAULT FALSE, -- candidato a ingrediente de una Adición (con costo)
  es_topping  BOOLEAN NOT NULL DEFAULT FALSE, -- candidato a ingrediente de un Topping (gratuito)
  created_at      TIMESTAMP DEFAULT NOW()
);
ALTER TABLE insumos ADD CONSTRAINT insumos_tipo_uso_check
  CHECK (es_insumo OR es_adicion OR es_topping);
-- Nombre de insumo único GLOBALMENTE (un solo registro de catálogo, sin
-- importar en cuántos locales tenga stock — ver insumo_local).
CREATE UNIQUE INDEX IF NOT EXISTS insumos_nombre_uidx ON insumos (lower(btrim(nombre)));

-- Stock/mínimo de UN insumo en UN local — la tabla puente del requisito 1.
-- Reemplaza el modelo anterior (una fila de "insumos" completa por local).
CREATE TABLE IF NOT EXISTS insumo_local (
  id           SERIAL PRIMARY KEY,
  insumo_id    INTEGER NOT NULL REFERENCES insumos(id) ON DELETE CASCADE,
  local_id     INTEGER NOT NULL, -- REFERENCES locales(id): "locales" se crea más abajo; FK real en config/db.js
  stock        NUMERIC(10,2) NOT NULL DEFAULT 0,
  stock_minimo NUMERIC(10,2) NOT NULL DEFAULT 0,
  activo       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMP DEFAULT NOW(),
  UNIQUE(insumo_id, local_id)
);

-- Empaques (vasos, pitillos, desechables) — separados de "insumos"
-- (requisito 4): no son perecederos, no llevan receta y se descuentan por
-- PRODUCTO/TAMAÑO (ver producto_empaque más abajo), no por ficha técnica.
-- Mismo patrón exacto que insumos/insumo_local.
CREATE TABLE IF NOT EXISTS empaques (
  id              SERIAL PRIMARY KEY,
  nombre          VARCHAR(150) NOT NULL UNIQUE,
  descripcion     TEXT,
  unidad          VARCHAR(50) NOT NULL DEFAULT 'unidad'
                    CHECK (unidad IN ('kg','g','lb','oz','L','mL','unidad')),
  precio_unitario NUMERIC(10,2) DEFAULT 0,
  estado          VARCHAR(20) NOT NULL DEFAULT 'Activo',
  created_at      TIMESTAMP DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS empaque_local (
  id           SERIAL PRIMARY KEY,
  empaque_id   INTEGER NOT NULL REFERENCES empaques(id) ON DELETE CASCADE,
  local_id     INTEGER NOT NULL, -- REFERENCES locales(id): FK real en config/db.js
  stock        NUMERIC(10,2) NOT NULL DEFAULT 0,
  stock_minimo NUMERIC(10,2) NOT NULL DEFAULT 0,
  activo       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMP DEFAULT NOW(),
  UNIQUE(empaque_id, local_id)
);

-- Movimientos de inventario: kardex/auditoría de cada ajuste de stock
-- (compra, anulación de compra, venta) con su local — puramente aditivo,
-- el stock vigente sigue viviendo en insumo_local/empaque_local.
CREATE TABLE IF NOT EXISTS movimientos_inventario (
  id              SERIAL PRIMARY KEY,
  tipo            VARCHAR(30) NOT NULL, -- 'compra' | 'anulacion_compra' | 'venta' | 'ajuste'
  insumo_id       INTEGER REFERENCES insumos(id) ON DELETE SET NULL,
  empaque_id      INTEGER REFERENCES empaques(id) ON DELETE SET NULL,
  local_id        INTEGER NOT NULL, -- REFERENCES locales(id): FK real en config/db.js
  cantidad        NUMERIC(10,2) NOT NULL, -- delta aplicado (+ suma, - resta)
  referencia_tipo VARCHAR(30), -- 'compra' | 'pedido'
  referencia_id   INTEGER,
  created_at      TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS compras (
  id           SERIAL PRIMARY KEY,
  -- Código alfanumérico legible (ej. "CMP-2026-0001"), generado en el
  -- backend al crear la compra (ver POST /compras en routes/index.js). El
  -- id numérico se conserva como llave primaria real para no romper las
  -- rutas /:id ya existentes; "codigo" es solo el identificador visible.
  codigo       VARCHAR(30) UNIQUE,
  proveedor_id INTEGER REFERENCES proveedores(id) ON DELETE SET NULL,
  fecha        DATE NOT NULL DEFAULT CURRENT_DATE,
  -- Porcentaje de descuento aplicado sobre el total bruto (suma de los
  -- items) al momento de crear la compra. total = total_bruto -
  -- (total_bruto * descuento / 100) — ver POST /compras.
  descuento    NUMERIC(5,2) DEFAULT 0 CHECK (descuento >= 0 AND descuento <= 100),
  total        NUMERIC(12,2) DEFAULT 0,
  estado       VARCHAR(20) NOT NULL DEFAULT 'Activa',
  motivo_anulacion TEXT,
  -- Multi-local: local elegido explícitamente en el formulario de compra.
  -- Obligatorio en POST /compras; el incremento de stock se aplica solo a
  -- los insumos de ESTE local. FK agregada en config/db.js.
  local_id     INTEGER,
  items        JSONB DEFAULT '[]',
  created_at   TIMESTAMP DEFAULT NOW()
);

-- Locales físicos que un cliente puede elegir para "recoger en el local"
-- (tipo de entrega 'local' — ver pedidos.local_id más abajo). NO es lo
-- mismo que "sede" en pedidos/usuarios/empleados ('Local 1'/'Local 2'/
-- 'Ambos'): "sede" es la asignación operativa interna de qué cajero/
-- bartender atiende el pedido; "locales" es la lista pública, con nombre y
-- dirección reales, que ve el cliente en el checkout.
-- "direccion" se crea nullable acá a propósito (la siembra de abajo no
-- conoce la dirección real de los dos locales) — config/db.js backfillea
-- un placeholder explícito y recién ahí aplica NOT NULL, en un solo lugar
-- que corre igual en una instalación nueva o en una ya existente (ver esa
-- migración para el porqué de la estrategia y su rollback).
CREATE TABLE IF NOT EXISTS locales (
  id        SERIAL PRIMARY KEY,
  nombre    VARCHAR(100) NOT NULL,
  direccion TEXT,
  telefono  VARCHAR(30),
  estado    VARCHAR(20) NOT NULL DEFAULT 'Activo'
);
INSERT INTO locales (nombre, direccion)
  SELECT v.nombre, v.direccion FROM (VALUES
    ('Local Villa Liliam', NULL::text),
    ('Local 3 Esquinas',   NULL::text)
  ) AS v(nombre, direccion)
  WHERE NOT EXISTS (SELECT 1 FROM locales WHERE locales.nombre = v.nombre);

-- FK reales de insumo_local/empaque_local/movimientos_inventario.local_id
-- (declaradas sin REFERENCES en línea más arriba porque "locales" se crea
-- recién acá).
ALTER TABLE insumo_local          ADD CONSTRAINT insumo_local_local_id_fkey          FOREIGN KEY (local_id) REFERENCES locales(id) ON DELETE CASCADE;
ALTER TABLE empaque_local         ADD CONSTRAINT empaque_local_local_id_fkey         FOREIGN KEY (local_id) REFERENCES locales(id) ON DELETE CASCADE;
ALTER TABLE movimientos_inventario ADD CONSTRAINT movimientos_inventario_local_id_fkey FOREIGN KEY (local_id) REFERENCES locales(id);

-- Qué vaso usa cada producto/tamaño y si lleva pitillo (y cuál) —
-- requisito 4. "tamano" es opcional: NULL representa la configuración por
-- defecto del producto cuando no maneja tamaños.
CREATE TABLE IF NOT EXISTS producto_empaque (
  id                 SERIAL PRIMARY KEY,
  producto_id        INTEGER NOT NULL REFERENCES productos(id) ON DELETE CASCADE,
  tamano             VARCHAR(50),
  vaso_empaque_id    INTEGER REFERENCES empaques(id) ON DELETE SET NULL,
  lleva_pitillo      BOOLEAN NOT NULL DEFAULT FALSE,
  pitillo_empaque_id INTEGER REFERENCES empaques(id) ON DELETE SET NULL,
  created_at         TIMESTAMP DEFAULT NOW(),
  UNIQUE(producto_id, tamano)
);

CREATE TABLE IF NOT EXISTS pedidos (
  id                   SERIAL PRIMARY KEY,
  cliente_id           INTEGER REFERENCES clientes(id) ON DELETE SET NULL,
  numero               VARCHAR(30),
  cliente              VARCHAR(150),
  tipo                 VARCHAR(30),
  -- Qué local eligió el cliente para recoger su pedido — solo aplica
  -- cuando tipo = 'local' (no aplica a domicilio). Ver GET /api/locales y
  -- POST /pedidos en routes/index.js.
  local_id             INTEGER REFERENCES locales(id) ON DELETE SET NULL,
  -- Único conjunto de métodos de pago válido — en minúscula, así es como
  -- lo manda realmente el frontend (ver METODOS_PAGO_VALIDOS/esEfectivo en
  -- routes/index.js, que valida/compara lo mismo, sin importar mayúsculas,
  -- antes y después de llegar aquí). Una instalación nueva no tiene
  -- pedidos previos que puedan violar este CHECK, así que acá no hace
  -- falta el NOT VALID que sí usa la migración de config/db.js.
  pago                 VARCHAR(30) CHECK (pago IS NULL OR pago IN ('efectivo','nequi','transferencia')),
  mesa                 VARCHAR(100),
  estado               VARCHAR(40) NOT NULL DEFAULT 'pendiente',
  total                NUMERIC(12,2) DEFAULT 0,
  items                JSONB DEFAULT '[]',
  comprobante          TEXT,
  comprobante_img      TEXT,
  comprobante_hash     VARCHAR(64),
  -- Resultado del OCR que el frontend le corre al comprobante del cliente.
  -- Puramente informativo: NUNCA condiciona si el comprobante se puede
  -- subir. La aprobación/rechazo del pago es manual (Cajero/Admin).
  comprobante_ocr      JSONB,
  origen               VARCHAR(30) DEFAULT 'admin',
  -- Dirección específica para ESTE pedido a domicilio, distinta a la del
  -- perfil del cliente. Opcional (si viene NULL se usa la del perfil).
  direccion_alternativa TEXT,
  hora                 VARCHAR(20),
  -- Quién atiende el pedido en el estado de espera previo a la entrega
  -- (estado 'en_camino'): cajero/bartender autenticado que hizo la
  -- transición (automático) → usuarios.id. Reemplaza a la columna de
  -- texto "barista" (eliminada en config/db.js). El sistema NO maneja
  -- domiciliarios (requisito 1, esta ronda) — no hay columna equivalente
  -- para "quién entrega"; el tipo de entrega 'domicilio' se mantiene.
  atendido_por         INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  -- El cobro debe quedar confirmado ANTES de que el pedido pueda pasar a
  -- 'en_proceso' (preparación) — ver PATCH /pedidos/:id/estado,
  -- /comprobante/aprobar y /confirmar-pago en routes/index.js. Con
  -- comprobante de transferencia lo confirma la aprobación del
  -- comprobante; en efectivo/local lo confirma el cajero directamente.
  pago_confirmado      BOOLEAN NOT NULL DEFAULT FALSE,
  -- Motivo que registra el cajero al rechazar un comprobante de pago (ver
  -- PATCH /pedidos/:id/comprobante/rechazar). El pedido queda 'cancelado'
  -- automáticamente al rechazarse.
  comprobante_motivo_rechazo TEXT,
  created_at           TIMESTAMP DEFAULT NOW()
);
-- "Atendido por" por id (reemplaza a la vieja columna de texto "barista",
-- que config/db.js elimina). Se agrega por ALTER para bases creadas antes
-- de que estuviera en el CREATE TABLE.
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS atendido_por INTEGER REFERENCES usuarios(id) ON DELETE SET NULL;

-- Migración: local al que pertenece el pedido ('Local 1' / 'Local 2').
-- Sin NOT NULL ni DEFAULT: sede = NULL representa un pedido de cliente que
-- todavía no ha sido tomado por ningún local (ver PATCH /pedidos/:id/tomar).
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS sede VARCHAR(20);

CREATE TABLE IF NOT EXISTS ventas (
  id           SERIAL PRIMARY KEY,
  pedido_id    INTEGER REFERENCES pedidos(id) ON DELETE SET NULL,
  total        NUMERIC(12,2) DEFAULT 0,
  estado       VARCHAR(30) NOT NULL DEFAULT 'vendido', -- 'vendido' | 'devuelto'
  created_at   TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS devoluciones (
  id        SERIAL PRIMARY KEY,
  pedido_id INTEGER REFERENCES pedidos(id) ON DELETE SET NULL,
  motivo    TEXT,
  tipo      VARCHAR(20) DEFAULT 'total', -- 'total' | 'parcial'
  monto     NUMERIC(12,2) DEFAULT 0,
  estado    VARCHAR(30) NOT NULL DEFAULT 'pendiente', -- 'pendiente' | 'aprobada' | 'rechazada'
  items     JSONB DEFAULT '[]',
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS fichas_tecnicas (
  id          SERIAL PRIMARY KEY,
  producto_id INTEGER REFERENCES productos(id) ON DELETE CASCADE,
  ingredientes JSONB DEFAULT '[]',
  -- Cuánto de cada topping asociado a ESTE producto se usa específicamente
  -- en él — [{ topping_id, cantidad }] — puede ser distinto al "cantidad"
  -- por defecto del topping (toppings.cantidad). Si un topping elegido en
  -- un pedido no tiene entrada acá, se usa el default del topping (ver
  -- descontarInventarioPorVenta en routes/index.js). Sin REFERENCES en
  -- línea a "toppings" porque topping_id vive DENTRO del JSON, no como
  -- columna — Postgres no soporta FK sobre un campo de un jsonb.
  toppings_ficha JSONB DEFAULT '[]',
  descripcion TEXT,
  -- Activa/inactiva. El resto de columnas del formulario (categoria_prep,
  -- porciones, tiempo_prep, costo_estimado, notas, resumen_prep,
  -- preparacion, vaso_insumo_id/cantidad_vaso, lleva_pitillo/
  -- pitillo_insumo_id/cantidad_pitillo) se agregan vía migración en
  -- config/db.js para no reescribir un CREATE TABLE que ya corrió en
  -- instalaciones existentes; "estado" se trae aquí porque el índice único
  -- de abajo la necesita desde la creación de la tabla. Vaso y pitillo son
  -- insumos NORMALES (con su propia unidad — vaso típicamente 'oz', pitillo
  -- típicamente 'unidad'), nunca un tipo especial.
  estado      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMP DEFAULT NOW()
);

-- Evita dos fichas técnicas ACTIVAS para el mismo producto (sí permite
-- varias inactivas/históricas): un índice único parcial, no un UNIQUE
-- normal sobre producto_id, porque debe dejar coexistir la ficha activa
-- vigente con las que quedaron inactivas al reemplazarla.
CREATE UNIQUE INDEX IF NOT EXISTS fichas_tecnicas_producto_activo_uidx
  ON fichas_tecnicas(producto_id) WHERE estado = TRUE;

CREATE TABLE IF NOT EXISTS resenas (
  id           SERIAL PRIMARY KEY,
  cliente_id   INTEGER REFERENCES clientes(id) ON DELETE SET NULL,
  texto        TEXT NOT NULL,
  calificacion INTEGER DEFAULT 5,
  aprobada     BOOLEAN DEFAULT FALSE,
  created_at   TIMESTAMP DEFAULT NOW()
);

-- Usuario admin por defecto / Superadministrador (password: admin2024#)
INSERT INTO usuarios (nombre, username, password, rol, es_superadmin)
VALUES ('Admin Sicaber', 'Admin_Sicaber',
  '$2a$10$WiPwsGfRH1tkyKk7qCf8vO5dsdHzXM.V6.36qSgSD7bONrH.A8Wri', 'Administrador', TRUE)
ON CONFLICT (username) DO NOTHING;

-- El hash anterior de esta fila (92IXUNpkjO0rOQ5byMi.Ye4o...) NO
-- correspondía a la contraseña documentada "admin2024#" — bcrypt.compare
-- siempre devolvía false, así que el login fallaba con 401 incluso usando
-- las credenciales correctas. Esto corrige el admin ya existente en bases
-- de datos donde el INSERT de arriba no hizo nada por el ON CONFLICT.
UPDATE usuarios SET password = '$2a$10$WiPwsGfRH1tkyKk7qCf8vO5dsdHzXM.V6.36qSgSD7bONrH.A8Wri'
WHERE username = 'Admin_Sicaber';

-- Si la base de datos ya existía de antes (con el admin ya creado pero sin
-- la columna es_superadmin), marcamos aquí ese mismo usuario como
-- Superadministrador. No crea un usuario nuevo, solo actualiza el flag.
UPDATE usuarios SET es_superadmin = TRUE WHERE username = 'Admin_Sicaber';