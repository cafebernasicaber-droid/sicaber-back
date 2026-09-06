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
    // RETIRADO (esta ronda): "insumos.local_id" (cada insumo pertenecía a UN
    // local, una fila completa duplicada por local) ya NO se agrega acá —
    // ver migrarInsumoLocalYEmpaques más abajo, que consolida ese modelo en
    // insumo_local (un insumo, stock por local en una tabla puente) y
    // termina soltando local_id/stock/stock_minimo de "insumos" para las
    // instalaciones que sí las tenían. Si este ALTER siguiera acá, una
    // instalación NUEVA (schema.sql ya sin esas columnas) se las volvería a
    // agregar sin sentido, y migrarInsumoLocalYEmpaques intentaría leer
    // "stock" de una tabla que nunca la tuvo.
    //
    // La unicidad del nombre de un insumo se elimina de "por proveedor"
    // (índice viejo, de cuando el proveedor vivía en esta tabla) — ahora es
    // GLOBAL (insumos_nombre_uidx, creado más abajo).
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
    // Vaso y pitillo (requisito 3, Ronda 9): son insumos NORMALES del
    // módulo de Insumos (con su propia unidad — Vaso típicamente 'oz',
    // Pitillo típicamente 'unidad'), nunca un tipo especial ni la entidad
    // "empaques" de una ronda anterior. La columna vieja "vaso_id" ya NO
    // se agrega acá (a propósito: si siguiera acá, cada arranque la
    // resucitaría después de que el paso de renombrado de más abajo la
    // elimina, dejando un ciclo crea/borra infinito — mismo problema que
    // ya se corrigió con "es_adicion_sin_costo"). El paso guardado de más
    // abajo crea "vaso_insumo_id" directo si NINGUNA de las dos existe
    // todavía (instalación nueva), o la renombra si "vaso_id" ya existía.
    // Pasa a ser OPCIONAL (antes era obligatorio) — no todo producto usa
    // un vaso del inventario (ej. un producto de mostrador). cantidad_vaso
    // es la cantidad (en la unidad real de ESE insumo) que consume una
    // unidad del producto; antes esto era implícitamente 1, sin poder
    // configurarse.
    `ALTER TABLE fichas_tecnicas ADD COLUMN IF NOT EXISTS cantidad_vaso NUMERIC(10,2)`,
    `ALTER TABLE fichas_tecnicas ADD COLUMN IF NOT EXISTS lleva_pitillo BOOLEAN NOT NULL DEFAULT FALSE`,
    `ALTER TABLE fichas_tecnicas ADD COLUMN IF NOT EXISTS pitillo_insumo_id INTEGER REFERENCES insumos(id) ON DELETE SET NULL`,
    `ALTER TABLE fichas_tecnicas ADD COLUMN IF NOT EXISTS cantidad_pitillo NUMERIC(10,2)`,
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

    // ── LOCALES: datos extra para la vista de Empleados ──────────────────
    // "direccion" ya existía (casi siempre vacía en la práctica); faltaba
    // "telefono". Empleados/insumos con stock asignados se CALCULAN al
    // vuelo en GET /locales/todos (no se guardan acá).
    `ALTER TABLE locales ADD COLUMN IF NOT EXISTS telefono VARCHAR(30)`,

    // ── LOCALES: revertido el NOT NULL + placeholder de "direccion" ──────
    // BUG REAL que esto corrige (reportado con evidencia): la ronda pasada
    // metió el placeholder "(Pendiente de completar...)" como VALOR REAL de
    // "direccion" para los locales sembrados, aplicó NOT NULL, y agregó un
    // filtro en GET /locales que excluía cualquier local con ese texto —
    // pensado solo para el checkout público, pero GET /locales es el ÚNICO
    // endpoint de "locales activos" y también alimenta los selectores de
    // Compras e Insumos. Resultado: Villa Liliam y 3 Esquinas (activos,
    // reales) desaparecían de esos selectores, dejando solo el local que sí
    // tenía dirección real cargada.
    //
    // La dirección obligatoria en la CREACIÓN/EDICIÓN (validada en
    // routes/index.js) es correcta y se mantiene tal cual — el error fue
    // representarla con un NOT NULL a nivel de base de datos + un texto de
    // interfaz metido dentro del dato. Se revierte a la forma correcta:
    // columna NULLABLE (un registro existente sin dirección completa nunca
    // debe desaparecer de ningún listado ni bloquear ninguna operación) +
    // "direccionPendiente" CALCULADO en la respuesta (direccion IS NULL) —
    // no se agrega una columna nueva porque el dato ya está 100% implícito
    // en si "direccion" es NULL o no; guardar ambos sería la misma
    // información dos veces, con riesgo real de que queden desincronizados.
    //
    // Rollback (volver a lo de la ronda pasada — no recomendado, es lo que
    // causó el bug): `UPDATE locales SET direccion = '(Pendiente de
    // completar — actualízala en Empleados > Locales)' WHERE direccion IS
    // NULL; ALTER TABLE locales ALTER COLUMN direccion SET NOT NULL;`.
    `UPDATE locales SET direccion = NULL
       WHERE direccion = '(Pendiente de completar — actualízala en Empleados > Locales)'`,
    `ALTER TABLE locales ALTER COLUMN direccion DROP NOT NULL`,

    // ── ELIMINAR DOMICILIARIO DEL FLUJO DE PEDIDOS (requisito 1) ─────────
    // El sistema no maneja domiciliarios. Se DROPEA (no se deja nullable/
    // deprecada): es una columna de un concepto retirado del todo, no un
    // dato que se vaya a seguir consultando — dejarla ahí sería la misma
    // "segunda fuente de verdad muerta" que ya se evitó con
    // insumos.stock/local_id. El tipo de entrega 'domicilio' NO se toca
    // (pedidos.tipo sigue aceptando 'domicilio' con normalidad) — lo único
    // que desaparece es LA PERSONA asignada como repartidor.
    //
    // Datos históricos: se pierden (quién fue el domiciliario de un pedido
    // ya entregado hace tiempo) — se tomó un pg_dump completo de la base
    // ANTES de correr esta migración
    // (sicaber_backup_pre_drop_domiciliario_YYYYMMDD_HHMMSS.sql) por si
    // hace falta recuperar ese dato puntual más adelante. Rollback: restaurar
    // ese dump, o simplemente `ALTER TABLE pedidos ADD COLUMN domiciliario_id
    // INTEGER REFERENCES usuarios(id) ON DELETE SET NULL` (la columna vuelve
    // vacía — sin el dump no hay forma de recuperar quién era el
    // domiciliario de cada pedido histórico).
    `ALTER TABLE pedidos DROP COLUMN IF EXISTS domiciliario_id`,

    // ── INVENTARIO POR LOCAL (insumo_local) ─────────────────────────────
    // Hasta acá, "un insumo pertenece a un único local" (insumos.local_id)
    // se resolvía duplicando la FILA completa del insumo por cada local —
    // mismo nombre, misma unidad, filas separadas con su propio stock. Eso
    // dejaba el catálogo lleno de duplicados reales (ver migrarInsumoLocal
    // más abajo, que los consolida) y no dejaba ver de un vistazo "cuánto
    // hay de este insumo en cada local". insumo_local es la tabla puente:
    // UN insumo (fila única, catálogo) + UN local = una fila con su propio
    // stock/mínimo/estado. Se crea aquí (justo después de "locales", de la
    // que depende, y antes de tocar "insumos") para que migrarInsumoLocal
    // ya la tenga disponible.
    `CREATE TABLE IF NOT EXISTS insumo_local (
       id           SERIAL PRIMARY KEY,
       insumo_id    INTEGER NOT NULL REFERENCES insumos(id) ON DELETE CASCADE,
       local_id     INTEGER NOT NULL REFERENCES locales(id) ON DELETE CASCADE,
       stock        NUMERIC(10,2) NOT NULL DEFAULT 0,
       stock_minimo NUMERIC(10,2) NOT NULL DEFAULT 0,
       activo       BOOLEAN NOT NULL DEFAULT TRUE,
       created_at   TIMESTAMP DEFAULT NOW(),
       UNIQUE(insumo_id, local_id)
     )`,

    // ── TIPO DE USO DEL INSUMO ───────────────────────────────────────────
    // Un insumo puede servir de más de una forma a la vez: como ingrediente
    // normal de receta (es_insumo), como candidato de una Adición CON costo
    // (es_adicion) o como candidato de Topping GRATUITO (es_topping, ya
    // existía como flag puramente informativo — ahora además filtra de
    // verdad en GET /insumos?tipo=topping). DEFAULT TRUE en es_insumo para
    // que los insumos ya existentes (todos usados como ingrediente hasta
    // hoy) sigan cumpliendo el CHECK "al menos uno en true" sin necesitar
    // backfill aparte.
    //
    // ⚠️ "es_adicion" se llamó "es_adicion_sin_costo" hasta que se corrigió
    // el nombre (contradecía la definición real de "Adición": SIEMPRE tiene
    // costo — ver la auditoría completa en CAMBIOS.md). El paso de creación
    // de la columna YA NO agrega "es_adicion_sin_costo" (a propósito: si
    // siguiera acá, cada arranque la resucitaría después de que el paso de
    // renombrado de más abajo la elimina, dejando dos columnas — una viva
    // y una zombi siempre en false). Instalaciones que TODAVÍA no pasaron
    // por el renombrado (nunca tuvieron ninguna de las dos) reciben
    // "es_adicion" directo, sin pasar por el nombre viejo.
    `ALTER TABLE insumos ADD COLUMN IF NOT EXISTS es_insumo BOOLEAN NOT NULL DEFAULT TRUE`,
    `ALTER TABLE insumos ADD COLUMN IF NOT EXISTS es_adicion BOOLEAN NOT NULL DEFAULT FALSE`,

    // ── EMPAQUES (vasos, pitillos, desechables) ──────────────────────────
    // Se separan de "insumos" porque no son perecederos, no llevan receta y
    // se descuentan por PRODUCTO/TAMAÑO (producto_empaque), no por ficha
    // técnica. Mismo patrón exacto que insumos/insumo_local: catálogo global
    // + stock por local en una tabla puente propia.
    `CREATE TABLE IF NOT EXISTS empaques (
       id              SERIAL PRIMARY KEY,
       nombre          VARCHAR(150) NOT NULL UNIQUE,
       descripcion     TEXT,
       unidad          VARCHAR(50) NOT NULL DEFAULT 'unidad'
                         CHECK (unidad IN ('kg','g','lb','oz','L','mL','unidad')),
       precio_unitario NUMERIC(10,2) DEFAULT 0,
       estado          VARCHAR(20) NOT NULL DEFAULT 'Activo',
       created_at      TIMESTAMP DEFAULT NOW()
     )`,
    `CREATE TABLE IF NOT EXISTS empaque_local (
       id           SERIAL PRIMARY KEY,
       empaque_id   INTEGER NOT NULL REFERENCES empaques(id) ON DELETE CASCADE,
       local_id     INTEGER NOT NULL REFERENCES locales(id) ON DELETE CASCADE,
       stock        NUMERIC(10,2) NOT NULL DEFAULT 0,
       stock_minimo NUMERIC(10,2) NOT NULL DEFAULT 0,
       activo       BOOLEAN NOT NULL DEFAULT TRUE,
       created_at   TIMESTAMP DEFAULT NOW(),
       UNIQUE(empaque_id, local_id)
     )`,
    // Qué vaso usa cada producto/tamaño y si lleva pitillo (y cuál). "tamano"
    // es opcional: NULL representa la configuración por defecto del
    // producto cuando no maneja tamaños. Se descuenta automáticamente al
    // vender — ver calcularRecetaEfectiva/descontarInventarioPorVenta en
    // routes/index.js.
    `CREATE TABLE IF NOT EXISTS producto_empaque (
       id                 SERIAL PRIMARY KEY,
       producto_id        INTEGER NOT NULL REFERENCES productos(id) ON DELETE CASCADE,
       tamano             VARCHAR(50),
       vaso_empaque_id    INTEGER REFERENCES empaques(id) ON DELETE SET NULL,
       lleva_pitillo      BOOLEAN NOT NULL DEFAULT FALSE,
       pitillo_empaque_id INTEGER REFERENCES empaques(id) ON DELETE SET NULL,
       created_at         TIMESTAMP DEFAULT NOW(),
       UNIQUE(producto_id, tamano)
     )`,
    // Toppings/adiciones ya podían descontar stock de un INSUMO (insumo_id).
    // Ahora, además, pueden descontar stock de un EMPAQUE (ej. el topping
    // "Pitillo extra") — mutuamente excluyente en la práctica, pero sin
    // CHECK que lo obligue: las rutas ya validan que solo venga uno.
    `ALTER TABLE toppings  ADD COLUMN IF NOT EXISTS empaque_id INTEGER`,
    `ALTER TABLE adiciones ADD COLUMN IF NOT EXISTS empaque_id INTEGER`,

    // ── MOVIMIENTOS DE INVENTARIO (trazabilidad por local) ───────────────
    // Antes una compra o una venta solo se veían reflejadas como un delta
    // silencioso en insumos.stock (o, ahora, insumo_local.stock): no había
    // ningún registro de CUÁNDO se movió cuánto, de qué local, ni por qué
    // (compra X, venta del pedido Y, ajuste manual). Esta tabla es
    // puramente aditiva (nadie la lee todavía para calcular nada — el
    // stock vigente sigue viviendo en insumo_local/empaque_local) y sirve
    // de kardex/auditoría.
    `CREATE TABLE IF NOT EXISTS movimientos_inventario (
       id              SERIAL PRIMARY KEY,
       tipo            VARCHAR(30) NOT NULL, -- 'compra' | 'anulacion_compra' | 'venta' | 'ajuste'
       insumo_id       INTEGER REFERENCES insumos(id) ON DELETE SET NULL,
       empaque_id      INTEGER REFERENCES empaques(id) ON DELETE SET NULL,
       local_id        INTEGER NOT NULL REFERENCES locales(id),
       cantidad        NUMERIC(10,2) NOT NULL, -- delta aplicado (+ suma, - resta)
       referencia_tipo VARCHAR(30), -- 'compra' | 'pedido'
       referencia_id   INTEGER,
       created_at      TIMESTAMP DEFAULT NOW()
     )`,

    // Limpieza de locales obsoletos: "Local 1", "Local 2" y "Local Principal"
    // eran placeholders anteriores a este módulo — los únicos dos locales
    // reales del sistema son "Local Villa Liliam" y "Local 3 Esquinas". Corre
    // ANTES del relleno de usuarios.local_id de abajo, para que ningún
    // usuario quede re-enganchado a un local obsoleto por su "sede".
    //
    // 1º) Se ELIMINAN definitivamente los obsoletos que no tengan NINGÚN
    //     registro asociado (así desaparecen de todos los endpoints, no solo
    //     quedan inactivos). Idempotente: si ya no existen, no borra nada.
    // "insumos.local_id" ya no existe (esta ronda: ver insumo_local más
    // abajo) — el chequeo equivalente ahora es "¿este local tiene alguna
    // fila de stock en insumo_local/empaque_local?".
    `DELETE FROM locales l
      WHERE l.nombre IN ('Local 1', 'Local 2', 'Local Principal')
        AND NOT EXISTS (SELECT 1 FROM compras   WHERE local_id = l.id)
        AND NOT EXISTS (SELECT 1 FROM pedidos   WHERE local_id = l.id)
        AND NOT EXISTS (SELECT 1 FROM ventas v JOIN pedidos p ON p.id = v.pedido_id WHERE p.local_id = l.id)
        AND NOT EXISTS (SELECT 1 FROM insumo_local  WHERE local_id = l.id)
        AND NOT EXISTS (SELECT 1 FROM empaque_local WHERE local_id = l.id)
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
    // "Atendido por": se deja de usar la columna de texto libre (barista,
    // que guardaba un NOMBRE suelto) y se pasa a la columna por id
    // (atendido_por → usuarios.id), que ya existe con su FK. Se intenta
    // resolver el nombre viejo a un usuario real por coincidencia exacta de
    // nombre; lo que no matchee queda en NULL (no se pierde nada crítico:
    // era un dato informativo). Después se ELIMINA la columna de texto
    // para no dejarla conviviendo (media docena de rutas escribían en
    // ella y ninguna la leía de verdad).
    //
    // RETIRADO (Ronda 9): el paso equivalente para "domiciliario" (texto) →
    // "domiciliario_id" ya no aplica — domiciliario_id se DROPEÓ del todo
    // en la Ronda 7 (el sistema no maneja domiciliarios). Dejarlo acá
    // fallaba en CADA arranque ("no existe la columna domiciliario_id"),
    // guardado/inofensivo pero ruidoso — se quita, igual que se quitó el
    // ADD COLUMN de es_adicion_sin_costo tras su propio rename.
    `UPDATE pedidos p SET atendido_por = u.id
       FROM usuarios u
      WHERE p.atendido_por IS NULL AND p.barista IS NOT NULL
        AND lower(btrim(u.nombre)) = lower(btrim(p.barista))`,
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

  // ── vaso_id → vaso_insumo_id (requisito 3, Ronda 9) ──────────────────
  // Mismo patrón guardado que el rename de insumos.es_adicion_sin_costo:
  // Postgres no tiene "RENAME COLUMN IF EXISTS", así que se verifica el
  // estado de las dos columnas a mano. Conserva el dato (mismo id de
  // insumo); no es una migración de valores, solo de nombre.
  try {
    const { rows: viejo } = await pool.query(
      `SELECT 1 FROM information_schema.columns WHERE table_name='fichas_tecnicas' AND column_name='vaso_id'`
    );
    const { rows: nuevo } = await pool.query(
      `SELECT 1 FROM information_schema.columns WHERE table_name='fichas_tecnicas' AND column_name='vaso_insumo_id'`
    );
    if (viejo.length && !nuevo.length) {
      await pool.query(`ALTER TABLE fichas_tecnicas RENAME COLUMN vaso_id TO vaso_insumo_id`);
      console.log('🔧 fichas_tecnicas.vaso_id renombrada a vaso_insumo_id (mismo dato conservado).');
    } else if (viejo.length && nuevo.length) {
      // Ambas existen (arranque anterior interrumpido a mitad del rename):
      // "vaso_insumo_id" es la que vale; se descarta la vieja.
      await pool.query(`ALTER TABLE fichas_tecnicas DROP COLUMN vaso_id`);
      console.log('🔧 fichas_tecnicas.vaso_id (columna duplicada) eliminada — vaso_insumo_id ya tenía el dato.');
    } else if (!viejo.length && !nuevo.length) {
      // Ninguna existe: instalación nueva (nunca pasó por "vaso_id") — se
      // crea directo con el nombre final, sin rodeos por el nombre viejo.
      await pool.query(`ALTER TABLE fichas_tecnicas ADD COLUMN vaso_insumo_id INTEGER`);
    }
  } catch (e) {
    console.error('⚠️  No se pudo corregir fichas_tecnicas.vaso_id/vaso_insumo_id:', e.message);
  }
  // Fichas ya existentes con vaso asignado: antes el descuento por venta
  // siempre consumía exactamente 1 unidad del vaso (fijo, no configurable
  // — ver calcularRecetaEfectiva). Se migra sin perder el dato: la cantidad
  // equivalente a ese comportamiento anterior es 1.
  try {
    await pool.query(
      `UPDATE fichas_tecnicas SET cantidad_vaso = 1 WHERE vaso_insumo_id IS NOT NULL AND cantidad_vaso IS NULL`
    );
  } catch (e) {
    console.error('⚠️  No se pudo completar cantidad_vaso para fichas con vaso ya asignado:', e.message);
  }

  // La FK de fichas_tecnicas.vaso_insumo_id se crea aparte, en su propio
  // paso: si fuera parte del mismo ALTER TABLE que agrega la columna, una
  // restricción que no se puede implementar (p. ej. por datos existentes
  // que no cumplirían la FK) haría fallar TODO el ALTER TABLE, y entonces
  // ni siquiera la columna quedaría creada — repitiendo el error en cada
  // arranque sin que nada lo corrija. Aquí, si la FK no se puede crear, la
  // columna igual queda disponible como columna normal (sin integridad
  // referencial) y el servidor arranca con normalidad.
  try {
    const { rows } = await pool.query(
      `SELECT 1 FROM information_schema.table_constraints
        WHERE constraint_name = 'fichas_tecnicas_vaso_insumo_id_fkey'`
    );
    if (rows.length === 0) {
      await pool.query(
        `ALTER TABLE fichas_tecnicas ADD CONSTRAINT fichas_tecnicas_vaso_insumo_id_fkey
           FOREIGN KEY (vaso_insumo_id) REFERENCES insumos(id) ON DELETE SET NULL`
      );
    }
  } catch (e) {
    console.error('⚠️  No se pudo crear la FK fichas_tecnicas_vaso_insumo_id_fkey (la columna vaso_insumo_id sigue utilizable sin ella):', e.message);
  }

  // FK de fichas_tecnicas.pitillo_insumo_id — mismo tratamiento tolerante a
  // fallos (la columna ya se creó con REFERENCES en línea, arriba en
  // "alters"; acá solo se revisa por si esa FK en línea no llegó a
  // aplicarse en alguna instalación existente).
  try {
    const { rows } = await pool.query(
      `SELECT 1 FROM information_schema.table_constraints
        WHERE constraint_name = 'fichas_tecnicas_pitillo_insumo_id_fkey'`
    );
    if (rows.length === 0) {
      await pool.query(
        `ALTER TABLE fichas_tecnicas ADD CONSTRAINT fichas_tecnicas_pitillo_insumo_id_fkey
           FOREIGN KEY (pitillo_insumo_id) REFERENCES insumos(id) ON DELETE SET NULL`
      );
    }
  } catch (e) {
    console.error('⚠️  No se pudo crear la FK fichas_tecnicas_pitillo_insumo_id_fkey:', e.message);
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

  // FK de las columnas local_id de usuarios / compras — mismo tratamiento
  // separado y tolerante a fallos que pedidos_local_id_fkey: si no se puede
  // crear (p. ej. datos que no cumplirían la FK), la columna se sigue
  // usando sin integridad referencial y el servidor arranca igual. Sin ON
  // DELETE: un local con usuarios/compras asociados no se puede borrar — y
  // de todos modos no hay ninguna ruta que borre locales.
  //
  // "insumos" YA NO tiene local_id propio (ver migrarInsumoLocalYEmpaques
  // más abajo: el local de un insumo ahora vive en insumo_local, una fila
  // por insumo+local con su propio stock) — se sacó de esta lista para no
  // reintentar en vano una FK sobre una columna que dejó de existir.
  for (const [tabla, constraint] of [
    ['usuarios', 'usuarios_local_id_fkey'],
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

  // ── CONSOLIDACIÓN insumo_local / EMPAQUES ────────────────────────────
  // Hasta esta ronda, "insumos" tenía UNA fila por insumo POR LOCAL (mismo
  // nombre, filas separadas) — de ahí que el catálogo mostrara "Pitillos",
  // "Vasos de cartón", "Hielo", "Café molido", etc. repetidos, uno por
  // local. migrarInsumoLocalYEmpaques() hace, una sola vez (es idempotente:
  // en cuanto ya no quedan duplicados ni empaques dentro de "insumos", no
  // encuentra nada que hacer):
  //   1) Saca de "insumos" los que son EMPAQUES (categoría "Empaques":
  //      vasos, pitillos, desechables) hacia la tabla nueva "empaques" +
  //      "empaque_local", conservando su stock por local.
  //   2) Consolida el resto: por cada nombre duplicado, deja UNA fila en
  //      "insumos" (el catálogo) y mueve el stock/mínimo de cada duplicado
  //      a su fila correspondiente en insumo_local.
  // Debe correr ANTES de intentar soltar insumos.stock/local_id (los
  // necesita leer) y antes del índice único global de más abajo (los
  // duplicados de nombre tienen que haber desaparecido primero).
  await migrarInsumoLocalYEmpaques();

  // migrarInsumoLocalYEmpaques() solo resuelve duplicados/empaques —
  // deja sin insumo_local a los insumos que NUNCA se duplicaron y NUNCA
  // tuvieron un local asignado (creados antes de que el local fuera
  // obligatorio, o mientras estuvo temporalmente opcional). Requisito 3
  // (esta ronda) pide que TODOS los insumos existentes queden asignados a
  // un local — se completa acá.
  await asegurarInsumoLocalParaTodos();

  // Requisito 2 (esta ronda): TODO insumo debe tener una fila de
  // insumo_local en TODO local activo (aunque sea stock=0) — antes solo se
  // creaba para el local elegido al crear el insumo, así que un insumo
  // creado antes de que existiera un local nuevo (o un local nuevo creado
  // antes de esta ronda, cuando POST /locales todavía no propagaba a los
  // insumos existentes) se quedaba "ausente" en ese local. Se completa acá
  // para todas las combinaciones insumo×local que falten, con
  // stock_actual=0 y el mismo stock_minimo por defecto que usa POST
  // /locales (el mayor que ese insumo ya tenga en cualquier otro local, o 0
  // si nunca tuvo ninguno). Idempotente: solo llena los huecos reales.
  await asegurarInsumoLocalEnTodosLosLocales();

  // ── Backfill de ventas faltantes (requisito 7, esta ronda) ───────────
  // Auditoría de "pedidos atascados o mal contados": encontré 1 pedido
  // ('entregado', de antes de que existiera la creación automática de
  // venta + descuento de inventario en la misma transacción) sin ninguna
  // fila en "ventas" — invisible para el módulo de Ventas aunque su estado
  // diga "entregado". Se completa el registro FINANCIERO (la fila de
  // ventas), con la fecha real del pedido para no distorsionar "ventas de
  // hoy" — pero NO se reintenta el descuento de inventario: eso ya pasó
  // (o no pasó) hace días, y recalcularlo ahora sobre el stock ACTUAL
  // sería inventar un movimiento que nunca ocurrió así. Idempotente: solo
  // toca pedidos 'entregado' que todavía no tengan su venta.
  try {
    const { rows } = await pool.query(
      `INSERT INTO ventas(pedido_id, total, estado, created_at)
         SELECT p.id, p.total, 'vendido', p.created_at
           FROM pedidos p
          WHERE p.estado = 'entregado'
            AND NOT EXISTS (SELECT 1 FROM ventas v WHERE v.pedido_id = p.id)
         RETURNING pedido_id`
    );
    if (rows.length) {
      console.log(`🔧 Backfill de ventas: se completó la venta de ${rows.length} pedido(s) 'entregado' que no la tenían (ids: ${rows.map(r => r.pedido_id).join(', ')}) — sin recalcular inventario.`);
    }
  } catch (e) {
    console.error('⚠️  No se pudo completar el backfill de ventas faltantes:', e.message);
  }

  // Ya consolidados los duplicados, insumos.stock/stock_minimo/local_id
  // quedan MUERTOS (ver arriba: todo insumo activo o migrado ya tiene su
  // insumo_local). Se sueltan para que no quede una segunda fuente de
  // verdad del stock. Guardado y NO destructivo si algo quedó sin resolver:
  // solo se ejecuta cuando NINGÚN insumo retiene local_id (ninguno quedó
  // "colgado" del modelo viejo) — si migrarInsumoLocalYEmpaques dejó algo
  // pendiente (ver su propio log), esto se salta entero y lo reintenta en
  // el próximo arranque, sin perder ningún dato.
  try {
    const { rows: colInfo } = await pool.query(
      `SELECT 1 FROM information_schema.columns WHERE table_name='insumos' AND column_name='local_id'`
    );
    if (colInfo.length) {
      const { rows: pendientes } = await pool.query(
        `SELECT id, nombre FROM insumos WHERE local_id IS NOT NULL OR COALESCE(stock,0) <> 0`
      );
      if (pendientes.length === 0) {
        await pool.query(`ALTER TABLE insumos DROP COLUMN IF EXISTS stock`);
        await pool.query(`ALTER TABLE insumos DROP COLUMN IF EXISTS stock_minimo`);
        await pool.query(`ALTER TABLE insumos DROP COLUMN IF EXISTS local_id`);
        console.log('🔧 insumos.stock/stock_minimo/local_id eliminadas: el stock por local ahora vive en insumo_local.');
      } else {
        console.error(
          '⚠️  insumos.stock/local_id NO se eliminan todavía: quedan', pendientes.length,
          'insumo(s) sin consolidar en insumo_local (revisa el aviso de migrarInsumoLocalYEmpaques) —',
          pendientes.map(p => `#${p.id} "${p.nombre}"`).join(', ')
        );
      }
    }
  } catch (e) {
    console.error('⚠️  No se pudo verificar/soltar insumos.stock/stock_minimo/local_id:', e.message);
  }

  // Unicidad del nombre de insumo GLOBAL (reemplaza el índice viejo "por
  // local": ahora un insumo es UN registro, sin importar en cuántos locales
  // tenga stock — ver insumo_local). Se suelta primero el índice viejo.
  // Guardado: si migrarInsumoLocalYEmpaques dejó un nombre duplicado sin
  // resolver (choque de unidades — ver su log), este índice no se puede
  // crear todavía y el servidor lo reintenta en cada arranque.
  try {
    await pool.query(`DROP INDEX IF EXISTS insumos_nombre_local_uidx`);
    await pool.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS insumos_nombre_uidx ON insumos (lower(btrim(nombre)))`
    );
  } catch (e) {
    console.error('⚠️  No se pudo crear el índice único insumos_nombre_uidx (probablemente hay dos insumos con el mismo nombre sin consolidar — corrígelos y el servidor lo reintentará):', e.message);
  }

  // ── CORRECCIÓN "TIPO DE USO": es_adicion_sin_costo → es_adicion ─────────
  // Auditoría (ver el reporte completo en CAMBIOS.md, hecho ANTES de tocar
  // nada): "es_adicion_sin_costo" era un nombre contradictorio — una
  // "Adición", por definición del negocio, SIEMPRE tiene costo (la tabla
  // "adiciones" ya lo refleja: sus 11 filas reales tienen precio > 0); lo
  // GRATUITO y opcional es el "Topping" (la tabla "toppings" nunca tuvo
  // columna de precio). No se encontró ningún insumo con los booleanos
  // de es_topping/es_adicion_sin_costo REALMENTE invertidos entre sí (se
  // verificó cruzando contra toppings.insumo_id/adiciones.insumo_id reales:
  // ningún insumo usado por un topping real tenía es_adicion_sin_costo=true,
  // y viceversa) — el problema era solo el NOMBRE de la columna, así que
  // esto es un RENAME (conserva los valores tal cual, sin swap) + un
  // backfill puntual de un dato incompleto (ver abajo), no una inversión
  // de datos. Guardado como RENAME COLUMN no tiene "IF EXISTS" en Postgres,
  // así que se verifica el estado de las columnas a mano antes de correrlo.
  try {
    const { rows: viejo } = await pool.query(
      `SELECT 1 FROM information_schema.columns WHERE table_name='insumos' AND column_name='es_adicion_sin_costo'`
    );
    const { rows: nuevo } = await pool.query(
      `SELECT 1 FROM information_schema.columns WHERE table_name='insumos' AND column_name='es_adicion'`
    );
    if (viejo.length && !nuevo.length) {
      // Caso normal: todavía no se había renombrado.
      await pool.query(`ALTER TABLE insumos RENAME COLUMN es_adicion_sin_costo TO es_adicion`);
      console.log('🔧 insumos.es_adicion_sin_costo renombrada a es_adicion (mismos valores, sin invertir nada) — ver auditoría en CAMBIOS.md.');
    } else if (viejo.length && nuevo.length) {
      // Las dos existen: "es_adicion" ya tiene los valores reales (viene de
      // un renombrado anterior); "es_adicion_sin_costo" es una columna
      // ZOMBI (el paso de "alters" de arriba la re-creaba en cada arranque,
      // antes de que se corrigiera para dejar de hacerlo) — siempre en
      // false, sin dato real que conservar. Se descarta.
      await pool.query(`ALTER TABLE insumos DROP COLUMN es_adicion_sin_costo`);
      console.log('🔧 insumos.es_adicion_sin_costo (columna zombi, siempre en false) eliminada — insumos.es_adicion ya tenía los valores reales.');
    }
  } catch (e) {
    console.error('⚠️  No se pudo corregir insumos.es_adicion_sin_costo/es_adicion:', e.message);
  }
  // Backfill: 2 insumos (Crema chantilly, Hielo) SÍ están usados por un
  // topping real (toppings.insumo_id) pero nunca quedaron marcados
  // es_topping=true (la marca es informativa/de filtro, nunca condicionó
  // el descuento de stock — por eso pasó desapercibido). Se corrige acá,
  // no es una inversión: se ENCIENDE lo que faltaba, nunca se apaga nada.
  try {
    await pool.query(
      `UPDATE insumos SET es_topping = true
        WHERE es_topping = false
          AND id IN (SELECT insumo_id FROM toppings WHERE insumo_id IS NOT NULL)`
    );
  } catch (e) {
    console.error('⚠️  No se pudo completar es_topping para insumos ya usados por un topping real:', e.message);
  }

  // Tipo de uso del insumo: debe servir para AL MENOS una de las tres cosas
  // (ingrediente normal / adición con costo / topping gratuito). DEFAULT
  // TRUE de es_insumo (arriba, en "alters") ya deja a todo insumo existente
  // cumpliendo esto, así que el CHECK se puede agregar directo (sin
  // NOT VALID: no hay filas que puedan violarlo a esta altura).
  try {
    const { rows } = await pool.query(
      `SELECT 1 FROM information_schema.table_constraints
        WHERE constraint_name = 'insumos_tipo_uso_check'`
    );
    if (rows.length === 0) {
      await pool.query(
        `ALTER TABLE insumos ADD CONSTRAINT insumos_tipo_uso_check
           CHECK (es_insumo OR es_adicion OR es_topping)`
      );
    }
  } catch (e) {
    console.error('⚠️  No se pudo crear el CHECK insumos_tipo_uso_check (probablemente hay un insumo con las tres marcas en false — corrígelo y el servidor lo reintentará):', e.message);
  }

  // FK de toppings.empaque_id / adiciones.empaque_id — mismo tratamiento
  // tolerante a fallos que toppings_insumo_id_fkey / adiciones_insumo_id_fkey.
  for (const [tabla, constraint] of [
    ['toppings',  'toppings_empaque_id_fkey'],
    ['adiciones', 'adiciones_empaque_id_fkey'],
  ]) {
    try {
      const { rows } = await pool.query(
        `SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = $1`,
        [constraint]
      );
      if (rows.length === 0) {
        await pool.query(
          `ALTER TABLE ${tabla} ADD CONSTRAINT ${constraint}
             FOREIGN KEY (empaque_id) REFERENCES empaques(id) ON DELETE SET NULL`
        );
      }
    } catch (e) {
      console.error(`⚠️  No se pudo crear la FK ${constraint} (la columna empaque_id sigue utilizable sin ella):`, e.message);
    }
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

// ── Conversión de unidades (solo dentro de la MISMA dimensión) ──────────────
// Se usa exclusivamente para fusionar el stock de un insumo "huérfano" (de
// antes de que existiera local_id, ver más abajo) con el de sus duplicados
// por local, cuando quedaron registrados en unidades distintas pero
// convertibles (ej. 400 g == 0.4 kg). Nunca convierte entre dimensiones
// distintas (ej. "unidad" ↔ "kg"): en ese caso devuelve null y quien llama
// debe dejar ese caso para revisión manual en vez de adivinar.
const DIMENSION_UNIDAD = { kg: 'masa', g: 'masa', lb: 'masa', oz: 'masa', L: 'volumen', mL: 'volumen', unidad: 'conteo' };
const FACTOR_BASE_UNIDAD = { kg: 1000, g: 1, lb: 453.592, oz: 28.3495, L: 1000, mL: 1, unidad: 1 };
const convertirUnidad = (cantidad, unidadOrigen, unidadDestino) => {
  if (unidadOrigen === unidadDestino) return cantidad;
  if (!DIMENSION_UNIDAD[unidadOrigen] || !DIMENSION_UNIDAD[unidadDestino]) return null;
  if (DIMENSION_UNIDAD[unidadOrigen] !== DIMENSION_UNIDAD[unidadDestino]) return null;
  return (Number(cantidad) * FACTOR_BASE_UNIDAD[unidadOrigen]) / FACTOR_BASE_UNIDAD[unidadDestino];
};

// ── CONSOLIDACIÓN insumo_local / EMPAQUES (datos, no solo schema) ───────────
// Antes de esta ronda, "un insumo pertenece a un local" se resolvía
// duplicando la fila completa por cada local (mismo nombre, filas
// separadas). Esta función junta esos duplicados en UN registro de
// "insumos" (o de la nueva tabla "empaques", si la categoría es
// "Empaques") + una fila por local en insumo_local/empaque_local con su
// stock real. Se llama en cada arranque; en cuanto ya no hay nada que
// consolidar, recorre la tabla y no hace ningún cambio (idempotente).
//
// Regla de fusión (por grupo de insumos con el mismo nombre, sin importar
// mayúsculas/espacios):
//   • La fila CANÓNICA (la que sobrevive en "insumos"/"empaques") es la de
//     menor id entre las que YA tienen local_id (metadata más reciente); si
//     ninguna tiene local_id, la de menor id a secas.
//   • Cada fila CON local_id se vuelve una fila de insumo_local/empaque_local
//     (conserva su propio stock/mínimo/estado) y se borra de la tabla
//     origen — pero solo si todas las filas CON local_id de este grupo
//     comparten la misma unidad (fusionar cantidades en unidades distintas
//     sin convertir sería inventar un número).
//   • Una fila SIN local_id (insumo de antes del multi-local, con stock
//     real acumulado) se sólo se puede sumar al local de menor id del grupo
//     si su unidad es CONVERTIBLE a la unidad común (ver convertirUnidad).
//     Si no lo es, se deja intacta —sin tocar— y se reporta para revisión
//     manual: mejor un insumo pendiente de fusionar a mano que un número de
//     stock inventado.
const migrarInsumoLocalYEmpaques = async () => {
  // Si insumos.local_id ya no existe, esta instalación ya consolidó todo
  // en una vuelta anterior — nada que hacer.
  const { rows: colInfo } = await pool.query(
    `SELECT 1 FROM information_schema.columns WHERE table_name='insumos' AND column_name='local_id'`
  );
  if (!colInfo.length) return;

  const { rows: catEmpaques } = await pool.query(
    `SELECT id FROM categorias_insumos WHERE lower(btrim(nombre)) = 'empaques' LIMIT 1`
  );
  const idCategoriaEmpaques = catEmpaques[0]?.id ?? null;

  const { rows: todos } = await pool.query(
    `SELECT id, nombre, unidad, stock, stock_minimo, categoria_id, estado, local_id
       FROM insumos ORDER BY nombre, id`
  );
  const grupos = new Map();
  for (const fila of todos) {
    const clave = fila.nombre.trim().toLowerCase();
    if (!grupos.has(clave)) grupos.set(clave, []);
    grupos.get(clave).push(fila);
  }

  // Repunta cualquier referencia a los ids de INSUMO que se van a borrar (los
  // duplicados fusionados en la canónica) hacia el id de insumo que
  // sobrevive — toppings/adiciones guardan insumo_id como columna real;
  // fichas_tecnicas guarda id_insumo DENTRO del JSON de ingredientes (y
  // vaso_insumo_id/pitillo_insumo_id como columnas reales), así que ahí se
  // reescribe el jsonb entero. Solo se usa para grupos que siguen siendo
  // INSUMOS (nunca para un grupo que se va a "empaques": ahí la referencia
  // debe pasar a empaque_id, no seguir siendo un insumo_id — ver
  // repuntarReferenciasAEmpaque).
  const repuntarReferenciasInsumo = async (idsViejos, idNuevo) => {
    if (!idsViejos.length) return;
    await pool.query(`UPDATE toppings  SET insumo_id=$1 WHERE insumo_id = ANY($2::int[])`, [idNuevo, idsViejos]);
    await pool.query(`UPDATE adiciones SET insumo_id=$1 WHERE insumo_id = ANY($2::int[])`, [idNuevo, idsViejos]);
    await pool.query(`UPDATE fichas_tecnicas SET vaso_insumo_id=$1 WHERE vaso_insumo_id = ANY($2::int[])`, [idNuevo, idsViejos]);
    await pool.query(`UPDATE fichas_tecnicas SET pitillo_insumo_id=$1 WHERE pitillo_insumo_id = ANY($2::int[])`, [idNuevo, idsViejos]);
    await pool.query(
      `UPDATE fichas_tecnicas SET ingredientes = (
         SELECT jsonb_agg(
           CASE WHEN (ing->>'id_insumo')::int = ANY($2::int[])
                THEN jsonb_set(ing, '{id_insumo}', to_jsonb($1::int))
                ELSE ing END
         ) FROM jsonb_array_elements(ingredientes) ing
       )
       WHERE ingredientes::text ~ ANY (SELECT '"id_insumo":\\s*' || x::text || '\\D' FROM unnest($2::int[]) x)`,
      [idNuevo, idsViejos]
    ).catch(() => {}); // best-effort: una ficha sin ingredientes en ese formato no debe tumbar la migración
  };

  // Igual, pero para un grupo que se está moviendo a "empaques": toda
  // referencia a insumo_id (toppings/adiciones) pasa a empaque_id + queda
  // insumo_id=NULL (nunca puede seguir siendo un insumo_id: el id ya no
  // existe en "insumos"). fichas_tecnicas.vaso_id no tiene un equivalente
  // "vaso_empaque_id" todavía (ver producto_empaque, el mecanismo nuevo
  // para eso) — si alguna ficha llegara a apuntar a uno de estos ids
  // (ninguna lo hace hoy), su FK ON DELETE SET NULL simplemente la deja en
  // NULL al borrar la fila de insumos más abajo.
  const repuntarReferenciasAEmpaque = async (idsInsumoViejos, idEmpaqueNuevo) => {
    if (!idsInsumoViejos.length) return;
    await pool.query(
      `UPDATE toppings SET empaque_id=$1, insumo_id=NULL WHERE insumo_id = ANY($2::int[])`,
      [idEmpaqueNuevo, idsInsumoViejos]
    );
    await pool.query(
      `UPDATE adiciones SET empaque_id=$1, insumo_id=NULL WHERE insumo_id = ANY($2::int[])`,
      [idEmpaqueNuevo, idsInsumoViejos]
    );
  };

  const pendientesManual = [];

  for (const [, filas] of grupos) {
    if (filas.length === 0) continue;
    const esEmpaque = idCategoriaEmpaques != null && filas.some(f => f.categoria_id === idCategoriaEmpaques);
    const conLocal = filas.filter(f => f.local_id != null).sort((a, b) => a.id - b.id);
    const huerfanas = filas.filter(f => f.local_id == null);

    // Nada que consolidar: una sola fila, ya sin duplicados. Si tiene
    // local_id, igual necesita su fila en insumo_local (y perder su propio
    // stock/local_id, para que el DROP COLUMN de más abajo eventualmente
    // pueda correr) — si no tiene local_id, es un insumo de antes del
    // multi-local que nunca se llegó a asignar a ningún local: queda tal
    // cual, como catálogo puro, hasta que alguien lo asigne a mano (mismo
    // criterio que ya existía para estos insumos de prueba).
    if (filas.length === 1 && !esEmpaque) {
      const unica = filas[0];
      if (unica.local_id != null) {
        await pool.query(
          `INSERT INTO insumo_local(insumo_id, local_id, stock, stock_minimo, activo)
             VALUES($1,$2,$3,$4,$5)
             ON CONFLICT (insumo_id, local_id) DO UPDATE SET
               stock = insumo_local.stock + EXCLUDED.stock,
               stock_minimo = GREATEST(insumo_local.stock_minimo, EXCLUDED.stock_minimo)`,
          [unica.id, unica.local_id, unica.stock || 0, unica.stock_minimo || 0, unica.estado === 'Activo']
        );
        await pool.query(`UPDATE insumos SET local_id=NULL, stock=0, stock_minimo=0 WHERE id=$1`, [unica.id]);
      }
      continue;
    }

    const unidadesConLocal = new Set(conLocal.map(f => f.unidad));
    if (conLocal.length > 1 && unidadesConLocal.size > 1) {
      pendientesManual.push({ nombre: filas[0].nombre, motivo: 'sus filas por local no comparten la misma unidad', filas });
      continue;
    }
    const unidadComun = conLocal[0]?.unidad ?? huerfanas[0]?.unidad ?? null;

    // Canónica: la de menor id CON local_id; si no hay ninguna (insumo
    // huérfano suelto, nunca duplicado por local), la de menor id a secas.
    const canonica = conLocal[0] || [...filas].sort((a, b) => a.id - b.id)[0];
    const tablaLocalDestino = esEmpaque ? 'empaque_local' : 'insumo_local';
    const colIdDestino = esEmpaque ? 'empaque_id' : 'insumo_id';

    // Si es empaque, la fila canónica se re-crea en "empaques" (tabla
    // nueva); si es insumo normal, la canónica YA es una fila de "insumos"
    // y se queda donde está (solo se le quita su stock/local, más abajo).
    let idCanonicaDestino = canonica.id;
    if (esEmpaque) {
      const { rows: creada } = await pool.query(
        `INSERT INTO empaques(nombre, unidad, estado)
           VALUES($1,$2,$3)
           ON CONFLICT (nombre) DO UPDATE SET nombre = EXCLUDED.nombre
           RETURNING id`,
        [canonica.nombre.trim(), canonica.unidad || 'unidad', canonica.estado || 'Activo']
      );
      idCanonicaDestino = creada[0].id;
    }

    // 1) Cada fila CON local_id (incluida la canónica, si tiene uno) se
    //    vuelve una fila de insumo_local/empaque_local.
    for (const f of conLocal) {
      await pool.query(
        `INSERT INTO ${tablaLocalDestino}(${colIdDestino}, local_id, stock, stock_minimo, activo)
           VALUES($1,$2,$3,$4,$5)
           ON CONFLICT (${colIdDestino}, local_id) DO UPDATE SET
             stock = ${tablaLocalDestino}.stock + EXCLUDED.stock,
             stock_minimo = GREATEST(${tablaLocalDestino}.stock_minimo, EXCLUDED.stock_minimo)`,
        [idCanonicaDestino, f.local_id, f.stock || 0, f.stock_minimo || 0, f.estado === 'Activo']
      );
    }
    // La propia canónica (si es un insumo normal y tenía local_id: ya quedó
    // capturada en insumo_local arriba, como cualquier otra fila de
    // conLocal) pierde su stock/local_id propios — de lo contrario seguiría
    // pareciendo "pendiente de consolidar" para siempre y el DROP COLUMN de
    // más abajo nunca podría correr.
    if (!esEmpaque && canonica.local_id != null) {
      await pool.query(`UPDATE insumos SET local_id=NULL, stock=0, stock_minimo=0 WHERE id=$1`, [canonica.id]);
    }

    // 2) Huérfanas (sin local_id, stock de antes del multi-local): se
    //    suman al local de MENOR id del grupo si la unidad es convertible;
    //    si no hay ningún local al que sumarlas, o la unidad no es
    //    convertible, quedan SIN tocar (no se borran) para revisión manual.
    const localDestinoHuerfanas = conLocal[0]?.local_id ?? null;
    for (const h of huerfanas) {
      if (h.id === canonica.id) continue; // la propia huérfana es la canónica: no hay "otra fila" a la que sumarle nada
      if (!Number(h.stock)) {
        // Sin stock real que perder: se puede descartar sin más.
        if (esEmpaque) await repuntarReferenciasAEmpaque([h.id], idCanonicaDestino);
        else await repuntarReferenciasInsumo([h.id], canonica.id);
        await pool.query(`DELETE FROM insumos WHERE id=$1`, [h.id]);
        continue;
      }
      if (localDestinoHuerfanas == null) {
        pendientesManual.push({ nombre: h.nombre, motivo: `tiene stock (${h.stock} ${h.unidad}) pero ningún local asociado en el grupo para asignárselo`, filas: [h] });
        continue;
      }
      const convertido = convertirUnidad(h.stock, h.unidad, unidadComun);
      if (convertido === null) {
        pendientesManual.push({ nombre: h.nombre, motivo: `tiene stock (${h.stock} ${h.unidad}) en una unidad no convertible a la del resto del grupo (${unidadComun})`, filas: [h] });
        continue;
      }
      await pool.query(
        `UPDATE ${tablaLocalDestino} SET stock = stock + $1 WHERE ${colIdDestino}=$2 AND local_id=$3`,
        [convertido, idCanonicaDestino, localDestinoHuerfanas]
      );
      if (esEmpaque) await repuntarReferenciasAEmpaque([h.id], idCanonicaDestino);
      else await repuntarReferenciasInsumo([h.id], canonica.id);
      await pool.query(`DELETE FROM insumos WHERE id=$1`, [h.id]);
    }

    // 3) Borra de "insumos" los duplicados CON local_id que no sean la
    //    canónica (su stock ya quedó a salvo en el paso 1).
    const idsABorrar = conLocal.filter(f => f.id !== canonica.id).map(f => f.id);
    if (idsABorrar.length) {
      if (esEmpaque) await repuntarReferenciasAEmpaque(idsABorrar, idCanonicaDestino);
      else await repuntarReferenciasInsumo(idsABorrar, canonica.id);
      await pool.query(`DELETE FROM insumos WHERE id = ANY($1::int[])`, [idsABorrar]);
    }

    // 4) Si es empaque, la propia canónica también se borra de "insumos"
    //    (ya vive en "empaques" con el id nuevo idCanonicaDestino) — incluida
    //    cualquier referencia que todavía apunte a ella.
    if (esEmpaque) {
      await repuntarReferenciasAEmpaque([canonica.id], idCanonicaDestino);
      await pool.query(`DELETE FROM insumos WHERE id=$1`, [canonica.id]);
    }
  }

  if (pendientesManual.length) {
    console.error(
      '⚠️  migrarInsumoLocalYEmpaques dejó', pendientesManual.length, 'insumo(s) SIN consolidar (necesitan revisión manual — corrígelos en la tabla "insumos" y el servidor los reintentará en el próximo arranque):'
    );
    for (const p of pendientesManual) console.error(`   • "${p.nombre}": ${p.motivo}`);
  }
};

// ── ASIGNACIÓN DE LOCAL PARA INSUMOS SIN LOCAL (requisito 3) ────────────────
// Después de migrarInsumoLocalYEmpaques() pueden quedar insumos sin NINGUNA
// fila en insumo_local: los que nunca se duplicaron por local y nunca
// tuvieron un local propio asignado (insumos.local_id NULL) — insumos de
// antes de que el local fuera obligatorio al crear uno (o de la ventana en
// que estuvo temporalmente opcional). El pedido de esta ronda es explícito:
// "los 38 insumos actuales hay que migrarlos: define e implementa a qué
// local quedan asignados" — la política que se define e implementa acá es:
//   • Si el insumo YA tenía un local propio (insumos.local_id), se respeta.
//   • Si no tenía ninguno, se asigna al LOCAL POR DEFECTO: "Local Villa
//     Liliam" (el primero de la semilla original) — o, si ese nombre ya no
//     existe, el local activo de menor id. Es una asignación arbitraria
//     pero explícita y documentada: el stock/mínimo que traía el insumo se
//     conserva intacto (no se pierde ni se inventa), y desde ahí se puede
//     mover a otro local con el CRUD de insumo_local (POST/PUT/DELETE
//     /insumos/:id/locales) cuando alguien confirme dónde debería estar.
// Idempotente: solo procesa insumos que TODAVÍA no tengan ninguna fila en
// insumo_local.
const asegurarInsumoLocalParaTodos = async () => {
  const { rows: colInfo } = await pool.query(
    `SELECT 1 FROM information_schema.columns WHERE table_name='insumos' AND column_name='stock'`
  );
  if (!colInfo.length) return; // insumos.stock ya no existe: no hay nada legacy que leer

  const { rows: huerfanos } = await pool.query(
    `SELECT id, stock, stock_minimo, local_id FROM insumos WHERE id NOT IN (SELECT insumo_id FROM insumo_local)`
  );
  if (!huerfanos.length) return;

  const { rows: def } = await pool.query(
    `SELECT id FROM locales WHERE estado='Activo' ORDER BY (nombre <> 'Local Villa Liliam'), id LIMIT 1`
  );
  const localPorDefecto = def[0]?.id ?? null;
  if (!localPorDefecto) {
    console.error('⚠️  asegurarInsumoLocalParaTodos: no hay ningún local activo — no se puede asignar ninguno de', huerfanos.length, 'insumo(s) sin local.');
    return;
  }

  for (const h of huerfanos) {
    const localId = h.local_id ?? localPorDefecto;
    await pool.query(
      `INSERT INTO insumo_local(insumo_id, local_id, stock, stock_minimo, activo)
         VALUES($1,$2,$3,$4,true) ON CONFLICT (insumo_id, local_id) DO NOTHING`,
      [h.id, localId, h.stock || 0, h.stock_minimo || 0]
    );
    // Se limpia la copia vieja en "insumos" (ya vive en insumo_local) —
    // necesario para que el DROP COLUMN de más abajo eventualmente pueda
    // correr (revisa que NINGÚN insumo retenga local_id/stock propios).
    await pool.query(`UPDATE insumos SET local_id=NULL, stock=0, stock_minimo=0 WHERE id=$1`, [h.id]);
  }
  console.log(
    `🔧 asegurarInsumoLocalParaTodos: ${huerfanos.length} insumo(s) sin local asignado quedaron en el local por defecto (id ${localPorDefecto}), con su stock/mínimo anterior conservado.`
  );
};

// Completa, para TODO insumo y TODO local activo, la fila de insumo_local
// que falte (stock_actual=0) — ver comentario en el punto donde se llama,
// dentro de migrar(). A diferencia de asegurarInsumoLocalParaTodos (que
// resuelve insumos sin NINGÚN local), esta función llena huecos puntuales:
// un insumo puede ya tener fila en el Local A pero no en el Local B (por
// ejemplo, porque el Local B se creó después, antes de que POST /locales
// propagara automáticamente a los insumos existentes).
const asegurarInsumoLocalEnTodosLosLocales = async () => {
  // TODO local (activo o inactivo) — no solo los activos: un local
  // desactivado conserva su stock/historial en SOLO LECTURA (no deja de
  // "existir" como registro), así que también debe tener su fila de
  // insumo_local para cada insumo, aunque nadie vaya a comprarle ni
  // vendarle mientras siga inactivo.
  const { rows: faltantes } = await pool.query(`
    SELECT i.id AS insumo_id, l.id AS local_id,
           COALESCE((SELECT MAX(il.stock_minimo) FROM insumo_local il WHERE il.insumo_id = i.id), 0) AS minimo_defecto
      FROM insumos i CROSS JOIN (SELECT id FROM locales) l
     WHERE NOT EXISTS (SELECT 1 FROM insumo_local il WHERE il.insumo_id = i.id AND il.local_id = l.id)
  `);
  if (!faltantes.length) return;
  for (const f of faltantes) {
    await pool.query(
      `INSERT INTO insumo_local(insumo_id, local_id, stock, stock_minimo, activo) VALUES($1,$2,0,$3,true)
         ON CONFLICT (insumo_id, local_id) DO NOTHING`,
      [f.insumo_id, f.local_id, f.minimo_defecto]
    );
  }
  console.log(`🔧 asegurarInsumoLocalEnTodosLosLocales: se completaron ${faltantes.length} fila(s) de insumo_local que faltaban (stock_actual=0).`);
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
  // Inventario por local / empaques (esta ronda).
  'insumo_local', 'empaques', 'empaque_local', 'producto_empaque',
  'movimientos_inventario',
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