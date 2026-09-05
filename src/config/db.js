require('dotenv').config();
const { Pool, types } = require('pg');

// node-postgres, por defecto, devuelve toda columna NUMERIC/DECIMAL como
// STRING (OID 1700) — es un comportamiento documentado de la librería para
// no perder precisión en valores que no caben en un float de 64 bits. Pero
// en este proyecto todo el dinero/cantidades ya se maneja con
// Number()/parseFloat() de todas formas (ver costoEstimadoSuperaPrecio,
// calcularCantidadStock, etc. en routes/index.js), así que esa "seguridad"
// no protegía nada — solo obligaba al frontend a adivinar si un campo
// (precio, stock, total, descuento, cantidad...) le iba a llegar como
// "123.45" (string) o 123.45 (number) según qué ruta lo devolviera. Se
// convierte UNA sola vez acá, para toda columna numeric de toda la API
// (productos.precio, adiciones.precio, toppings.cantidad, compras.total,
// insumos.stock, fichas_tecnicas.costo_estimado, etc.), en vez de andar
// convirtiéndolo a mano ruta por ruta.
types.setTypeParser(1700, (val) => (val === null ? null : parseFloat(val)));

const pool = new Pool({
  host:     process.env.DB_HOST,
  port:     Number(process.env.DB_PORT),
  database: process.env.DB_NAME,
  user:     process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  // Evita que una conexión inactiva se quede colgada indefinidamente si el
  // servidor de Postgres la cierra por su lado (frecuente en redes
  // inestables o en instancias remotas que duermen por inactividad).
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 30000,
});

// CRÍTICO: sin este listener, cuando una conexión inactiva del pool se cae
// (ECONNRESET, "Connection terminated unexpectedly", etc.) Node.js la trata
// como una excepción no capturada y TUMBA TODO EL PROCESO. Eso es lo que
// causaba que, de repente, absolutamente todas las rutas (productos,
// categorías, toppings, etc. — no solo insumos) empezaran a fallar con 500:
// el servidor se estaba reiniciando solo en medio de las peticiones.
pool.on('error', (err) => {
  console.error('⚠️  Error en una conexión inactiva del pool (no se detiene el servidor):', err.message);
});


const migrar = async () => {
  const alters = [
    // roles: color identificador elegido en el formulario de Roles
    // (RolFormPage.jsx) para la franja de la tarjeta en el listado
    // (RolesPage.jsx). BUG CORREGIDO: la columna nunca existió — schema.sql
    // solo definía id/nombre/descripcion/permisos/created_at, y las rutas
    // POST/PUT /roles tampoco lo leían de req.body ni lo incluían en el
    // INSERT/UPDATE, así que el color elegido se descartaba en silencio
    // (nunca llegaba ni a intentar guardarse) y todo rol quedaba con
    // rol.color=undefined, cayendo siempre al azul por defecto
    // (rolesService.getColor -> COLORES[5]) sin importar qué color se
    // hubiera elegido al crearlo.
    `ALTER TABLE roles ADD COLUMN IF NOT EXISTS color VARCHAR(10)`,
    // usuarios (login con correo o usuario)
    `ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS correo VARCHAR(150)`,
    // usuarios: marca del Superadministrador único e inmodificable
    // (rol/estado). No crea un usuario nuevo: solo agrega la columna y,
    // más abajo, marca el admin por defecto ya existente.
    `ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS es_superadmin BOOLEAN NOT NULL DEFAULT FALSE`,
    `UPDATE usuarios SET es_superadmin = TRUE WHERE username = 'Admin_Sicaber' AND es_superadmin IS NOT TRUE`,
    // El hash sembrado originalmente en schema.sql para el admin por
    // defecto NUNCA correspondió a la contraseña documentada
    // ("admin2024#") — bcrypt.compare siempre daba false, así que el
    // login fallaba con 401 incluso con las credenciales correctas. Se
    // corrige solo si la contraseña sigue siendo exactamente ese hash
    // roto, para no pisar una contraseña que ya se haya cambiado después.
    `UPDATE usuarios SET password = '$2a$10$WiPwsGfRH1tkyKk7qCf8vO5dsdHzXM.V6.36qSgSD7bONrH.A8Wri'
       WHERE username = 'Admin_Sicaber'
         AND password = '$2a$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi'`,
    // Multi-local: cada usuario interno (Cajero/Bartender) queda asignado
    // a 'Local 1' o 'Local 2'. El Administrador usa 'Ambos' para ver y
    // operar pedidos de los dos locales.
    `ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS sede VARCHAR(20) NOT NULL DEFAULT 'Local 1'`,
    `UPDATE usuarios SET sede = 'Ambos' WHERE rol = 'Administrador' AND sede <> 'Ambos'`,
    // Multi-local (Insumos/Compras): local de trabajo del usuario interno,
    // como referencia real a locales.id (no el texto suelto de "sede"). Es
    // lo que POST /insumos usa para asignar automáticamente el local del
    // insumo. Sin REFERENCES en línea: la FK real se agrega aparte más
    // abajo, igual que pedidos.local_id. NULL para el Administrador
    // (sede 'Ambos') y para cualquier registro cuya "sede" no coincida con
    // el nombre de un local del catálogo.
    `ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS local_id INTEGER`,
    // pedidos
    `ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS cliente_id INTEGER REFERENCES clientes(id) ON DELETE SET NULL`,
    `ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS numero VARCHAR(30)`,
    `ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS cliente VARCHAR(150)`,
    `ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS tipo VARCHAR(30)`,
    `ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS pago VARCHAR(30)`,
    `ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS mesa VARCHAR(100)`,
    `ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS comprobante TEXT`,
    `ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS comprobante_img TEXT`,
    // Huella (SHA-256) de la imagen del comprobante — sirve para detectar
    // si un cliente intenta reutilizar el mismo pantallazo de pago en más
    // de un pedido (ver POST /pedidos en routes/index.js).
    `ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS comprobante_hash VARCHAR(64)`,
    // Resultado del OCR que el frontend le corre al comprobante que sube el
    // cliente (monto detectado, si coincide con el total, confianza,
    // advertencias). Es PURAMENTE INFORMATIVO: se guarda tal cual llega y
    // NUNCA condiciona si el comprobante se puede subir — el pedido siempre
    // se crea y el comprobante siempre queda adjunto. La aprobación/rechazo
    // del pago la deciden el Cajero/Admin a mano (PATCH /:id/comprobante/
    // aprobar|rechazar); el OCR solo les da contexto al revisar la imagen.
    `ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS comprobante_ocr JSONB`,
    `ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS origen VARCHAR(30) DEFAULT 'admin'`,
    `ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS direccion_alternativa TEXT`,
    `ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS hora VARCHAR(20)`,
    // "hora" se creó como VARCHAR(10), pero un horario con formato local
    // (ej. "7:03 p. m.", que trae "a.m./p.m." con puntos y espacio) supera
    // fácilmente esos 10 caracteres — eso tumbaba CUALQUIER pedido nuevo
    // con un error de Postgres ("value too long for type character
    // varying(10)"), disfrazado de 500 genérico.
    `ALTER TABLE pedidos ALTER COLUMN hora TYPE VARCHAR(20)`,
    // pedidos: "atendido por" y "domiciliario" se seleccionaban en el
    // formulario pero nunca se guardaban porque la columna no existía.
    `ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS barista VARCHAR(150)`,
    `ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS domiciliario VARCHAR(150)`,
    // Multi-local: cada pedido queda marcado con el local al que
    // pertenece ('Local 1' / 'Local 2'), para que el cajero y el
    // bartender de cada local solo vean sus propios pedidos.
    `ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS sede VARCHAR(20) NOT NULL DEFAULT 'Local 1'`,
    // Permite que un pedido quede sin local asignado (sede = NULL): así se
    // representa un pedido de cliente que todavía no ha sido tomado por
    // ningún local (ver PATCH /pedidos/:id/tomar en routes/index.js).
    `ALTER TABLE pedidos ALTER COLUMN sede DROP NOT NULL`,
    `ALTER TABLE pedidos ALTER COLUMN sede DROP DEFAULT`,
    // "Empleados": el formulario de "Nuevo empleado" siempre pidió usuario/
    // contraseña cuando el cargo es Cajero o Bartender, pero esos campos
    // nunca se guardaban (el endpoint solo insertaba nombre/cargo/
    // teléfono/correo/estado), así que ese cajero/bartender jamás podía
    // iniciar sesión. Ahora: sede = local del empleado (solo relevante
    // para Cajero/Bartender); usuario_id = enlaza el empleado con su
    // cuenta de acceso real en "usuarios" (login, rol, contraseña).
    `ALTER TABLE empleados ADD COLUMN IF NOT EXISTS sede VARCHAR(20) NOT NULL DEFAULT 'Local 1'`,
    `ALTER TABLE empleados ADD COLUMN IF NOT EXISTS usuario_id INTEGER REFERENCES usuarios(id) ON DELETE SET NULL`,
    // Tipo/número de documento, dirección de residencia y local real del
    // empleado: el formulario de "Nuevo empleado" SIEMPRE pidió estos
    // cuatro datos y el frontend siempre los envió, pero las columnas no
    // existían en este archivo y el INSERT/UPDATE tampoco los guardaba —
    // se perdían en silencio, sin ningún error visible, y el modal "Ver
    // detalle" mostraba siempre "—" en esos campos.
    `ALTER TABLE empleados ADD COLUMN IF NOT EXISTS tipo_doc   VARCHAR(50)`,
    `ALTER TABLE empleados ADD COLUMN IF NOT EXISTS numero_doc VARCHAR(30)`,
    `ALTER TABLE empleados ADD COLUMN IF NOT EXISTS direccion  TEXT`,
    // local_id sin REFERENCES en línea, igual que pedidos.local_id: la
    // tabla "locales" se crea más abajo en este mismo arreglo, así que la
    // FK no se puede declarar aquí. Se deja como INTEGER simple porque el
    // dato operativo real sigue siendo "sede" (nombre en texto); local_id
    // es la referencia moderna que ya envía el formulario.
    `ALTER TABLE empleados ADD COLUMN IF NOT EXISTS local_id   INTEGER`,
    // devoluciones: faltaba la columna `tipo` (total/parcial) que el
    // frontend siempre intentó leer.
    `ALTER TABLE devoluciones ADD COLUMN IF NOT EXISTS tipo VARCHAR(20) DEFAULT 'total'`,
    // El default de `estado` quedó como 'Pendiente' (con mayúscula) pero
    // todo el frontend compara en minúscula ('pendiente'/'aprobada'/
    // 'rechazada'). Esto hacía que ninguna devolución nueva mostrara los
    // botones de aprobar/rechazar ni contara en las estadísticas.
    `ALTER TABLE devoluciones ALTER COLUMN estado SET DEFAULT 'pendiente'`,
    // Motivo por el que se RECHAZA una devolución. Es distinto de
    // devoluciones.motivo, que es el motivo por el que el cliente pidió la
    // devolución. Antes rechazar solo cambiaba el estado a 'rechazada' sin
    // registrar ninguna explicación, así que ni el cliente ni el siguiente
    // cajero podían saber por qué se rechazó.
    `ALTER TABLE devoluciones ADD COLUMN IF NOT EXISTS motivo_rechazo TEXT`,
    `UPDATE devoluciones SET estado='pendiente' WHERE estado='Pendiente'`,
    `UPDATE devoluciones SET estado='aprobada'  WHERE estado='Aprobada'`,
    `UPDATE devoluciones SET estado='rechazada' WHERE estado='Rechazada'`,
    // Mismo problema en ventas: el default era 'Activa', pero el frontend
    // solo reconoce 'vendido' / 'devuelto'.
    `ALTER TABLE ventas ALTER COLUMN estado SET DEFAULT 'vendido'`,
    `UPDATE ventas SET estado='vendido'  WHERE estado='Activa'`,
    `UPDATE ventas SET estado='devuelto' WHERE estado IN ('Anulada','Inactiva')`,
    // toppings: nunca tienen costo (se quita precio) y ahora se pueden
    // asociar a productos específicos. productos_ids = [] significa
    // "aplica a todos los productos".
    `ALTER TABLE toppings DROP COLUMN IF EXISTS precio`,
    `ALTER TABLE toppings ADD COLUMN IF NOT EXISTS productos_ids JSONB DEFAULT '[]'`,
    // Toppings: ahora pueden descontar stock real de un insumo al vender
    // un pedido que los incluya (igual que los ingredientes de la ficha
    // técnica) — insumo_id + cuánto de ese insumo consume una unidad del
    // topping. Sin REFERENCES en línea por el mismo motivo que vaso_id en
    // fichas_tecnicas: la FK real se agrega aparte más abajo, guardada por
    // su propio try/catch.
    `ALTER TABLE toppings ADD COLUMN IF NOT EXISTS insumo_id INTEGER`,
    `ALTER TABLE toppings ADD COLUMN IF NOT EXISTS cantidad NUMERIC(10,3) DEFAULT 0`,
    // Adiciones: mismo mecanismo que toppings.insumo_id/cantidad, para que
    // también puedan descontar stock real de un insumo al vender un
    // pedido que las incluya. A diferencia de los toppings, las adiciones
    // no tienen override por producto (siguen siendo universales) — ver
    // calcularRecetaEfectiva en routes/index.js. FK real agregada aparte
    // más abajo, guardada por su propio try/catch.
    `ALTER TABLE adiciones ADD COLUMN IF NOT EXISTS insumo_id INTEGER`,
    `ALTER TABLE adiciones ADD COLUMN IF NOT EXISTS cantidad NUMERIC(10,3) DEFAULT 0`,
    // Adiciones: la tabla nunca tuvo columna "descripcion", aunque el
    // formulario del frontend siempre la pedía, la validaba (máx. 20
    // palabras) y la enviaba al guardar — se perdía en silencio porque no
    // había dónde guardarla (mismo caso que insumos.descripcion arriba).
    `ALTER TABLE adiciones ADD COLUMN IF NOT EXISTS descripcion TEXT`,
    // Pedidos: el cobro debe quedar confirmado antes de que el pedido
    // pueda pasar a 'en_proceso' — ver PATCH /pedidos/:id/estado,
    // /comprobante/aprobar y /confirmar-pago en routes/index.js.
    `ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS pago_confirmado BOOLEAN NOT NULL DEFAULT FALSE`,
    `ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS comprobante_motivo_rechazo TEXT`,
    // Fichas técnicas: cuánto de cada topping asociado al producto se usa
    // específicamente en él (puede ser distinto al "cantidad" por defecto
    // del topping) — ver toppingsRouter/fichaRouter y
    // descontarInventarioPorVenta en routes/index.js.
    `ALTER TABLE fichas_tecnicas ADD COLUMN IF NOT EXISTS toppings_ficha JSONB DEFAULT '[]'`,
    // Insumos: marca puramente informativa/de filtro (no condiciona nada
    // del backend) para que el frontend pueda sugerir/filtrar insumos que
    // típicamente se usan como toppings al crear uno nuevo.
    `ALTER TABLE insumos ADD COLUMN IF NOT EXISTS es_topping BOOLEAN NOT NULL DEFAULT FALSE`,
    // Insumos: la tabla nunca tuvo categoría ni descripción, aunque el
    // formulario del frontend siempre las pedía y las mostraba — por eso
    // se perdían al guardar y "Gestionar categorías" no tenía dónde
    // guardar nada. Se crea una tabla propia (categorias_insumos) en vez
    // de reutilizar "categorias", que ya es del módulo de Productos.
    `CREATE TABLE IF NOT EXISTS categorias_insumos (
       id         SERIAL PRIMARY KEY,
       nombre     VARCHAR(100) NOT NULL UNIQUE,
       estado     VARCHAR(20)  NOT NULL DEFAULT 'Activo',
       created_at TIMESTAMP DEFAULT NOW()
     )`,
    `ALTER TABLE insumos ADD COLUMN IF NOT EXISTS categoria_id INTEGER REFERENCES categorias_insumos(id) ON DELETE SET NULL`,
    `ALTER TABLE insumos ADD COLUMN IF NOT EXISTS descripcion TEXT`,
    // Multi-local: cada insumo pertenece a UN local (locales.id). Se asigna
    // AUTOMÁTICAMENTE en POST /insumos según el local de trabajo del usuario
    // autenticado (usuarios.local_id) y es inmutable después. Columna sin
    // REFERENCES en línea (FK real aparte, más abajo). Los insumos de prueba
    // ya existentes quedan con local_id = NULL a propósito: no se migran.
    `ALTER TABLE insumos ADD COLUMN IF NOT EXISTS local_id INTEGER`,
    // La unicidad del nombre de un insumo pasa de ser "por proveedor" a ser
    // "por local" (regla nueva: el mismo nombre SÍ puede existir en dos
    // locales distintos, cada uno con su propio stock). Se elimina el índice
    // único viejo (nombre + proveedor_id); el nuevo (nombre + local_id) se
    // crea aparte más abajo, guardado por su propio try/catch.
    `DROP INDEX IF EXISTS insumos_nombre_proveedor_unico`,
    // Proveedor e insumo pasan a ser independientes: solo se relacionan al
    // momento de registrar una compra puntual (compras.proveedor_id sigue
    // existiendo, esa relación no cambia). Se quita la columna real de la
    // tabla — schema.sql ya no la define, pero CREATE TABLE IF NOT EXISTS
    // no la elimina de una base de datos que ya la tenía creada.
    `ALTER TABLE insumos DROP COLUMN IF EXISTS proveedor_id`,
    // Mismas categorías que antes venían fijas en el código del frontend
    // (incluyendo "Vasos de plástico"/"Vasos de cartón", de las que
    // depende el selector de tamaño de vaso) — se insertan una sola vez.
    `INSERT INTO categorias_insumos (nombre) VALUES
       ('Lácteos'), ('Cafés y granos'), ('Frutas'), ('Verduras'), ('Azúcares'),
       ('Aceites'), ('Especias'), ('Bebidas'), ('Harinas'),
       ('Vasos de plástico'), ('Vasos de cartón'), ('Otros')
     ON CONFLICT (nombre) DO NOTHING`,
    // Categoría para desechables/empaque que no son ni "Vasos de plástico"
    // ni "Vasos de cartón" (esas dos ya existían): pitillo, tapa para vaso,
    // etc. Se agrega en su propio INSERT (en vez de sumarla a la lista de
    // VALUES de arriba) para no reescribir un paso de migración que ya se
    // ejecutó en instalaciones existentes — el patrón de este archivo es
    // siempre sumar un paso nuevo, nunca editar uno anterior.
    `INSERT INTO categorias_insumos (nombre) VALUES ('Empaques') ON CONFLICT (nombre) DO NOTHING`,
    // Tipos de Presentación (Compras): antes era una lista fija en el
    // código del formulario (Caja, Paquete, Bolsa) — se convierte en un
    // catálogo gestionable, mismo patrón que categorias_insumos. "Unitario"
    // NO se siembra acá: no es un tipo gestionable, sigue siendo una
    // opción fija y especial manejada aparte por el propio formulario de
    // compra (Cantidad de presentaciones fija en 1, sin checkbox de nivel
    // 3) — nunca debe poder editarse, desactivarse ni aparecer en este
    // catálogo.
    `CREATE TABLE IF NOT EXISTS tipos_presentacion (
       id         SERIAL PRIMARY KEY,
       nombre     VARCHAR(100) NOT NULL UNIQUE,
       estado     VARCHAR(20)  NOT NULL DEFAULT 'Activo',
       created_at TIMESTAMP DEFAULT NOW()
     )`,
    `INSERT INTO tipos_presentacion (nombre) VALUES ('Caja'), ('Paquete'), ('Bolsa') ON CONFLICT (nombre) DO NOTHING`,
    // Compras: el formulario siempre mandó observaciones y los datos del
    // comprobante (url, si quedó verificado, el total leído por OCR), pero
    // esas columnas nunca existieron, así que se perdían silenciosamente
    // al guardar.
    `ALTER TABLE compras ADD COLUMN IF NOT EXISTS observaciones TEXT`,
    `ALTER TABLE compras ADD COLUMN IF NOT EXISTS comprobante_url TEXT`,
    `ALTER TABLE compras ADD COLUMN IF NOT EXISTS comprobante_verificado BOOLEAN DEFAULT FALSE`,
    `ALTER TABLE compras ADD COLUMN IF NOT EXISTS comprobante_total_ocr NUMERIC(12,2)`,
    // Resultado completo del análisis OCR (fecha/NIT detectados, confianza,
    // si el proveedor coincide, advertencias) — antes solo se guardaba el
    // total detectado; el resto se calculaba en pantalla y se perdía al
    // guardar, así que "Ver Compra" no tenía nada más que mostrar.
    `ALTER TABLE compras ADD COLUMN IF NOT EXISTS ocr_resultado JSONB`,
    `ALTER TABLE compras ADD COLUMN IF NOT EXISTS fecha_anulacion TIMESTAMP`,
    // Mismo problema de mayúsculas que ya se corrigió en ventas/devoluciones:
    // la tabla guardaba 'Activa'/'Anulada' pero TODO el frontend de Compras
    // (Historial, Ver compra, badges) compara contra 'activa'/'anulada' en
    // minúscula, así que la compra anulada nunca se veía como anulada.
    `ALTER TABLE compras ALTER COLUMN estado SET DEFAULT 'activa'`,
    `UPDATE compras SET estado='activa'  WHERE estado='Activa'`,
    `UPDATE compras SET estado='anulada' WHERE estado='Anulada'`,
    // Compras: % de descuento aplicado sobre el total bruto de los items.
    // total = total_bruto - (total_bruto * descuento / 100) — ver POST
    // /compras en routes/index.js. El CHECK es inofensivo para las filas ya
    // existentes porque el DEFAULT 0 siempre lo cumple.
    `ALTER TABLE compras ADD COLUMN IF NOT EXISTS descuento NUMERIC(5,2) DEFAULT 0 CHECK (descuento >= 0 AND descuento <= 100)`,
    // Compras: código alfanumérico legible (ej. "CMP-2026-0001"), generado
    // en el backend al crear la compra. El id numérico sigue siendo la
    // llave primaria real (lo siguen usando las rutas /:id) — "codigo" es
    // solo el identificador visible para el usuario.
    `ALTER TABLE compras ADD COLUMN IF NOT EXISTS codigo VARCHAR(30)`,
    // Multi-local: local al que pertenece la compra. A diferencia de
    // insumos (automático), aquí lo ELIGE el usuario en el formulario y es
    // obligatorio en POST /compras de aquí en adelante. El incremento de
    // stock de la compra se aplica solo a los insumos de ESTE local. Las
    // compras de prueba ya existentes quedan con local_id = NULL (no se
    // migran). Columna sin REFERENCES en línea (FK real aparte, más abajo).
    `ALTER TABLE compras ADD COLUMN IF NOT EXISTS local_id INTEGER`,
    // Backfill: las compras que ya existían (creadas antes de que "codigo"
    // existiera) se quedarían con codigo NULL para siempre si no se
    // completa aquí. Se numeran por año de creación y orden de id, con el
    // mismo formato "CMP-{año}-{consecutivo de 4 dígitos}" que usa el
    // backend al crear una compra nueva. Es idempotente: una vez que una
    // fila tiene codigo, el WHERE codigo IS NULL la excluye en la próxima
    // ejecución.
    `UPDATE compras c SET codigo = sub.codigo
       FROM (
         SELECT id, 'CMP-' || EXTRACT(YEAR FROM created_at)::text || '-' ||
           LPAD(ROW_NUMBER() OVER (PARTITION BY EXTRACT(YEAR FROM created_at) ORDER BY id)::text, 4, '0') AS codigo
         FROM compras WHERE codigo IS NULL
       ) sub
       WHERE c.id = sub.id AND c.codigo IS NULL`,
    // Unicidad del código visible (además del id numérico interno). Postgres
    // permite múltiples NULL en un índice único, así que esto no falla
    // aunque quede alguna fila sin codigo por cualquier motivo.
    `CREATE UNIQUE INDEX IF NOT EXISTS compras_codigo_key ON compras(codigo)`,
    // Fichas técnicas: el formulario del frontend siempre pidió categoría
    // de preparación, porciones, tiempo, costo estimado, estado
    // activo/inactivo, notas, resumen, preparación y el vaso usado — pero
    // la tabla solo tenía producto_id/ingredientes/descripcion, así que
    // todo lo demás se perdía al guardar y el botón de activar/inactivar
    // (que apunta a una columna "estado") no tenía dónde escribir.
    // producto_id: se asumía que esta columna ya existía siempre en
    // fichas_tecnicas (viene en el CREATE TABLE de schema.sql), pero
    // en bases de datos creadas antes de que esa columna se agregara al
    // schema, "CREATE TABLE IF NOT EXISTS" nunca la crea porque la tabla
    // ya existía — de ahí el error "no existe la columna producto_id".
    // Se agrega aparte, sin REFERENCES en línea, por el mismo motivo que
    // vaso_id: si la FK no se puede implementar no debe tumbar todo el
    // ALTER TABLE ni dejar la columna sin crear.
    // ingredientes/descripcion: mismo caso que producto_id — se asumían
    // presentes desde el CREATE TABLE original de fichas_tecnicas, pero en
    // bases de datos creadas antes de que existieran esas columnas nunca
    // se agregaron, porque "CREATE TABLE IF NOT EXISTS" no toca una tabla
    // que ya existe.
    `ALTER TABLE fichas_tecnicas ADD COLUMN IF NOT EXISTS ingredientes JSONB DEFAULT '[]'`,
    `ALTER TABLE fichas_tecnicas ADD COLUMN IF NOT EXISTS descripcion TEXT`,
    `ALTER TABLE fichas_tecnicas ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW()`,
    `ALTER TABLE fichas_tecnicas ADD COLUMN IF NOT EXISTS producto_id INTEGER`,
    `ALTER TABLE fichas_tecnicas ADD COLUMN IF NOT EXISTS categoria_prep VARCHAR(50) DEFAULT 'Caliente'`,
    `ALTER TABLE fichas_tecnicas ADD COLUMN IF NOT EXISTS porciones INTEGER DEFAULT 1`,
    `ALTER TABLE fichas_tecnicas ADD COLUMN IF NOT EXISTS tiempo_prep INTEGER DEFAULT 5`,
    `ALTER TABLE fichas_tecnicas ADD COLUMN IF NOT EXISTS costo_estimado NUMERIC(10,2) DEFAULT 0`,
    `ALTER TABLE fichas_tecnicas ADD COLUMN IF NOT EXISTS estado BOOLEAN NOT NULL DEFAULT TRUE`,
    `ALTER TABLE fichas_tecnicas ADD COLUMN IF NOT EXISTS notas TEXT`,
    `ALTER TABLE fichas_tecnicas ADD COLUMN IF NOT EXISTS resumen_prep TEXT`,
    `ALTER TABLE fichas_tecnicas ADD COLUMN IF NOT EXISTS preparacion TEXT`,
    `ALTER TABLE fichas_tecnicas ADD COLUMN IF NOT EXISTS vaso_id INTEGER`,
    // Proveedores: el formulario siempre pidió ciudad y observaciones, pero
    // esas columnas no existían — se perdían al guardar sin ningún error
    // visible (la ruta CRUD genérica solo inserta las columnas que conoce).
    `ALTER TABLE proveedores ADD COLUMN IF NOT EXISTS ciudad VARCHAR(100)`,
    `ALTER TABLE proveedores ADD COLUMN IF NOT EXISTS observaciones TEXT`,
    // Persona Natural / Jurídica: el frontend ya tiene el selector completo
    // (toggle, Nombres/Apellidos/Tipo de documento para Natural, Razón
    // social/NIT para Jurídica) pero estas columnas nunca se agregaron acá,
    // así que ese dato se perdía al guardar sin ningún error visible.
    `ALTER TABLE proveedores ADD COLUMN IF NOT EXISTS tipo_persona VARCHAR(20) NOT NULL DEFAULT 'Juridica'`,
    `ALTER TABLE proveedores ADD COLUMN IF NOT EXISTS nombres VARCHAR(150)`,
    `ALTER TABLE proveedores ADD COLUMN IF NOT EXISTS apellidos VARCHAR(150)`,
    `ALTER TABLE proveedores ADD COLUMN IF NOT EXISTS tipo_documento VARCHAR(20)`,
    `ALTER TABLE proveedores ADD COLUMN IF NOT EXISTS numero_documento VARCHAR(20)`,
    // Persona de contacto (Persona Jurídica): nombre de la persona con la
    // que se trata dentro de la empresa proveedora. Campo nuevo, sin
    // equivalente previo — antes de esta columna, el dato se habría
    // perdido silenciosamente al guardar.
    `ALTER TABLE proveedores ADD COLUMN IF NOT EXISTS persona_contacto VARCHAR(100)`,
    // Locales físicos para "recoger en el local" (tipo de entrega 'local').
    // NO es lo mismo que "sede" en pedidos/usuarios/empleados ('Local 1'/
    // 'Local 2'/'Ambos', la asignación operativa interna de qué cajero/
    // bartender atiende el pedido) — "locales" es la lista pública, con
    // nombre y dirección reales, que ve el cliente en el checkout. Ver GET
    // /api/locales en routes/index.js.
    `CREATE TABLE IF NOT EXISTS locales (
       id        SERIAL PRIMARY KEY,
       nombre    VARCHAR(100) NOT NULL,
       direccion TEXT,
       estado    VARCHAR(20) NOT NULL DEFAULT 'Activo'
     )`,
    // Semilla idempotente: sin UNIQUE en "nombre" (no lo pidió el schema
    // original), así que se usa WHERE NOT EXISTS en vez de ON CONFLICT
    // para no insertar los mismos dos locales de nuevo en cada arranque.
    `INSERT INTO locales (nombre, direccion)
       SELECT v.nombre, v.direccion FROM (VALUES
         ('Local Villa Liliam', NULL::text),
         ('Local 3 Esquinas',   NULL::text)
       ) AS v(nombre, direccion)
       WHERE NOT EXISTS (SELECT 1 FROM locales WHERE locales.nombre = v.nombre)`,
    // Limpieza de locales obsoletos: "Local 1", "Local 2" y "Local Principal"
    // eran placeholders anteriores a este módulo — los únicos dos locales
    // reales del sistema son "Local Villa Liliam" y "Local 3 Esquinas". Corre
    // ANTES del relleno de usuarios.local_id de abajo, para que ningún
    // usuario quede re-enganchado a un local obsoleto por su "sede".
    //
    // 1º) Se ELIMINAN definitivamente los obsoletos que no tengan NINGÚN
    //     registro asociado (así desaparecen de todos los endpoints, no solo
    //     quedan inactivos). Idempotente: si ya no existen, no borra nada.
    `DELETE FROM locales l
      WHERE l.nombre IN ('Local 1', 'Local 2', 'Local Principal')
        AND NOT EXISTS (SELECT 1 FROM compras   WHERE local_id = l.id)
        AND NOT EXISTS (SELECT 1 FROM pedidos   WHERE local_id = l.id)
        AND NOT EXISTS (SELECT 1 FROM ventas v JOIN pedidos p ON p.id = v.pedido_id WHERE p.local_id = l.id)
        AND NOT EXISTS (SELECT 1 FROM insumos   WHERE local_id = l.id)
        AND NOT EXISTS (SELECT 1 FROM empleados WHERE local_id = l.id)
        AND NOT EXISTS (SELECT 1 FROM usuarios  WHERE local_id = l.id)`,
    // 2º) Los que SÍ tengan registros asociados (no se pueden borrar sin
    //     romper historial) quedan Inactivos → ocultos de GET /locales y de
    //     los selectores públicos.
    `UPDATE locales SET estado='Inactivo'
      WHERE nombre IN ('Local 1', 'Local 2', 'Local Principal') AND estado <> 'Inactivo'`,
    // Multi-local: relleno de usuarios.local_id. En los registros nuevos,
    // "sede" ya guarda el NOMBRE real de un local del catálogo (ej.
    // 'Local Villa Liliam'), así que se resuelve a locales.id por coincidencia
    // de nombre — EXCLUYENDO los nombres obsoletos, para no re-enganchar un
    // usuario 'Local 1'/'Local 2' a un placeholder que justo se está
    // limpiando. Los que no resuelven quedan en NULL y se asignan a mano
    // desde el formulario. Idempotente: WHERE u.local_id IS NULL.
    `UPDATE usuarios u SET local_id = l.id
       FROM locales l
      WHERE u.local_id IS NULL
        AND l.nombre NOT IN ('Local 1', 'Local 2', 'Local Principal')
        AND lower(btrim(u.sede)) = lower(btrim(l.nombre))`,
    // Pedidos: qué local eligió el cliente para recoger su pedido — solo
    // aplica cuando tipo = 'local' (no aplica a domicilio). Sin REFERENCES
    // en línea por el mismo motivo que toppings.insumo_id: la FK real se
    // agrega aparte más abajo, guardada por su propio try/catch.
    `ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS local_id INTEGER`,
    // Migración PUNTUAL (datos residuales de esta instalación): al introducir
    // el descuento de inventario por local en la venta, 3 pedidos pendientes
    // quedaban con un local no resoluble — sede 'Local 1' (nombre obsoleto,
    // no está en el catálogo "locales") o sede NULL, y sin local_id. Se les
    // asigna el local activo "Local Villa Liliam" y se normaliza su "sede" a
    // ese nombre, para que no los frene el bloqueo de "local no resuelto"
    // (ver resolverLocalOperativoPedido / POST /ventas/desde-pedido).
    //
    // Idempotente y acotada: solo toca esos ids si TODAVÍA no tienen local_id
    // y su sede sigue siendo la obsoleta; en cuanto queda asignado, el WHERE
    // los excluye. El local se resuelve por nombre (no por id fijo) y el paso
    // no hace nada si ese local no existe.
    `UPDATE pedidos
        SET local_id = (SELECT id FROM locales WHERE nombre = 'Local Villa Liliam' AND estado = 'Activo' ORDER BY id LIMIT 1),
            sede     = 'Local Villa Liliam'
      WHERE id IN (7, 19, 23)
        AND local_id IS NULL
        AND (sede = 'Local 1' OR sede IS NULL)
        AND EXISTS (SELECT 1 FROM locales WHERE nombre = 'Local Villa Liliam' AND estado = 'Activo')`,
    // Estados de pedido: se saca 'listo' de la secuencia y se agrega
    // 'en_camino' en su lugar (pendiente → en_proceso → en_camino →
    // entregado; 'pendiente_verificacion' y 'cancelado' quedan como estados
    // especiales fuera de esa secuencia). El frontend muestra 'en_camino'
    // como "En camino" para domicilio y "Listo para recoger" para pickup —
    // es el mismo estado con distinta etiqueta según pedidos.tipo. Esta
    // migración reubica cualquier pedido que quedó en 'listo' → 'en_camino'.
    // Corre ANTES de recrear el CHECK pedidos_estado_check más abajo (si no,
    // el CHECK nuevo fallaría al encontrar un 'listo').
    `UPDATE pedidos SET estado = 'en_camino' WHERE estado = 'listo'`,
    // Reclasifica cualquier pedido con un "estado" fuera del flujo real
    // (pendiente_verificacion, pendiente, en_proceso, en_camino, entregado,
    // cancelado) — p. ej. un typo suelto guardado antes de que POST /pedidos
    // validara "estado". Se reclasifica a 'cancelado' (no se borra, para no
    // perder el historial). UPDATE de 0 filas si no hay nada fuera de lista.
    `UPDATE pedidos SET estado = 'cancelado'
       WHERE estado NOT IN ('pendiente_verificacion','pendiente','en_proceso','en_camino','entregado','cancelado')`,
    // "Atendido por" / "Domiciliario": se dejan de usar las columnas de
    // texto libre (barista / domiciliario, que guardaban un NOMBRE suelto) y
    // se pasa a las columnas por id (atendido_por → usuarios.id;
    // domiciliario_id → usuarios.id), que ya existen con su FK. Se intenta
    // resolver el nombre viejo a un usuario real por coincidencia exacta de
    // nombre; lo que no matchee queda en NULL (no se pierde nada crítico:
    // eran datos informativos). Después se ELIMINAN las columnas de texto
    // para no dejarlas conviviendo (media docena de rutas escribían en
    // ellas y ninguna las leía de verdad).
    `UPDATE pedidos p SET atendido_por = u.id
       FROM usuarios u
      WHERE p.atendido_por IS NULL AND p.barista IS NOT NULL
        AND lower(btrim(u.nombre)) = lower(btrim(p.barista))`,
    `UPDATE pedidos p SET domiciliario_id = u.id
       FROM usuarios u
      WHERE p.domiciliario_id IS NULL AND p.domiciliario IS NOT NULL
        AND lower(btrim(u.nombre)) = lower(btrim(p.domiciliario))`,
    `ALTER TABLE pedidos DROP COLUMN IF EXISTS barista`,
    `ALTER TABLE pedidos DROP COLUMN IF EXISTS domiciliario`,
    // Permisos: el rol Cajero debe poder consultar el módulo de Ventas, no
    // solo Pedidos. Se agrega 'ver_ventas' a su array de permisos si aún no
    // lo tiene (idempotente). Case-insensitive sobre el nombre del rol
    // porque en la tabla está como 'cajero' pero los empleados se crean con
    // rol 'Cajero'.
    `UPDATE roles
        SET permisos = permisos || '["ver_ventas"]'::jsonb
      WHERE lower(btrim(nombre)) = 'cajero'
        AND NOT (permisos @> '["ver_ventas"]'::jsonb)`,
    // ── CIUDADES (Proveedores) ────────────────────────────────
    // Antes "Ciudad" en el formulario de Proveedores quedó fija en
    // "Medellín" (el cliente solo maneja proveedores de ahí en ese
    // momento) — se pidió volverla dinámica: un catálogo real con las 16
    // ciudades principales ya sembradas, más la posibilidad de agregar
    // ciudades nuevas a futuro sin tocar código, para garantizar
    // escalabilidad. Mismo patrón exacto que categorias_insumos y
    // tipos_presentacion (arriba): tabla propia con nombre único y estado
    // Activo/Inactivo. A diferencia de tipos_presentacion (que sí tiene
    // una excepción fija, "Unitario"), acá NINGUNA ciudad tiene trato
    // especial — Medellín es solo la primera de la siembra, pero se puede
    // editar/desactivar como cualquier otra.
    //
    // ⚠️ La lista de las "16 ciudades principales" no me la compartieron
    // explícitamente en esta ronda — se sembró con las 16 ciudades más
    // pobladas de Colombia (Medellín primero, según se pidió). Si el
    // cliente ya tenía una lista distinta en mente (ej. la que ya usa el
    // módulo de Clientes), agrégalas o ajústalas desde el propio "Añadir
    // ciudad" del formulario — no hace falta otra migración para eso.
    `CREATE TABLE IF NOT EXISTS ciudades (
       id         SERIAL PRIMARY KEY,
       nombre     VARCHAR(100) NOT NULL UNIQUE,
       estado     VARCHAR(20)  NOT NULL DEFAULT 'Activo',
       created_at TIMESTAMP DEFAULT NOW()
     )`,
    `INSERT INTO ciudades (nombre) VALUES
       ('Medellín'), ('Bogotá'), ('Cali'), ('Barranquilla'), ('Cartagena'),
       ('Cúcuta'), ('Bucaramanga'), ('Pereira'), ('Santa Marta'), ('Ibagué'),
       ('Pasto'), ('Manizales'), ('Neiva'), ('Villavicencio'), ('Armenia'),
       ('Valledupar')
     ON CONFLICT (nombre) DO NOTHING`,
  ];
  for (const sql of alters) {
    try { await pool.query(sql); }
    catch (e) { console.error('⚠️  Migración falló para:', sql, '→', e.message); }
  }

  // La FK de fichas_tecnicas.vaso_id se crea aparte, en su propio paso: si
  // fuera parte del mismo ALTER TABLE que agrega la columna, una restricción
  // que no se puede implementar (p. ej. por datos existentes que no
  // cumplirían la FK) haría fallar TODO el ALTER TABLE, y entonces ni
  // siquiera la columna quedaría creada — repitiendo el error en cada
  // arranque sin que nada lo corrija. Aquí, si la FK no se puede crear, la
  // columna igual queda disponible como columna normal (sin integridad
  // referencial) y el servidor arranca con normalidad.
  try {
    const { rows } = await pool.query(
      `SELECT 1 FROM information_schema.table_constraints
        WHERE constraint_name = 'fichas_tecnicas_vaso_id_fkey'`
    );
    if (rows.length === 0) {
      await pool.query(
        `ALTER TABLE fichas_tecnicas ADD CONSTRAINT fichas_tecnicas_vaso_id_fkey
           FOREIGN KEY (vaso_id) REFERENCES insumos(id) ON DELETE SET NULL`
      );
    }
  } catch (e) {
    console.error('⚠️  No se pudo crear la FK fichas_tecnicas_vaso_id_fkey (la columna vaso_id sigue utilizable sin ella):', e.message);
  }

  // Mismo tratamiento para toppings.insumo_id: se crea aparte y sin
  // detener el arranque si falla (p. ej. si ya hay toppings con un
  // insumo_id que ya no corresponde a ningún insumo existente).
  try {
    const { rows } = await pool.query(
      `SELECT 1 FROM information_schema.table_constraints
        WHERE constraint_name = 'toppings_insumo_id_fkey'`
    );
    if (rows.length === 0) {
      await pool.query(
        `ALTER TABLE toppings ADD CONSTRAINT toppings_insumo_id_fkey
           FOREIGN KEY (insumo_id) REFERENCES insumos(id) ON DELETE SET NULL`
      );
    }
  } catch (e) {
    console.error('⚠️  No se pudo crear la FK toppings_insumo_id_fkey (la columna insumo_id sigue utilizable sin ella):', e.message);
  }

  // Mismo tratamiento para adiciones.insumo_id.
  try {
    const { rows } = await pool.query(
      `SELECT 1 FROM information_schema.table_constraints
        WHERE constraint_name = 'adiciones_insumo_id_fkey'`
    );
    if (rows.length === 0) {
      await pool.query(
        `ALTER TABLE adiciones ADD CONSTRAINT adiciones_insumo_id_fkey
           FOREIGN KEY (insumo_id) REFERENCES insumos(id) ON DELETE SET NULL`
      );
    }
  } catch (e) {
    console.error('⚠️  No se pudo crear la FK adiciones_insumo_id_fkey (la columna insumo_id sigue utilizable sin ella):', e.message);
  }

  // Mismo tratamiento para pedidos.local_id: se crea aparte y sin detener
  // el arranque si falla (p. ej. si ya hay pedidos con un local_id que ya
  // no corresponde a ningún local existente).
  //
  // Se revisa además confdeltype (la regla ON DELETE real de la FK, no solo
  // si existe): una instalación donde esta FK se llegó a crear ANTES de que
  // el ALTER TABLE de abajo incluyera "ON DELETE SET NULL" se quedó con la
  // constraint ya creada bajo ese nombre pero sin esa regla (ON DELETE NO
  // ACTION, el default de Postgres) — y como el chequeo de antes solo
  // miraba "¿existe una constraint con este nombre?", nunca la corregía en
  // ningún arranque siguiente. Sin ON DELETE SET NULL, borrar un local que
  // todavía tuviera pedidos apuntándole fallaría con una violación de FK en
  // vez de dejar esos pedidos con local_id=NULL. 'n' = SET NULL (ver
  // confdeltype en la documentación de pg_constraint).
  try {
    const { rows } = await pool.query(
      `SELECT confdeltype FROM pg_constraint WHERE conname = 'pedidos_local_id_fkey'`
    );
    if (rows.length === 0) {
      await pool.query(
        `ALTER TABLE pedidos ADD CONSTRAINT pedidos_local_id_fkey
           FOREIGN KEY (local_id) REFERENCES locales(id) ON DELETE SET NULL`
      );
    } else if (rows[0].confdeltype !== 'n') {
      await pool.query(`ALTER TABLE pedidos DROP CONSTRAINT pedidos_local_id_fkey`);
      await pool.query(
        `ALTER TABLE pedidos ADD CONSTRAINT pedidos_local_id_fkey
           FOREIGN KEY (local_id) REFERENCES locales(id) ON DELETE SET NULL`
      );
    }
  } catch (e) {
    console.error('⚠️  No se pudo crear/corregir la FK pedidos_local_id_fkey (la columna local_id sigue utilizable sin ella):', e.message);
  }

  // FK de las nuevas columnas local_id de usuarios / insumos / compras —
  // mismo tratamiento separado y tolerante a fallos que pedidos_local_id_fkey:
  // si no se puede crear (p. ej. datos que no cumplirían la FK), la columna
  // se sigue usando sin integridad referencial y el servidor arranca igual.
  // Sin ON DELETE: un local con usuarios/insumos/compras asociados no se
  // puede borrar — y de todos modos no hay ninguna ruta que borre locales.
  for (const [tabla, constraint] of [
    ['usuarios', 'usuarios_local_id_fkey'],
    ['insumos',  'insumos_local_id_fkey'],
    ['compras',  'compras_local_id_fkey'],
  ]) {
    try {
      const { rows } = await pool.query(
        `SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = $1`,
        [constraint]
      );
      if (rows.length === 0) {
        await pool.query(
          `ALTER TABLE ${tabla} ADD CONSTRAINT ${constraint}
             FOREIGN KEY (local_id) REFERENCES locales(id)`
        );
      }
    } catch (e) {
      console.error(`⚠️  No se pudo crear la FK ${constraint} (la columna local_id sigue utilizable sin ella):`, e.message);
    }
  }

  // Mismo tratamiento para la FK de producto_id: se crea aparte y sin
  // detener el arranque si falla (p. ej. si ya hay fichas técnicas con un
  // producto_id que ya no corresponde a ningún producto existente).
  try {
    const { rows } = await pool.query(
      `SELECT 1 FROM information_schema.table_constraints
        WHERE constraint_name = 'fichas_tecnicas_producto_id_fkey'`
    );
    if (rows.length === 0) {
      await pool.query(
        `ALTER TABLE fichas_tecnicas ADD CONSTRAINT fichas_tecnicas_producto_id_fkey
           FOREIGN KEY (producto_id) REFERENCES productos(id) ON DELETE CASCADE`
      );
    }
  } catch (e) {
    console.error('⚠️  No se pudo crear la FK fichas_tecnicas_producto_id_fkey (la columna producto_id sigue utilizable sin ella):', e.message);
  }

  // Unicidad del nombre de insumo POR LOCAL (reemplaza el índice viejo
  // "por proveedor", ya eliminado arriba). Parcial (WHERE local_id IS NOT
  // NULL): los insumos de prueba viejos, que quedaron sin local, no entran.
  // Guardado por su propio try/catch por si en alguna base existiera ya un
  // choque real de nombre+local.
  try {
    await pool.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS insumos_nombre_local_uidx
         ON insumos (lower(btrim(nombre)), local_id) WHERE local_id IS NOT NULL`
    );
  } catch (e) {
    console.error('⚠️  No se pudo crear el índice único insumos_nombre_local_uidx (probablemente hay dos insumos con el mismo nombre en un mismo local — corrígelos y el servidor lo reintentará):', e.message);
  }

  // Evita tener dos fichas técnicas ACTIVAS para el mismo producto (sigue
  // permitiendo cualquier cantidad de fichas inactivas/históricas para ese
  // mismo producto). Es un índice único PARCIAL (WHERE estado = TRUE), no
  // un UNIQUE normal sobre producto_id, precisamente para no bloquear ese
  // historial. Se crea aparte y guardado por su propio try/catch: si en
  // una base de datos existente ya hay más de una ficha activa para el
  // mismo producto (el bug que esta restricción corrige), la creación del
  // índice falla y el servidor sigue arrancando con normalidad — el
  // mensaje dice qué producto_id hay que revisar a mano, y el servidor
  // reintenta crear el índice en cada arranque hasta que quede resuelto.
  try {
    const { rows: duplicados } = await pool.query(
      `SELECT producto_id FROM fichas_tecnicas WHERE estado = TRUE AND producto_id IS NOT NULL
         GROUP BY producto_id HAVING COUNT(*) > 1`
    );
    if (duplicados.length > 0) {
      console.error(
        '⚠️  No se pudo crear el índice único fichas_tecnicas_producto_activo_uidx: hay más de una ficha técnica activa para el/los producto_id',
        duplicados.map(r => r.producto_id).join(', '),
        '— inactiva o edita las duplicadas y el servidor reintentará crear el índice en el próximo arranque.'
      );
    } else {
      await pool.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS fichas_tecnicas_producto_activo_uidx
           ON fichas_tecnicas(producto_id) WHERE estado = TRUE`
      );
    }
  } catch (e) {
    console.error('⚠️  No se pudo crear el índice único fichas_tecnicas_producto_activo_uidx:', e.message);
  }

  // Igual que las dos FK de arriba: el CHECK de "unidad" se crea aparte,
  // guardado por su propio try/catch, para que instalaciones existentes con
  // insumos que ya tengan una unidad antigua tipo "caja"/"paquete"/"bolsa"/
  // "docena" (las presentaciones de compra, que ahora se manejan por ítem
  // en POST /compras — nunca como unidad del insumo) no tumben el arranque
  // del servidor. Si falla, la columna sigue utilizable sin la restricción
  // y el mensaje deja claro qué insumos hay que corregir a mano; el server
  // reintenta crear el CHECK en cada arranque hasta que los datos queden
  // limpios.
  try {
    const { rows } = await pool.query(
      `SELECT 1 FROM information_schema.table_constraints
        WHERE constraint_name = 'insumos_unidad_check'`
    );
    if (rows.length === 0) {
      await pool.query(
        `ALTER TABLE insumos ADD CONSTRAINT insumos_unidad_check
           CHECK (unidad IS NULL OR unidad IN ('kg','g','lb','oz','L','mL','unidad'))`
      );
    }
  } catch (e) {
    console.error('⚠️  No se pudo crear el CHECK insumos_unidad_check (probablemente hay insumos con una unidad antigua como "caja"/"paquete"/"bolsa"/"docena" — corrígelos y el servidor lo reintentará en el próximo arranque):', e.message);
  }

  // Único conjunto de métodos de pago válido para pedidos NUEVOS:
  // 'efectivo', 'nequi', 'transferencia' (minúscula: así es como lo manda
  // realmente el frontend) — ver METODOS_PAGO_VALIDOS en routes/index.js,
  // que valida lo mismo en POST/PUT /pedidos antes de llegar aquí.
  //
  // Reemplaza una versión anterior de este CHECK que quedó mal desde el
  // principio: exigía 'Nequi'/'Bancolombia'/'Efectivo' EN MAYÚSCULA, un
  // valor que el frontend nunca mandó — así que en la práctica nunca
  // bloqueó nada distinto de lo que ya pasaba, y de paso dejaba coincidir
  // "distinto valor" con "método viejo" de forma confusa. Se elimina y se
  // vuelve a crear (no queda otra: ALTER TABLE ... DROP/ADD, no hay un
  // "ALTER CONSTRAINT" que cambie la definición de un CHECK existente).
  //
  // Se agrega con NOT VALID a propósito: así Postgres NO revisa las filas
  // que ya existen (pedidos viejos con 'Efectivo' en mayúscula, o con un
  // método que ya no es válido como 'Bancolombia'/'Daviplata'/'Tarjeta' —
  // esos quedan intactos, tal como se guardaron), pero sí exige esta lista
  // en cualquier INSERT o UPDATE de ahora en adelante. Sin NOT VALID, el
  // CHECK habría fallado al crearse por los pedidos en efectivo que ya
  // existían con 'Efectivo' en mayúscula.
  try {
    await pool.query(`ALTER TABLE pedidos DROP CONSTRAINT IF EXISTS pedidos_pago_check`);
    await pool.query(
      `ALTER TABLE pedidos ADD CONSTRAINT pedidos_pago_check
         CHECK (pago IS NULL OR pago IN ('efectivo','nequi','transferencia')) NOT VALID`
    );
  } catch (e) {
    console.error('⚠️  No se pudo recrear el CHECK pedidos_pago_check:', e.message);
  }

  // Único conjunto de valores válidos para pedidos.estado a nivel de base de
  // datos — mismo conjunto que ESTADOS_PEDIDO_VALIDOS en routes/index.js
  // (la fuente de verdad real). Última línea de defensa contra un "estado"
  // inventado que se cuele por Postgres directo.
  //
  // Se DROP + ADD (no "crear si no existe") porque la lista CAMBIÓ: se quitó
  // 'listo' y se agregó 'en_camino'. El paso dentro de "alters" ya movió
  // todo 'listo' → 'en_camino' antes de llegar acá, así que el CHECK nuevo
  // valida sin fallar. Sin NOT VALID a propósito: para este punto todas las
  // filas ya cumplen la lista.
  try {
    await pool.query(`ALTER TABLE pedidos DROP CONSTRAINT IF EXISTS pedidos_estado_check`);
    await pool.query(
      `ALTER TABLE pedidos ADD CONSTRAINT pedidos_estado_check
         CHECK (estado IN ('pendiente_verificacion','pendiente','en_proceso','en_camino','entregado','cancelado'))`
    );
  } catch (e) {
    console.error('⚠️  No se pudo recrear el CHECK pedidos_estado_check (probablemente quedó algún pedido con un estado fuera de lista) :', e.message);
  }
};

// ── Reparación de secuencias de "id" ────────────────────────────────────────
// `CREATE TABLE IF NOT EXISTS` (arriba y en schema.sql) NUNCA toca una tabla
// que ya existe en la base de datos. Si alguna de estas tablas quedó creada
// en algún momento sin el DEFAULT nextval(...) que da SERIAL (por ejemplo,
// por una migración manual o una versión antigua del schema), cada INSERT
// que no mande "id" explícitamente falla con:
//   "el valor nulo en la columna «id» ... viola la restricción de no nulo"
// Esto es exactamente lo que reportaron insumos, compras, proveedores y
// fichas_tecnicas. Esta función revisa cada tabla al arrancar y, si el
// "id" no tiene una secuencia asociada, se la crea y la deja como DEFAULT,
// sincronizada con el valor máximo actual para no chocar con filas ya
// existentes. Es 100% idempotente: si ya está bien, no hace nada.
const TABLAS_CON_ID = [
  'roles', 'usuarios', 'clientes', 'empleados', 'categorias', 'productos',
  'toppings', 'adiciones', 'combos', 'proveedores', 'categorias_insumos',
  'insumos', 'compras', 'pedidos', 'ventas', 'devoluciones',
  'fichas_tecnicas', 'resenas', 'tokens_verificacion', 'locales',
  'tipos_presentacion', 'ciudades',
];

const asegurarSecuenciaId = async (tabla) => {
  try {
    const { rows: existe } = await pool.query('SELECT to_regclass($1) AS reg', [tabla]);
    if (!existe[0].reg) return; // la tabla todavía no existe (se crea más arriba)

    // OJO: antes esto se decidía con pg_get_serial_sequence(tabla, 'id')
    // — "¿hay una secuencia asociada (OWNED BY) a esta columna?" — pero
    // una secuencia puede seguir asociada aunque el DEFAULT de la columna
    // se haya perdido después (ej. un ALTER COLUMN ... TYPE que cambia el
    // tipo sin volver a fijar el DEFAULT). Es exactamente lo que le pasó a
    // compras.id al migrarlo a VARCHAR(20) para los ids alfanuméricos:
    // pg_get_serial_sequence seguía devolviendo 'compras_id_seq' (la
    // secuencia nunca se borró), así que esta función asumía "ya está
    // bien" y nunca reparaba nada — mientras la columna se quedó sin
    // ningún DEFAULT real, y cada INSERT sin "id" explícito fallaba con
    // "el valor nulo en la columna «id» viola la restricción de no nulo".
    // Ahora se revisa el DEFAULT real de la columna (information_schema),
    // que es la única señal que de verdad importa para un INSERT.
    const { rows } = await pool.query(
      `SELECT column_default FROM information_schema.columns
        WHERE table_name=$1 AND column_name='id'`,
      [tabla]
    );
    if (rows[0]?.column_default) return; // ya tiene un DEFAULT real, nada que hacer

    const seqName = `${tabla}_id_seq`;
    await pool.query(`CREATE SEQUENCE IF NOT EXISTS "${seqName}"`);
    await pool.query(`ALTER SEQUENCE "${seqName}" OWNED BY ${tabla}.id`);
    // MAX(id) a secas rompe si "id" es varchar (como compras.id): Postgres
    // no sabe unificar el tipo de esa subconsulta (text) con el "0" entero
    // de COALESCE ("los tipos text y integer no son coincidentes en
    // COALESCE"). id::text + filtro por solo dígitos + ::bigint funciona
    // igual para una columna integer (siempre son solo dígitos) que para
    // una varchar con valores numéricos como "1"/"2"/... — y de paso no
    // truena si alguna vez hay un id alfanumérico real mezclado ahí.
    await pool.query(
      `SELECT setval('"${seqName}"',
         COALESCE((SELECT MAX(id::bigint) FROM ${tabla} WHERE id::text ~ '^[0-9]+$'), 0) + 1, false)`
    );
    await pool.query(`ALTER TABLE ${tabla} ALTER COLUMN id SET DEFAULT nextval('"${seqName}"')`);
    console.log(`🔧 Reparado el DEFAULT de "id" en la tabla "${tabla}" (le faltaba, aunque ya tenía una secuencia asociada).`);
  } catch (e) {
    console.error(`⚠️  No se pudo verificar/reparar la secuencia de "id" en "${tabla}":`, e.message);
  }
};

const repararSecuenciasId = async () => {
  for (const tabla of TABLAS_CON_ID) {
    await asegurarSecuenciaId(tabla);
  }
};

pool.connect()
  .then(async (client) => {
    client.release();
    console.log('✅ Conectado a PostgreSQL - sicaber');
    await migrar();
    await repararSecuenciasId();
    console.log('✅ Migraciones verificadas');
  })
  .catch(err => console.error('❌ Error de conexión:', err.message));

module.exports = pool;