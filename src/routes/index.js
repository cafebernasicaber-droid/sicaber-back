const express = require('express');
const crypto  = require('crypto');
const pool    = require('../config/db');
const { auth, permitirRoles } = require('../middleware/auth');
const bcrypt  = require('bcryptjs');
const crud    = require('./crud');
const validateId = require('../middleware/validateId');
const { passwordValida, PASSWORD_ERROR } = require('../config/passwordPolicy');

const r = express.Router();

// ── ROLES ──────────────────────────────────────────────────
r.use('/roles', crud('roles', ['nombre', 'descripcion', 'permisos']));

// ── USUARIOS ───────────────────────────────────────────────
const usrRouter = require('express').Router();
usrRouter.param('id', validateId); // valida :id (numérico) antes de las rutas de abajo

usrRouter.get('/', auth, async (req, res) => {
  try {
  const { rows } = await pool.query('SELECT id,nombre,username,correo,rol,sede,estado,es_superadmin,created_at FROM usuarios ORDER BY id DESC');
  res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
usrRouter.get('/:id', auth, async (req, res) => {
  try {
  const { rows } = await pool.query('SELECT id,nombre,username,correo,rol,sede,estado,es_superadmin FROM usuarios WHERE id=$1', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'No encontrado' });
  res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
usrRouter.post('/', auth, async (req, res) => {
  const { nombre, username, correo, password, rol, sede } = req.body;
  if (!passwordValida(password)) return res.status(400).json({ error: PASSWORD_ERROR });
  try {
    const hash = await bcrypt.hash(password, 10);
    // El Administrador siempre queda con sede='Ambos' (ve y opera los dos
    // locales); Cajero/Bartender deben elegir 'Local 1' o 'Local 2' desde
    // el formulario. Si por algún motivo no llega sede, se cae a 'Local 1'
    // para no dejar la columna vacía (es NOT NULL).
    const sedeFinal = rol === 'Administrador' ? 'Ambos' : (sede || 'Local 1');
    // es_superadmin nunca se recibe del cliente: todo usuario nuevo se
    // crea con es_superadmin=false por el DEFAULT de la columna, así el
    // Superadministrador sigue siendo único y no se puede crear otro
    // desde este formulario.
    const { rows } = await pool.query(
      'INSERT INTO usuarios(nombre,username,correo,password,rol,sede) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,nombre,username,correo,rol,sede,es_superadmin',
      [nombre, username, correo || null, hash, rol, sedeFinal]
    );
    res.status(201).json(rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ error: 'Username ya existe' });
    res.status(500).json({ error: e.message });
  }
});
usrRouter.put('/:id', auth, async (req, res) => {
  const { nombre, username, correo, password, rol, sede } = req.body;
  try {
    const { rows: actual } = await pool.query('SELECT rol, es_superadmin FROM usuarios WHERE id=$1', [req.params.id]);
    if (!actual[0]) return res.status(404).json({ error: 'Usuario no encontrado' });

    // El rol del Superadministrador es inmodificable: sin importar lo que
    // llegue en el body, conservamos su rol actual. El resto de sus datos
    // (nombre, usuario, correo, contraseña) sí se pueden actualizar.
    const rolFinal = actual[0].es_superadmin ? actual[0].rol : rol;
    // Igual que en la creación: Administrador siempre queda en 'Ambos'.
    const sedeFinal = rolFinal === 'Administrador' ? 'Ambos' : (sede || 'Local 1');

    let q, vals;
    if (password) {
      if (!passwordValida(password)) return res.status(400).json({ error: PASSWORD_ERROR });
      const hash = await bcrypt.hash(password, 10);
      q = 'UPDATE usuarios SET nombre=$1,username=$2,correo=$3,password=$4,rol=$5,sede=$6 WHERE id=$7 RETURNING id,nombre,username,correo,rol,sede,es_superadmin';
      vals = [nombre, username, correo || null, hash, rolFinal, sedeFinal, req.params.id];
    } else {
      q = 'UPDATE usuarios SET nombre=$1,username=$2,correo=$3,rol=$4,sede=$5 WHERE id=$6 RETURNING id,nombre,username,correo,rol,sede,es_superadmin';
      vals = [nombre, username, correo || null, rolFinal, sedeFinal, req.params.id];
    }
    const { rows } = await pool.query(q, vals);
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
usrRouter.patch('/:id/estado', auth, async (req, res) => {
  try {
  const { rows: actual } = await pool.query('SELECT es_superadmin FROM usuarios WHERE id=$1', [req.params.id]);
  if (!actual[0]) return res.status(404).json({ error: 'Usuario no encontrado' });
  if (actual[0].es_superadmin) {
    return res.status(403).json({ error: 'El estado del Superadministrador no se puede modificar.' });
  }
  const { rows } = await pool.query(
    `UPDATE usuarios SET estado=CASE WHEN estado='Activo' THEN 'Inactivo' ELSE 'Activo' END WHERE id=$1 RETURNING *`,
    [req.params.id]
  );
  res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
usrRouter.delete('/:id', auth, async (req, res) => {
  try {
  const { rows: actual } = await pool.query('SELECT es_superadmin FROM usuarios WHERE id=$1', [req.params.id]);
  if (!actual[0]) return res.status(404).json({ error: 'Usuario no encontrado' });
  if (actual[0].es_superadmin) {
    return res.status(403).json({ error: 'El Superadministrador no se puede eliminar.' });
  }
  await pool.query('DELETE FROM usuarios WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
r.use('/usuarios', usrRouter);

// ── CLIENTES ───────────────────────────────────────────────
const cliRouter = require('express').Router();
cliRouter.param('id', validateId); // valida :id (numérico) antes de las rutas de abajo

// Columnas públicas de un cliente — ver config/clienteCols.js: es la misma
// constante que usa routes/auth.js (login/sesión de cliente, incluida la
// app móvil) para que ambos lados reciban siempre el mismo perfil.
const { CLIENTE_COLS } = require('../config/clienteCols');

cliRouter.get('/', auth, async (req, res) => {
  try {
  const { rows } = await pool.query(`SELECT ${CLIENTE_COLS} FROM clientes ORDER BY id DESC`);
  res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// GET /clientes/me (+ /mi-perfil, alias histórico que ya usaba la web —
// se deja funcionando para no romperla): el perfil del cliente autenticado,
// tomado del id del token — nunca de un :id recibido por parámetro.
// Devuelve exactamente las mismas columnas/alias (CLIENTE_COLS) que acepta
// el PUT de abajo, más las de solo lectura (id, correo, estado,
// fechaRegistro) que el cliente puede ver pero no editar desde aquí.
const obtenerMiPerfil = async (req, res) => {
  try {
  const { rows } = await pool.query(`SELECT ${CLIENTE_COLS} FROM clientes WHERE id=$1`, [req.user.id]);
  res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
};
cliRouter.get('/me', auth, obtenerMiPerfil);
cliRouter.get('/mi-perfil', auth, obtenerMiPerfil);
cliRouter.get('/:id', auth, async (req, res) => {
  try {
  const { rows } = await pool.query(`SELECT ${CLIENTE_COLS} FROM clientes WHERE id=$1`, [req.params.id]);
  res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// PUT /clientes/me (+ /mi-perfil): el cliente edita su propio perfil
// ("Editar mis datos" en la landing) — usa req.user.id (del token), nunca
// un :id recibido por parámetro, para que un cliente no pueda editar el
// perfil de otro. Acepta exactamente los mismos campos editables que
// expone el PUT de admin (/:id) de abajo, con la misma validación de
// tipoDoc==='Otros'. `correo` y `password` nunca se leen de req.body ni se
// incluyen en el UPDATE a propósito — cambiar el correo o la contraseña
// tiene su propio flujo (POST /auth/cliente/reset-password para la
// contraseña; el correo no tiene endpoint de cambio todavía).
const actualizarMiPerfil = async (req, res) => {
  try {
  const { nombre, telefono, direccion, comuna, tipoDoc, numeroDoc, departamento, municipio } = req.body;
  if (!nombre || !nombre.trim()) return res.status(400).json({ error: 'El nombre es obligatorio.' });
  if (tipoDoc === 'Otros') return res.status(400).json({ error: 'Debes especificar el tipo de documento.' });
  const { rows } = await pool.query(
    `UPDATE clientes SET nombre=$1, telefono=$2, direccion=$3, comuna=$4,
       tipo_doc=$5, numero_doc=$6, departamento=$7, municipio=$8
     WHERE id=$9 RETURNING ${CLIENTE_COLS}`,
    [
      nombre, telefono || null, direccion || null, comuna || null,
      tipoDoc || null, numeroDoc || null, departamento || null, municipio || null,
      req.user.id,
    ]
  );
  res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
};
cliRouter.put('/me', auth, actualizarMiPerfil);
cliRouter.put('/mi-perfil', auth, actualizarMiPerfil);
// Edición de un cliente desde el panel admin. Igual que arriba, `correo`
// nunca se toca aquí a propósito.
cliRouter.put('/:id', auth, async (req, res) => {
  try {
  const { nombre, telefono, tipoDoc, numeroDoc, departamento, municipio, direccion } = req.body;
  if (!nombre || !nombre.trim()) return res.status(400).json({ error: 'El nombre es obligatorio.' });
  if (tipoDoc === 'Otros') return res.status(400).json({ error: 'Debes especificar el tipo de documento.' });
  const { rows } = await pool.query(
    `UPDATE clientes SET nombre=$1, telefono=$2, tipo_doc=$3, numero_doc=$4,
       departamento=$5, municipio=$6, direccion=$7
     WHERE id=$8 RETURNING ${CLIENTE_COLS}`,
    [nombre, telefono || null, tipoDoc || null, numeroDoc || null, departamento || null, municipio || null, direccion || null, req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Cliente no encontrado' });
  res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
cliRouter.patch('/:id/estado', auth, async (req, res) => {
  try {
  const { rows } = await pool.query(`UPDATE clientes SET estado=CASE WHEN estado='Activo' THEN 'Inactivo' ELSE 'Activo' END WHERE id=$1 RETURNING *`, [req.params.id]);
  res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
cliRouter.delete('/:id', auth, async (req, res) => {
  try {
  await pool.query('DELETE FROM clientes WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
r.use('/clientes', cliRouter);

// ── EMPLEADOS ──────────────────────────────────────────────
// Antes esto era un CRUD genérico (crud('empleados', [...])) que solo
// guardaba nombre/cargo/telefono/correo/estado. El formulario de "Nuevo
// empleado" siempre pidió usuario/contraseña cuando el cargo era Cajero o
// Bartender (y ahora también el local), pero esos datos se descartaban en
// silencio: el empleado quedaba registrado pero jamás podía iniciar
// sesión. Este router propio, además de guardar el empleado, crea/
// actualiza su cuenta real en "usuarios" (con la que sí se puede hacer
// login) cuando el cargo es Cajero o Bartender.
const empRouter = require('express').Router();
empRouter.param('id', validateId); // valida :id (numérico) antes de las rutas de abajo
const CARGOS_CON_LOGIN = ['Cajero', 'Bartender'];

empRouter.get('/', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM empleados ORDER BY id DESC');
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
empRouter.get('/:id', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM empleados WHERE id=$1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'No encontrado' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
empRouter.post('/', auth, async (req, res) => {
  const { nombre, cargo, telefono, correo, estado, username, password, sede } = req.body;
  const necesitaLogin = CARGOS_CON_LOGIN.includes(cargo);
  // El local solo tiene sentido para Cajero/Bartender (son quienes operan
  // pedidos de un local específico); para el resto se guarda 'Local 1'
  // por el DEFAULT de la columna, sin que el formulario lo pida.
  const sedeFinal = necesitaLogin ? (sede || 'Local 1') : 'Local 1';
  try {
    let usuarioId = null;
    if (necesitaLogin) {
      if (!username || !password) {
        return res.status(400).json({ error: 'Usuario y contraseña son obligatorios para el cargo ' + cargo + '.' });
      }
      if (!passwordValida(password)) return res.status(400).json({ error: PASSWORD_ERROR });
      const hash = await bcrypt.hash(password, 10);
      const { rows: nuevoUsuario } = await pool.query(
        'INSERT INTO usuarios(nombre,username,correo,password,rol,sede) VALUES($1,$2,$3,$4,$5,$6) RETURNING id',
        [nombre, username, correo || null, hash, cargo, sedeFinal]
      );
      usuarioId = nuevoUsuario[0].id;
    }
    const { rows } = await pool.query(
      `INSERT INTO empleados(nombre,cargo,telefono,correo,estado,sede,usuario_id)
       VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [nombre, cargo || null, telefono || null, correo || null, estado || 'Activo', sedeFinal, usuarioId]
    );
    res.status(201).json(rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ error: 'Ese nombre de usuario ya está en uso.' });
    res.status(500).json({ error: e.message });
  }
});
empRouter.put('/:id', auth, async (req, res) => {
  const { nombre, cargo, telefono, correo, estado, username, password, sede } = req.body;
  const necesitaLogin = CARGOS_CON_LOGIN.includes(cargo);
  const sedeFinal = necesitaLogin ? (sede || 'Local 1') : 'Local 1';
  try {
    const { rows: actual } = await pool.query('SELECT usuario_id FROM empleados WHERE id=$1', [req.params.id]);
    if (!actual[0]) return res.status(404).json({ error: 'Empleado no encontrado' });
    let usuarioId = actual[0].usuario_id;

    if (necesitaLogin) {
      if (usuarioId) {
        // Ya tenía cuenta: se actualiza (y la contraseña solo si mandaron una nueva).
        if (password) {
          if (!passwordValida(password)) return res.status(400).json({ error: PASSWORD_ERROR });
          const hash = await bcrypt.hash(password, 10);
          await pool.query(
            'UPDATE usuarios SET nombre=$1,username=COALESCE($2,username),correo=$3,password=$4,rol=$5,sede=$6 WHERE id=$7',
            [nombre, username || null, correo || null, hash, cargo, sedeFinal, usuarioId]
          );
        } else {
          await pool.query(
            'UPDATE usuarios SET nombre=$1,username=COALESCE($2,username),correo=$3,rol=$4,sede=$5 WHERE id=$6',
            [nombre, username || null, correo || null, cargo, sedeFinal, usuarioId]
          );
        }
      } else if (username && password) {
        // Antes no tenía cuenta (ej. cambió de "Barista" a "Cajero"): se crea ahora.
        if (!passwordValida(password)) return res.status(400).json({ error: PASSWORD_ERROR });
        const hash = await bcrypt.hash(password, 10);
        const { rows: nuevoUsuario } = await pool.query(
          'INSERT INTO usuarios(nombre,username,correo,password,rol,sede) VALUES($1,$2,$3,$4,$5,$6) RETURNING id',
          [nombre, username, correo || null, hash, cargo, sedeFinal]
        );
        usuarioId = nuevoUsuario[0].id;
      } else {
        return res.status(400).json({ error: 'Usuario y contraseña son obligatorios para el cargo ' + cargo + '.' });
      }
    }

    const { rows } = await pool.query(
      `UPDATE empleados SET nombre=$1,cargo=$2,telefono=$3,correo=$4,estado=$5,sede=$6,usuario_id=$7
       WHERE id=$8 RETURNING *`,
      [nombre, cargo || null, telefono || null, correo || null, estado || 'Activo', sedeFinal, usuarioId, req.params.id]
    );
    res.json(rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ error: 'Ese nombre de usuario ya está en uso.' });
    res.status(500).json({ error: e.message });
  }
});
empRouter.patch('/:id/estado', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `UPDATE empleados SET estado = CASE WHEN estado='Activo' THEN 'Inactivo' ELSE 'Activo' END WHERE id=$1 RETURNING *`,
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'No encontrado' });
    // Si el empleado tiene cuenta de acceso, se bloquea/desbloquea junto
    // con él: un empleado "detenido" no debería poder seguir iniciando sesión.
    if (rows[0].usuario_id) {
      await pool.query('UPDATE usuarios SET estado=$1 WHERE id=$2', [rows[0].estado, rows[0].usuario_id]);
    }
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
empRouter.delete('/:id', auth, async (req, res) => {
  try {
    const { rows: actual } = await pool.query('SELECT usuario_id FROM empleados WHERE id=$1', [req.params.id]);
    await pool.query('DELETE FROM empleados WHERE id=$1', [req.params.id]);
    // Al eliminar el empleado, se elimina también su cuenta de acceso (si
    // tenía una) para que no quede un usuario "huérfano" que aún pueda
    // iniciar sesión.
    if (actual[0]?.usuario_id) {
      await pool.query('DELETE FROM usuarios WHERE id=$1 AND es_superadmin=false', [actual[0].usuario_id]);
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
r.use('/empleados', empRouter);

// ── CATEGORÍAS ─────────────────────────────────────────────
r.use('/categorias', crud('categorias', ['nombre', 'descripcion', 'estado']));

// ── PRODUCTOS ──────────────────────────────────────────────
// El carrito del Landing (Landing.jsx) arma ids sintéticos tipo "combo-5"
// para poder guardar productos y combos en el mismo arreglo sin que un
// combo choque con el id numérico de un producto real, y luego usa ESE id
// para volver a consultar el backend (ej. al recalcular el precio original
// de un ítem ya en el carrito). Antes, ese string llegaba crudo hasta
// `WHERE id=$1` sobre una columna integer y Postgres respondía con
// "la sintaxis de entrada no es válida para tipo integer: «combo-5»",
// disfrazado de 500 genérico.
//
// parseIdentificadorProducto separa el tipo ('producto' | 'combo') del id
// numérico real ANTES de tocar cualquier tabla, y devuelve null para
// cualquier cosa que no sea ninguno de los dos formatos (vacío, texto
// suelto, etc.) — eso se traduce en un 400 claro en vez de un error interno.
const RE_COMBO_ID = /^combo-(\d+)$/;
const parseIdentificadorProducto = (raw) => {
  const value = String(raw ?? '').trim();
  if (!value) return null;
  const comboMatch = value.match(RE_COMBO_ID);
  if (comboMatch) return { tipo: 'combo', id: Number(comboMatch[1]) };
  if (/^\d+$/.test(value)) return { tipo: 'producto', id: Number(value) };
  return null;
};

// Carga un combo completo por su id numérico real. La tabla "combos" ya
// guarda todo lo necesario en una sola fila: precio, imagen, descripción y
// "items" (cada producto del combo con su propia cantidad, toppings y
// adiciones — ver CombosPage.jsx en el frontend, que arma ese JSON al
// crear/editar un combo), así que no hace falta ningún JOIN adicional.
// La reutilizan tanto GET /productos/:id (cuando el id es un combo) como
// GET /combos/:id, para no duplicar la misma consulta en dos lugares.
const obtenerComboPorId = async (idNumerico) => {
  const { rows } = await pool.query('SELECT * FROM combos WHERE id=$1', [idNumerico]);
  if (!rows[0]) return null;
  return { tipo: 'combo', ...rows[0] };
};

const prodRouter = require('express').Router();
prodRouter.get('/', async (req, res) => {
  try {
  const { rows } = await pool.query(`SELECT * FROM productos WHERE estado='Activo' ORDER BY id`);
  res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
prodRouter.get('/todos', auth, async (req, res) => {
  try {
  const { rows } = await pool.query('SELECT * FROM productos ORDER BY id DESC');
  res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Esta ruta, a propósito, NO usa router.param('id', validateId): tiene que
// aceptar tanto el id numérico de un producto real ("5") como el id
// sintético de un combo ("combo-5") que ya manda el carrito del Landing —
// ver parseIdentificadorProducto arriba. Cualquier otro formato responde
// 400 antes de tocar la base de datos.
prodRouter.get('/:id', async (req, res) => {
  const identificador = parseIdentificadorProducto(req.params.id);
  if (!identificador) return res.status(400).json({ error: `ID inválido: "${req.params.id}"` });
  try {
    if (identificador.tipo === 'combo') {
      const combo = await obtenerComboPorId(identificador.id);
      if (!combo) return res.status(404).json({ error: 'Combo no encontrado' });
      return res.json(combo);
    }
    const { rows } = await pool.query('SELECT * FROM productos WHERE id=$1', [identificador.id]);
    if (!rows[0]) return res.status(404).json({ error: 'No encontrado' });
    res.json({ tipo: 'producto', ...rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
prodRouter.post('/', auth, async (req, res) => {
  const { nombre, categoria, precio, descuento, fecha_inicio_desc, fecha_fin_desc, descripcion, imagen, estado } = req.body;
  try {
    const { rows } = await pool.query(
      `INSERT INTO productos(nombre,categoria,precio,descuento,fecha_inicio_desc,fecha_fin_desc,descripcion,imagen,estado)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [nombre, categoria, precio, descuento || 0, fecha_inicio_desc || null, fecha_fin_desc || null, descripcion, imagen, estado || 'Activo']
    );
    res.status(201).json(rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ error: 'Producto ya existe' });
    res.status(500).json({ error: e.message });
  }
});
// PUT/DELETE sí validan el :id de forma estricta (siempre debe ser un
// producto real — a diferencia del GET de arriba, aquí nunca tiene sentido
// recibir un id de combo). No se registra vía router.param porque eso
// afectaría también al GET compartido de arriba.
prodRouter.put('/:id', auth, async (req, res) => {
  if (!/^\d+$/.test(String(req.params.id))) return res.status(400).json({ error: `ID inválido: "${req.params.id}"` });
  try {
  const { nombre, categoria, precio, descuento, fecha_inicio_desc, fecha_fin_desc, descripcion, imagen, estado } = req.body;
  const { rows } = await pool.query(
    `UPDATE productos SET nombre=$1,categoria=$2,precio=$3,descuento=$4,fecha_inicio_desc=$5,fecha_fin_desc=$6,descripcion=$7,imagen=$8,estado=$9 WHERE id=$10 RETURNING *`,
    [nombre, categoria, precio, descuento || 0, fecha_inicio_desc || null, fecha_fin_desc || null, descripcion, imagen, estado, req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'No encontrado' });
  res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
prodRouter.delete('/:id', auth, async (req, res) => {
  if (!/^\d+$/.test(String(req.params.id))) return res.status(400).json({ error: `ID inválido: "${req.params.id}"` });
  try {
  await pool.query('DELETE FROM productos WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
r.use('/productos', prodRouter);

// ── TOPPINGS ───────────────────────────────────────────────
// Los toppings nunca tienen costo (sin campo precio). productos_ids
// = [] significa que el topping aplica a todos los productos.
// insumo_id/cantidad: de qué insumo y cuánto descuenta del stock vender
// este topping (mismo mecanismo que los ingredientes de la ficha
// técnica — ver descontarInventarioPorVenta más abajo).
r.use('/toppings',  crud('toppings',  ['nombre', 'productos_ids', 'estado', 'insumo_id', 'cantidad']));

// ── ADICIONES ──────────────────────────────────────────────
// Las adiciones siguen siendo universales (aplican igual a todos los
// productos, sin producto_id — a diferencia de toppings.productos_ids).
// insumo_id/cantidad: de qué insumo y cuánto descuenta del stock vender
// esta adición (mismo mecanismo que toppings.insumo_id/cantidad, pero sin
// override por producto — ver calcularRecetaEfectiva más abajo).
r.use('/adiciones', crud('adiciones', ['nombre', 'precio', 'estado', 'insumo_id', 'cantidad']));

// ── COMBOS ─────────────────────────────────────────────────
const comboRouter = require('express').Router();
comboRouter.param('id', validateId); // valida :id (numérico) antes de las rutas de abajo
comboRouter.get('/', async (req, res) => {
  try {
  const { rows } = await pool.query(`SELECT * FROM combos WHERE estado='Activo' ORDER BY id`);
  res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
comboRouter.get('/todos', auth, async (req, res) => {
  try {
  const { rows } = await pool.query('SELECT * FROM combos ORDER BY id DESC');
  res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// No existía un GET por id individual (el Landing siempre cargó todos los
// combos activos de una vez con GET /combos, que ya trae todo lo
// necesario). Se agrega para tener un endpoint simétrico a
// GET /productos/:id y reutilizable por cualquier otro cliente — reutiliza
// obtenerComboPorId, la misma función que usa /productos/combo-:id.
comboRouter.get('/:id', async (req, res) => {
  try {
    const combo = await obtenerComboPorId(req.params.id);
    if (!combo) return res.status(404).json({ error: 'Combo no encontrado' });
    res.json(combo);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
comboRouter.post('/', auth, async (req, res) => {
  try {
  const { nombre, descripcion, precio, imagen, items } = req.body;
  const { rows } = await pool.query(
    `INSERT INTO combos(nombre,descripcion,precio,imagen,items) VALUES($1,$2,$3,$4,$5) RETURNING *`,
    [nombre, descripcion, precio, imagen, JSON.stringify(items || [])]
  );
  res.status(201).json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
comboRouter.put('/:id', auth, async (req, res) => {
  try {
  const { nombre, descripcion, precio, imagen, items } = req.body;
  const { rows } = await pool.query(
    `UPDATE combos SET nombre=$1,descripcion=$2,precio=$3,imagen=$4,items=$5 WHERE id=$6 RETURNING *`,
    [nombre, descripcion, precio, imagen, JSON.stringify(items || []), req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Combo no encontrado' });
  res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
comboRouter.patch('/:id/estado', auth, async (req, res) => {
  try {
  const { rows } = await pool.query(`UPDATE combos SET estado=CASE WHEN estado='Activo' THEN 'Inactivo' ELSE 'Activo' END WHERE id=$1 RETURNING *`, [req.params.id]);
  res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
comboRouter.delete('/:id', auth, async (req, res) => {
  try {
  await pool.query('DELETE FROM combos WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
r.use('/combos', comboRouter);

// ── PROVEEDORES ────────────────────────────────────────────
// Antes esto era un CRUD genérico (crud('proveedores', [...])), que no
// podía: identificar CUÁL campo (nit/correo/teléfono) venía duplicado — solo
// devolvía un mensaje genérico de "Ya existe un registro" —, ni impedir
// eliminar un proveedor con compras registradas, ni eliminar en cascada los
// insumos asociados al eliminar uno sin compras. El frontend
// (ProveedorForm.jsx, ProveedoresPage.jsx) ya esperaba ambos contratos
// (duplicateFields, { ok, insumosEliminados, nombresInsumos }) — solo
// faltaba implementarlos aquí.
const PROVEEDOR_FIELDS = ['nombre', 'nit', 'telefono', 'correo', 'direccion', 'ciudad', 'observaciones', 'estado'];

// Revisa nombre/nit/correo/teléfono uno por uno para poder señalar
// exactamente cuál está duplicado (excluyendo el propio registro al editar).
const buscarDuplicadosProveedor = async ({ nombre, nit, telefono, correo }, excluirId) => {
  const dup = [];
  const checks = [['nombre', nombre], ['nit', nit], ['telefono', telefono], ['correo', correo]];
  for (const [campo, valor] of checks) {
    if (!valor) continue;
    const params = excluirId ? [valor, excluirId] : [valor];
    const cond = excluirId ? `lower(${campo})=lower($1) AND id<>$2` : `lower(${campo})=lower($1)`;
    const { rows } = await pool.query(`SELECT id FROM proveedores WHERE ${cond} LIMIT 1`, params);
    if (rows[0]) dup.push(campo);
  }
  return dup;
};

const provRouter = require('express').Router();
provRouter.get('/', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM proveedores ORDER BY id DESC`);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
provRouter.get('/:id', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM proveedores WHERE id=$1`, [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'No encontrado' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
provRouter.post('/', auth, async (req, res) => {
  try {
    const dup = await buscarDuplicadosProveedor(req.body, null);
    if (dup.length) {
      return res.status(400).json({ error: 'Ya existe un proveedor con ese ' + dup.join(', ') + '.', duplicateFields: dup });
    }
    const vals = PROVEEDOR_FIELDS.map(f => req.body[f] ?? null);
    const { rows } = await pool.query(
      `INSERT INTO proveedores(${PROVEEDOR_FIELDS.join(',')}) VALUES(${PROVEEDOR_FIELDS.map((_, i) => `$${i + 1}`).join(',')}) RETURNING *`,
      vals
    );
    res.status(201).json(rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ error: 'Ya existe un registro con ese dato.' });
    res.status(500).json({ error: e.message });
  }
});
provRouter.put('/:id', auth, async (req, res) => {
  try {
    const dup = await buscarDuplicadosProveedor(req.body, req.params.id);
    if (dup.length) {
      return res.status(400).json({ error: 'Ya existe un proveedor con ese ' + dup.join(', ') + '.', duplicateFields: dup });
    }
    const vals = [...PROVEEDOR_FIELDS.map(f => req.body[f] ?? null), req.params.id];
    const { rows } = await pool.query(
      `UPDATE proveedores SET ${PROVEEDOR_FIELDS.map((f, i) => `${f}=$${i + 1}`).join(',')} WHERE id=$${PROVEEDOR_FIELDS.length + 1} RETURNING *`,
      vals
    );
    if (!rows[0]) return res.status(404).json({ error: 'No encontrado' });
    res.json(rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ error: 'Ya existe un registro con ese dato.' });
    res.status(500).json({ error: e.message });
  }
});
provRouter.patch('/:id/estado', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `UPDATE proveedores SET estado = CASE WHEN estado='Activo' THEN 'Inactivo' ELSE 'Activo' END WHERE id=$1 RETURNING *`,
      [req.params.id]
    );
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// No se puede eliminar un proveedor con compras (activas o anuladas) — solo
// desactivarlo. Sin compras, se elimina junto con sus insumos asociados
// (nunca deben quedar insumos huérfanos apuntando a un proveedor borrado).
provRouter.delete('/:id', auth, async (req, res) => {
  try {
    const { rows: conCompras } = await pool.query(`SELECT id FROM compras WHERE proveedor_id=$1 LIMIT 1`, [req.params.id]);
    if (conCompras[0]) {
      return res.status(400).json({ error: 'No se puede eliminar: este proveedor tiene compras registradas (activas o anuladas). Solo puedes desactivarlo.' });
    }
    const { rows: insumosAsociados } = await pool.query(`SELECT id, nombre FROM insumos WHERE proveedor_id=$1`, [req.params.id]);
    if (insumosAsociados.length) {
      await pool.query(`DELETE FROM insumos WHERE proveedor_id=$1`, [req.params.id]);
    }
    await pool.query('DELETE FROM proveedores WHERE id=$1', [req.params.id]);
    res.json({ ok: true, insumosEliminados: insumosAsociados.length, nombresInsumos: insumosAsociados.map(i => i.nombre) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
r.use('/proveedores', provRouter);

// ── CATEGORÍAS DE INSUMOS ────────────────────────────────────
// El frontend (ModalCategoriasInsumo / ModalRecategorizar en InsumosPage.jsx)
// ya está construido esperando dos cosas de este módulo que el CRUD
// genérico nunca implementó: que DELETE devuelva 409 con
// { insumos, insumosAsociados } cuando la categoría tiene insumos (en vez
// de fallar con un error crudo de FK), y una ruta POST /:id/recategorizar
// para mover esos insumos a otra categoría (existente o nueva) antes de
// eliminar la categoría original — esa ruta no existía en absoluto, así
// que recategorizar siempre daba 404.
const catInsRouter = require('express').Router();
catInsRouter.param('id', validateId); // valida :id (numérico) antes de las rutas de abajo
catInsRouter.get('/', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM categorias_insumos ORDER BY id DESC`);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
catInsRouter.get('/:id', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM categorias_insumos WHERE id=$1`, [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'No encontrada' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
catInsRouter.post('/', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(`INSERT INTO categorias_insumos(nombre) VALUES($1) RETURNING *`, [req.body.nombre]);
    res.status(201).json(rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ error: 'Ya existe una categoría con ese nombre' });
    res.status(500).json({ error: e.message });
  }
});
catInsRouter.put('/:id', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(`UPDATE categorias_insumos SET nombre=$1 WHERE id=$2 RETURNING *`, [req.body.nombre, req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'No encontrada' });
    res.json(rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ error: 'Ya existe una categoría con ese nombre' });
    res.status(500).json({ error: e.message });
  }
});
catInsRouter.patch('/:id/estado', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `UPDATE categorias_insumos SET estado = CASE WHEN estado='Activo' THEN 'Inactivo' ELSE 'Activo' END WHERE id=$1 RETURNING *`,
      [req.params.id]
    );
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Mueve todos los insumos de una categoría a otra (existente o recién
// creada) y elimina la categoría de origen — así nunca queda un insumo sin
// categoría. Se usa desde ModalRecategorizar antes de poder eliminar una
// categoría que sí tiene insumos.
catInsRouter.post('/:id/recategorizar', auth, async (req, res) => {
  try {
    const { nuevaCategoriaId, nuevaCategoriaNombre } = req.body;
    let destinoId = nuevaCategoriaId || null;
    if (!destinoId && nuevaCategoriaNombre) {
      const { rows } = await pool.query(`INSERT INTO categorias_insumos(nombre) VALUES($1) RETURNING id`, [nuevaCategoriaNombre]);
      destinoId = rows[0].id;
    }
    if (!destinoId) return res.status(400).json({ error: 'Selecciona una categoría existente o escribe el nombre de una nueva.' });
    if (String(destinoId) === String(req.params.id)) {
      return res.status(400).json({ error: 'La nueva categoría no puede ser la misma que se va a eliminar.' });
    }
    await pool.query(`UPDATE insumos SET categoria_id=$1 WHERE categoria_id=$2`, [destinoId, req.params.id]);
    await pool.query(`DELETE FROM categorias_insumos WHERE id=$1`, [req.params.id]);
    const { rows: nueva } = await pool.query(`SELECT * FROM categorias_insumos WHERE id=$1`, [destinoId]);
    res.json({ ok: true, categoria: nueva[0] });
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ error: 'Ya existe una categoría con ese nombre' });
    res.status(500).json({ error: e.message });
  }
});
catInsRouter.delete('/:id', auth, async (req, res) => {
  try {
    const { rows: insumosAsociados } = await pool.query(`SELECT id, nombre FROM insumos WHERE categoria_id=$1`, [req.params.id]);
    if (insumosAsociados.length) {
      return res.status(409).json({
        error: 'La categoría contiene insumos asociados.',
        insumos: insumosAsociados.map(i => i.nombre),
        insumosAsociados: insumosAsociados.length,
      });
    }
    await pool.query(`DELETE FROM categorias_insumos WHERE id=$1`, [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
r.use('/categorias-insumos', catInsRouter);

// ── INSUMOS ────────────────────────────────────────────────
// Alias camelCase → exactamente los nombres que ya usa el frontend
// (InsumoForm, InsumosPage, VerInsumoPage): antes el backend devolvía
// columnas snake_case (stock, stock_minimo, unidad, proveedor_id) que no
// coincidían con nada de lo que leía React (stockActual, stockMinimo,
// unidadMedida, proveedor), así que categoría/unidad/proveedor se veían
// vacíos y el stock daba NaN (Number(undefined)).
const INSUMO_COLS = `
  i.id, i.nombre, i.descripcion, i.estado,
  i.stock AS "stockActual", i.stock_minimo AS "stockMinimo",
  i.unidad AS "unidadMedida", i.precio_unitario AS "precioUnitario",
  i.proveedor_id AS "proveedorId", p.nombre AS proveedor,
  i.categoria_id AS "categoriaId", ci.nombre AS categoria,
  i.es_topping AS "esTopping",
  i.created_at AS "fechaCreacion"
`;
const INSUMO_JOINS = `
  FROM insumos i
  LEFT JOIN proveedores p ON i.proveedor_id = p.id
  LEFT JOIN categorias_insumos ci ON i.categoria_id = ci.id
`;
// Unidad de medida REAL del insumo — nunca una presentación de compra
// (caja, paquete, bolsa, docena). Esas se manejan por ítem al registrar la
// compra (ver PRESENTACIONES_VALIDAS / POST /compras más abajo), no como
// unidad del insumo. Coincide con el CHECK de la columna en schema.sql/db.js.
const UNIDADES_VALIDAS = ['kg', 'g', 'lb', 'oz', 'L', 'mL', 'unidad'];

const insRouter = require('express').Router();
insRouter.param('id', validateId); // valida :id (numérico) antes de las rutas de abajo
// Cada insumo ya trae su "estado" ('Activo' / 'Inactivo') en la respuesta,
// pero el formulario de Compras necesita poder pedirle al backend que le
// excluya los inactivos directamente (en vez de confiar en que el
// frontend los filtre él mismo antes de mostrarlos en el selector). El
// filtro es opcional: sin ?estado=, se sigue devolviendo todo, igual que
// antes, para no romper otras pantallas (ej. InsumosPage) que sí necesitan
// ver los inactivos para poder reactivarlos.
// ?q= filtra por nombre (ILIKE, insensible a mayúsculas/acentos exactos) —
// lo usa el buscador con lupa del formulario de Ficha Técnica para no
// tener que traer/filtrar en el navegador la lista completa de insumos
// cada vez. ?esTopping=true/false filtra por el flag informativo de la
// columna. Combinables entre sí y con ?estado=, igual que antes.
insRouter.get('/', auth, async (req, res) => {
  try {
  const { estado, q, esTopping } = req.query;
  const condiciones = [];
  const params = [];
  if (estado)    { params.push(estado); condiciones.push(`i.estado = $${params.length}`); }
  if (q)         { params.push(`%${q}%`); condiciones.push(`i.nombre ILIKE $${params.length}`); }
  if (esTopping !== undefined) { params.push(esTopping === 'true'); condiciones.push(`i.es_topping = $${params.length}`); }
  const where = condiciones.length ? `WHERE ${condiciones.join(' AND ')}` : '';
  const { rows } = await pool.query(`SELECT ${INSUMO_COLS} ${INSUMO_JOINS} ${where} ORDER BY i.id DESC`, params);
  res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
insRouter.get('/:id', auth, async (req, res) => {
  try {
  const { rows } = await pool.query(`SELECT ${INSUMO_COLS} ${INSUMO_JOINS} WHERE i.id=$1`, [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Insumo no encontrado' });
  res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// El nombre de un insumo debe ser único dentro de un mismo proveedor (dos
// proveedores distintos sí pueden vender un insumo con el mismo nombre).
const insumoNombreDuplicado = async (nombre, proveedorId, excluirId) => {
  if (!nombre || !proveedorId) return false;
  const params = excluirId ? [nombre, proveedorId, excluirId] : [nombre, proveedorId];
  const cond = excluirId ? 'lower(nombre)=lower($1) AND proveedor_id=$2 AND id<>$3' : 'lower(nombre)=lower($1) AND proveedor_id=$2';
  const { rows } = await pool.query(`SELECT id FROM insumos WHERE ${cond} LIMIT 1`, params);
  return !!rows[0];
};

insRouter.post('/', auth, async (req, res) => {
  try {
  const { nombre, categoriaId, unidadMedida, stockActual, stockMinimo, precioUnitario, proveedorId, descripcion, estado, esTopping } = req.body;
  // La unidad es opcional al crear (igual que antes), pero si llega tiene
  // que ser una de las 7 unidades reales — "caja", "paquete", "bolsa" y
  // "docena" ya no son unidades válidas del insumo: ahora se registran por
  // ítem, al hacer la compra (ver PRESENTACIONES_VALIDAS / POST /compras).
  if (unidadMedida && !UNIDADES_VALIDAS.includes(unidadMedida)) {
    return res.status(400).json({ error: `Unidad de medida inválida. Debe ser una de: ${UNIDADES_VALIDAS.join(', ')}.` });
  }
  // Espejo de la validación del frontend: no se puede crear un insumo si
  // no hay ningún proveedor Activo (ni registrado, ni todos inactivos).
  const { rows: activos } = await pool.query(`SELECT id FROM proveedores WHERE estado='Activo' LIMIT 1`);
  if (activos.length === 0) {
    return res.status(400).json({ error: 'No hay proveedores disponibles. Registra o activa un proveedor antes de crear un insumo.' });
  }
  if (await insumoNombreDuplicado(nombre, proveedorId, null)) {
    return res.status(400).json({ error: 'Ya existe un insumo con este nombre para este proveedor.' });
  }
  const { rows } = await pool.query(
    `INSERT INTO insumos(nombre,categoria_id,unidad,stock,stock_minimo,precio_unitario,proveedor_id,descripcion,estado,es_topping)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
    [nombre, categoriaId || null, unidadMedida || null, stockActual || 0, stockMinimo || 0, precioUnitario || 0, proveedorId || null, descripcion || null, estado || 'Activo', !!esTopping]
  );
  const { rows: full } = await pool.query(`SELECT ${INSUMO_COLS} ${INSUMO_JOINS} WHERE i.id=$1`, [rows[0].id]);
  res.status(201).json(full[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
insRouter.put('/:id', auth, async (req, res) => {
  try {
  const { nombre, categoriaId, unidadMedida, stockActual, stockMinimo, precioUnitario, proveedorId, descripcion, estado, esTopping } = req.body;

  // La unidad de medida es inmutable una vez creado el insumo: cambiarla
  // después dejaría el stock y las compras históricas expresados en una
  // unidad distinta a la actual, sin ninguna conversión. Se rechaza
  // cualquier intento de mandar un valor distinto al que ya tiene guardado
  // (incluso si el nuevo valor es, por sí solo, una unidad válida).
  const { rows: actual } = await pool.query('SELECT unidad FROM insumos WHERE id=$1', [req.params.id]);
  if (!actual[0]) return res.status(404).json({ error: 'Insumo no encontrado' });
  const unidadEnviada = unidadMedida || null;
  if (unidadEnviada !== actual[0].unidad) {
    return res.status(400).json({ error: 'La unidad de medida no se puede modificar después de creado el insumo.' });
  }

  if (await insumoNombreDuplicado(nombre, proveedorId, req.params.id)) {
    return res.status(400).json({ error: 'Ya existe un insumo con este nombre para este proveedor.' });
  }
  const { rows } = await pool.query(
    `UPDATE insumos SET nombre=$1,categoria_id=$2,unidad=$3,stock=$4,stock_minimo=$5,precio_unitario=$6,proveedor_id=$7,descripcion=$8,estado=$9,es_topping=$10
     WHERE id=$11 RETURNING id`,
    [nombre, categoriaId || null, unidadEnviada, stockActual, stockMinimo, precioUnitario, proveedorId || null, descripcion || null, estado, !!esTopping, req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Insumo no encontrado' });
  const { rows: full } = await pool.query(`SELECT ${INSUMO_COLS} ${INSUMO_JOINS} WHERE i.id=$1`, [req.params.id]);
  res.json(full[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
insRouter.patch('/:id/estado', auth, async (req, res) => {
  try {
  const { rows } = await pool.query(
    `UPDATE insumos SET estado=CASE WHEN estado='Activo' THEN 'Inactivo' ELSE 'Activo' END WHERE id=$1 RETURNING id`,
    [req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Insumo no encontrado' });
  const { rows: full } = await pool.query(`SELECT ${INSUMO_COLS} ${INSUMO_JOINS} WHERE i.id=$1`, [req.params.id]);
  res.json(full[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
insRouter.delete('/:id', auth, async (req, res) => {
  try {
  const { rows: actual } = await pool.query('SELECT nombre FROM insumos WHERE id=$1', [req.params.id]);
  if (!actual[0]) return res.status(404).json({ error: 'Insumo no encontrado' });
  // Las compras guardan sus ítems por nombre de insumo (no por id — ver
  // ajustarStockInsumo más abajo), así que se busca igual aquí.
  const { rows: conCompras } = await pool.query(
    `SELECT 1 FROM compras c, jsonb_array_elements(c.items) it WHERE lower(it->>'insumo') = lower($1) LIMIT 1`,
    [actual[0].nombre]
  );
  if (conCompras[0]) {
    return res.status(400).json({ error: 'No se puede eliminar: este insumo tiene compras registradas. Desactívalo en su lugar.' });
  }
  await pool.query('DELETE FROM insumos WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
r.use('/insumos', insRouter);

// ── COMPRAS ────────────────────────────────────────────────
// Alias camelCase → lo que ya usa el frontend (ComprasPage, VerCompraPage,
// HistorialComprasPage): antes se devolvía proveedor_nombre / created_at en
// snake_case y React esperaba proveedorNombre / fechaCreacion, así que el
// proveedor y las fechas se veían vacíos en toda la sección de Compras.
const COMPRA_COLS = `
  c.id, c.codigo, c.proveedor_id AS "proveedorId", p.nombre AS "proveedorNombre",
  c.fecha, c.descuento, c.total, c.estado, c.observaciones, c.items,
  c.comprobante_url, c.comprobante_verificado, c.comprobante_total_ocr,
  c.motivo_anulacion AS "motivoAnulacion",
  c.created_at AS "fechaCreacion", c.fecha_anulacion AS "fechaAnulacion"
`;
const COMPRA_JOINS = `FROM compras c LEFT JOIN proveedores p ON c.proveedor_id = p.id`;

// Ajusta el stock de un insumo buscándolo por nombre (el formulario de
// Compras solo guarda el nombre del insumo en cada ítem, no su id).
// delta > 0 suma stock (al registrar la compra), delta < 0 lo resta (al
// anularla) sin dejarlo nunca negativo.
const ajustarStockInsumo = async (nombreInsumo, delta) => {
  if (!nombreInsumo) return;
  if (delta >= 0) {
    await pool.query(
      `UPDATE insumos SET stock = COALESCE(stock,0) + $1 WHERE lower(nombre) = lower($2)`,
      [delta, nombreInsumo]
    );
  } else {
    await pool.query(
      `UPDATE insumos SET stock = GREATEST(COALESCE(stock,0) + $1, 0) WHERE lower(nombre) = lower($2)`,
      [delta, nombreInsumo]
    );
  }
};

// ── Presentación de compra ──────────────────────────────────────────────
// Cada ítem de una compra se registra de una de dos formas, elegida
// libremente en ESE ítem (no es una preferencia del insumo):
//   - "directo": la cantidad ya viene en la unidad real del insumo — es el
//     comportamiento de siempre, sin cambios (item.cantidad).
//   - "presentacion": la cantidad viene en cajas/paquetes/bolsas/docenas
//     (item.cantidad_presentaciones), y item.contenido_por_presentacion
//     dice cuánto de la unidad real trae cada una (ej. 24 si son 24 kg por
//     caja). El stock del insumo NUNCA queda expresado en cajas/paquetes/
//     bolsas/docenas: siempre se convierte a la unidad real antes de
//     sumarlo o restarlo.
const PRESENTACIONES_VALIDAS = ['Caja', 'Paquete', 'Bolsa', 'Docena'];

// Valida la forma de un ítem de compra en modo "presentacion" antes de
// guardarlo. Sin esto, un cantidad_presentaciones decimal/negativo o un
// contenido_por_presentacion en 0 dejaría el stock sumado mal calculado
// (o en 0) sin que nada lo impidiera.
const validarItemCompra = (item, index) => {
  if (item?.modo !== 'presentacion') return null; // "directo" no cambia: sin validación nueva
  const etiqueta = item.insumo || `ítem #${index + 1}`;
  if (!PRESENTACIONES_VALIDAS.includes(item.tipo_presentacion)) {
    return `"${etiqueta}": tipo_presentacion debe ser una de: ${PRESENTACIONES_VALIDAS.join(', ')}.`;
  }
  if (!Number.isInteger(item.cantidad_presentaciones) || item.cantidad_presentaciones <= 0) {
    return `"${etiqueta}": cantidad_presentaciones debe ser un número entero mayor a 0.`;
  }
  const contenido = Number(item.contenido_por_presentacion);
  if (!Number.isFinite(contenido) || contenido <= 0) {
    return `"${etiqueta}": contenido_por_presentacion debe ser mayor a 0.`;
  }
  return null;
};

// Cuánto stock (siempre en la unidad real del insumo) representa un ítem
// de compra ya validado, sin importar si se registró "directo" o por
// "presentacion". Se usa tanto al sumar stock al crear la compra como al
// revertirlo al anularla (los ítems guardados en la compra ya traen
// modo/tipo_presentacion/etc., así que la reversión usa la misma cuenta).
const calcularCantidadStock = (item) => {
  if (item?.modo === 'presentacion') {
    return (Number(item.cantidad_presentaciones) || 0) * (Number(item.contenido_por_presentacion) || 0);
  }
  return Number(item?.cantidad) || 0;
};

// Igual que ajustarStockInsumo, pero buscando el insumo por id en vez de
// por nombre — las fichas técnicas guardan id_insumo/vaso_id (no nombres),
// así se reutiliza el mismo criterio de "nunca dejar el stock negativo".
const ajustarStockInsumoPorId = async (idInsumo, delta) => {
  if (!idInsumo) return;
  await pool.query(
    `UPDATE insumos SET stock = GREATEST(COALESCE(stock,0) + $1, 0) WHERE id = $2`,
    [delta, idInsumo]
  );
};

// Los combos del carrito (Landing.jsx) se identifican con un id sintético
// tipo "combo-5" (string, no un id real de productos) para distinguirlos
// de un producto normal en el carrito compartido. Se reutiliza en varios
// puntos de este archivo (parseIdentificadorProducto ya hace el parseo
// real; esto solo extrae el id de producto de un ítem/componente de forma
// consistente, sea de "items" de un pedido o de "items" de un combo).
const idProductoDeItem = (it) => {
  const identificador = parseIdentificadorProducto(it.id ?? it.id_producto ?? it.producto_id);
  return identificador?.tipo === 'producto' ? identificador.id : null;
};

// Trae, para TODA una lista de items de pedido, todo lo que hace falta
// para calcular su receta efectiva de cada línea: la ficha técnica activa
// de cada producto presente —incluidos los que componen cualquier COMBO
// del pedido, no solo los productos pedidos directamente— (ingredientes/
// vaso_id/preparacion/toppings_ficha), la definición de esos combos
// (items) y TODOS los toppings/adiciones (con insumo_id/cantidad/nombre)
// — una sola consulta por tabla para todo el pedido, en vez de una por
// línea. La reutilizan tanto descontarInventarioPorVenta (para saber qué y
// cuánto descontar) como enriquecerItemsPedido (para exponer
// "receta_efectiva" en GET /pedidos), así que la fórmula de combinación
// vive en un solo lugar (calcularRecetaEfectiva, justo abajo) en vez de
// duplicarse entre las dos.
const prepararDatosReceta = async (items) => {
  const lista = Array.isArray(items) ? items : [];
  const idCombo = (it) => {
    const identificador = parseIdentificadorProducto(it.id ?? it.id_producto ?? it.producto_id);
    return identificador?.tipo === 'combo' ? identificador.id : null;
  };

  // Combos presentes en el pedido: se resuelven sus productos componentes
  // para poder sumar los insumos de CADA UNO, igual que si se hubieran
  // pedido por separado — antes un combo no descontaba nada de stock
  // porque "producto_id" no aplicaba a un id sintético "combo-5".
  const comboIds = [...new Set(lista.map(idCombo).filter(Boolean))];
  const comboPorId = new Map();
  if (comboIds.length) {
    const { rows: combos } = await pool.query(`SELECT id, items FROM combos WHERE id = ANY($1)`, [comboIds]);
    for (const c of combos) comboPorId.set(c.id, c);
  }

  // Ids de producto reales: los pedidos directamente, MÁS los que
  // componen cualquier combo del pedido — una sola consulta a
  // fichas_tecnicas cubre ambos casos.
  const productoIdsDirectos = lista.map(idProductoDeItem).filter(Boolean);
  const productoIdsDeCombos = [...comboPorId.values()]
    .flatMap(c => (c.items || []).map(idProductoDeItem))
    .filter(Boolean);
  const productoIds = [...new Set([...productoIdsDirectos, ...productoIdsDeCombos])];

  const fichaPorProducto = new Map();
  if (productoIds.length) {
    const { rows: fichas } = await pool.query(
      `SELECT producto_id, ingredientes, vaso_id, preparacion, toppings_ficha FROM fichas_tecnicas
         WHERE producto_id = ANY($1) AND estado = true`,
      [productoIds]
    );
    for (const f of fichas) fichaPorProducto.set(f.producto_id, f);
  }
  const [{ rows: toppings }, { rows: adiciones }] = await Promise.all([
    pool.query(`SELECT id, nombre, insumo_id, cantidad FROM toppings`),
    pool.query(`SELECT id, nombre, insumo_id, cantidad FROM adiciones`),
  ]);
  return {
    idProducto: idProductoDeItem,
    idCombo,
    fichaPorProducto,
    comboPorId,
    toppingPorId: new Map(toppings.map(t => [t.id, t])),
    adicionPorId: new Map(adiciones.map(a => [a.id, a])),
  };
};

// Calcula la "receta efectiva" de UNA unidad de una línea de pedido — sea
// un producto individual o un COMBO:
//
//   Producto individual: insumos base de su ficha técnica + el vaso
//   (fichas_tecnicas.vaso_id, se trata como "un insumo más") + insumos de
//   los toppings que el cliente MANTUVO (it.toppings — si quitó alguno, ya
//   no aparece ahí y no se descuenta) + insumos de las adiciones que
//   eligió (it.adiciones).
//
//   Combo: la SUMA de exactamente lo anterior para CADA producto que lo
//   compone (según combos.items — "cada producto del combo con su propia
//   cantidad, toppings y adiciones", fijados al crear/editar el combo, no
//   elegidos por el cliente), multiplicado por cuántas unidades de ESE
//   producto trae el combo. Un combo nunca tiene una única ficha técnica
//   propia — antes esto lo dejaba sin ningún descuento de stock.
//
// Todo YA combinado y sumado por insumo — si el mismo insumo aparece en
// más de una fuente (ej. dos productos del combo comparten un insumo, o
// el insumo base y un topping), queda UNA sola entrada con la suma. No
// multiplica por it.cantidad de la línea del pedido (eso lo hace quien la
// use): esto es "por una unidad" de la línea (una unidad de combo ya
// cuenta como "N productos", según lo que ese combo defina).
//
// La cantidad de un topping es el override de "toppings_ficha" de ESE
// producto si lo tiene, si no el "cantidad" por defecto del topping. Las
// adiciones no tienen override por producto (son universales, sin
// producto_id): siempre usan su propio "cantidad".
//
// Devuelve un Map<id_insumo, cantidad> (no un array): así
// descontarInventarioPorVenta puede recorrerlo directo, y
// enriquecerItemsPedido solo necesita convertirlo a array al final.
const calcularRecetaEfectiva = (it, datos) => {
  const { idProducto, idCombo, fichaPorProducto, comboPorId, toppingPorId, adicionPorId } = datos;
  const totales = new Map();
  const sumar = (idInsumo, cantidad) => {
    if (!idInsumo || !(cantidad > 0)) return;
    totales.set(idInsumo, (totales.get(idInsumo) || 0) + cantidad);
  };

  // Suma la receta de UN producto (ficha + toppings mantenidos + adiciones
  // elegidas), multiplicada por cuántas unidades de ese producto aplican
  // acá — 1 para un producto pedido directamente, o la cantidad que ese
  // producto tenga DENTRO del combo.
  const sumarProducto = (productoId, unidades, toppingsSeleccionados, adicionesSeleccionadas) => {
    const ficha = productoId ? fichaPorProducto.get(productoId) : null;
    for (const ingrediente of (ficha?.ingredientes || [])) {
      sumar(ingrediente.id_insumo, (Number(ingrediente.cantidad) || 0) * unidades);
    }
    if (ficha?.vaso_id) sumar(ficha.vaso_id, unidades);

    const overridePorTopping = new Map(
      (ficha?.toppings_ficha || []).map(tf => [tf.topping_id, Number(tf.cantidad)])
    );
    for (const t of (Array.isArray(toppingsSeleccionados) ? toppingsSeleccionados : [])) {
      // Formato flexible: array de ids, o de objetos {id,...} — mismo
      // criterio que ya resuelve enriquecerItemsPedido para
      // personalizacion.toppings.
      const toppingId = (t !== null && typeof t === 'object') ? t.id : t;
      const topping = toppingPorId.get(toppingId);
      if (!topping || !topping.insumo_id) continue; // topping sin insumo asociado: nada que descontar
      const cantidadPorUnidad = overridePorTopping.has(toppingId) ? overridePorTopping.get(toppingId) : (Number(topping.cantidad) || 0);
      sumar(topping.insumo_id, cantidadPorUnidad * unidades);
    }

    for (const a of (Array.isArray(adicionesSeleccionadas) ? adicionesSeleccionadas : [])) {
      const adicionId = (a !== null && typeof a === 'object') ? a.id : a;
      const adicion = adicionPorId.get(adicionId);
      if (!adicion || !adicion.insumo_id) continue; // adición sin insumo asociado: nada que descontar
      sumar(adicion.insumo_id, (Number(adicion.cantidad) || 0) * unidades);
    }
  };

  const comboId = idCombo(it);
  if (comboId) {
    const combo = comboPorId.get(comboId);
    for (const componente of (combo?.items || [])) {
      const productoId = idProducto(componente);
      if (!productoId) continue; // un combo dentro de otro combo (caso raro/no soportado): se omite en vez de tronar
      sumarProducto(productoId, Number(componente.cantidad) || 1, componente.toppings, componente.adiciones);
    }
  } else {
    sumarProducto(idProducto(it), 1, it.toppings, it.adiciones);
  }

  return totales;
};

// Descuenta del inventario, por cada línea del pedido, la receta efectiva
// completa (× la cantidad vendida de esa línea) — insumos base + vaso de
// la ficha técnica + toppings que la unidad conservó + adiciones elegidas
// (sumando también, si la línea es un combo, la receta de cada producto
// que lo compone), ya combinados y sumados por insumo (ver
// calcularRecetaEfectiva), así que un insumo compartido entre dos fuentes
// se descuenta una sola vez por su total, no dos veces por separado. Se
// usa al registrar una venta — antes ninguna venta tocaba el stock, solo
// las compras lo aumentaban.
const descontarInventarioPorVenta = async (items) => {
  const lista = Array.isArray(items) ? items : [];
  if (!lista.length) return;
  const datos = await prepararDatosReceta(lista);
  for (const it of lista) {
    const cantidadVendida = Number(it.cantidad) || 1;
    const totales = calcularRecetaEfectiva(it, datos);
    for (const [idInsumo, cantidadPorUnidad] of totales) {
      await ajustarStockInsumoPorId(idInsumo, -(cantidadPorUnidad * cantidadVendida));
    }
  }
};

// Genera el siguiente código legible de una compra para el año actual (ej.
// "CMP-2026-0001"). Se basa en el mayor consecutivo ya usado ese año (no en
// un COUNT, para no repetir un número si alguna compra del año fue
// eliminada) y quien la llama debe estar listo para reintentar si dos
// compras casi simultáneas llegan a calcular el mismo consecutivo (ver
// POST /compras más abajo).
const generarCodigoCompra = async () => {
  const anio = new Date().getFullYear();
  const prefijo = `CMP-${anio}-`;
  const { rows } = await pool.query(
    `SELECT codigo FROM compras WHERE codigo LIKE $1 ORDER BY codigo DESC LIMIT 1`,
    [`${prefijo}%`]
  );
  const ultimo = rows[0]?.codigo;
  const siguiente = ultimo ? Number(ultimo.slice(prefijo.length)) + 1 : 1;
  return `${prefijo}${String(siguiente).padStart(4, '0')}`;
};

const compRouter = require('express').Router();
compRouter.get('/', auth, async (req, res) => {
  try {
  const { rows } = await pool.query(`SELECT ${COMPRA_COLS} ${COMPRA_JOINS} WHERE c.estado='activa' ORDER BY c.id DESC`);
  res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Historial de compras: antes devolvía TODAS las compras sin ningún
// filtro (el "> 30 días o anulada" solo existía como texto en la UI). Acá
// se filtra de verdad: una compra entra al historial si ya pasó su
// antigüedad (por defecto 30 días, configurable con ?dias=) o si está
// anulada — sin importar la antigüedad, una anulada siempre debe quedar
// visible en el historial.
compRouter.get('/historial', auth, async (req, res) => {
  try {
  const diasParam = Number(req.query.dias);
  const dias = Number.isFinite(diasParam) && diasParam > 0 ? diasParam : 30;
  const { rows } = await pool.query(
    `SELECT ${COMPRA_COLS} ${COMPRA_JOINS}
     WHERE c.fecha < (CURRENT_DATE - $1::int) OR c.estado = 'anulada'
     ORDER BY c.id DESC`,
    [dias]
  );
  res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
compRouter.get('/:id', auth, async (req, res) => {
  try {
  const { rows } = await pool.query(`SELECT ${COMPRA_COLS} ${COMPRA_JOINS} WHERE c.id=$1`, [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Compra no encontrada' });
  res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
compRouter.post('/', auth, async (req, res) => {
  try {
  // El formulario manda proveedorId en camelCase (no proveedor_id): antes
  // esto se leía mal y el proveedor de la compra quedaba siempre en NULL.
  const {
    proveedorId, fecha, total, descuento, items, observaciones,
    comprobante_url, comprobante_verificado, comprobante_total_ocr,
  } = req.body;

  // El descuento es opcional (0 por defecto) pero, si llega, tiene que ser
  // un porcentaje válido entre 0 y 100. Sin esta validación un valor como
  // -10 o 500 se guardaría tal cual y el total final quedaría mal
  // calculado (incluso negativo o mayor al bruto).
  const descuentoNum = (descuento === undefined || descuento === null || descuento === '')
    ? 0 : Number(descuento);
  if (Number.isNaN(descuentoNum) || descuentoNum < 0 || descuentoNum > 100) {
    return res.status(400).json({ error: 'El descuento debe ser un número entre 0 y 100.' });
  }

  // `total` que manda el formulario es el total bruto (suma de los items,
  // antes de descuento). El total final que se guarda siempre se calcula
  // acá en el backend a partir de ese bruto y el descuento — así un
  // cliente no puede mandar un total ya "descontado" que no cuadre con el
  // porcentaje declarado.
  const totalBruto = Number(total) || 0;
  const totalFinal = totalBruto - (totalBruto * descuentoNum / 100);

  // Cada ítem puede venir en modo "directo" (sin cambios) o "presentacion"
  // (caja/paquete/bolsa/docena) — ver validarItemCompra más arriba. Se
  // valida ANTES de insertar nada: si un solo ítem viene mal, la compra
  // completa se rechaza en vez de quedar a medio guardar.
  for (let i = 0; i < (items || []).length; i++) {
    const errorItem = validarItemCompra(items[i], i);
    if (errorItem) return res.status(400).json({ error: `Ítem inválido: ${errorItem}` });
  }

  // El código legible (ej. "CMP-2026-0001") lo genera siempre el backend,
  // nunca lo manda el cliente. Se reintenta unas pocas veces por si dos
  // compras casi simultáneas llegan a calcular el mismo consecutivo
  // (23505 = violación de unicidad sobre la columna "codigo").
  let compraId = null;
  let intentosRestantes = 5;
  while (compraId === null && intentosRestantes > 0) {
    intentosRestantes--;
    const codigo = await generarCodigoCompra();
    try {
      const { rows } = await pool.query(
        `INSERT INTO compras(codigo,proveedor_id,fecha,descuento,total,items,observaciones,comprobante_url,comprobante_verificado,comprobante_total_ocr,estado)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'activa') RETURNING id`,
        [
          codigo, proveedorId || null, fecha || new Date(), descuentoNum, totalFinal,
          JSON.stringify(items || []), observaciones || null, comprobante_url || null,
          comprobante_verificado || false, comprobante_total_ocr ?? null,
        ]
      );
      compraId = rows[0].id;
    } catch (e) {
      if (e.code === '23505' && intentosRestantes > 0) continue; // choque de código, reintentar con el siguiente
      throw e;
    }
  }
  if (compraId === null) {
    return res.status(500).json({ error: 'No se pudo generar un código de compra único, intenta de nuevo.' });
  }

  // Sumar al stock de cada insumo comprado — convertido a su unidad real
  // si el ítem vino en modo "presentacion" (ver calcularCantidadStock).
  for (const it of (items || [])) {
    await ajustarStockInsumo(it.insumo, calcularCantidadStock(it));
  }
  const { rows: full } = await pool.query(`SELECT ${COMPRA_COLS} ${COMPRA_JOINS} WHERE c.id=$1`, [compraId]);
  res.status(201).json(full[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
compRouter.patch('/:id/anular', auth, async (req, res) => {
  try {
  const { motivo } = req.body;
  const { rows: actual } = await pool.query('SELECT estado, items FROM compras WHERE id=$1', [req.params.id]);
  if (!actual[0]) return res.status(404).json({ error: 'Compra no encontrada' });
  if (actual[0].estado === 'anulada') return res.status(400).json({ error: 'Esta compra ya está anulada.' });

  // Revertir el stock que esta compra había sumado — con la misma cuenta
  // que se usó al crearla (los ítems guardados ya traen modo/
  // tipo_presentacion/etc., así que un ítem en cajas se revierte en la
  // unidad real del insumo, no en cajas).
  for (const it of (actual[0].items || [])) {
    await ajustarStockInsumo(it.insumo, -calcularCantidadStock(it));
  }

  await pool.query(
    `UPDATE compras SET estado='anulada', motivo_anulacion=$1, fecha_anulacion=NOW() WHERE id=$2`,
    [motivo, req.params.id]
  );
  const { rows: full } = await pool.query(`SELECT ${COMPRA_COLS} ${COMPRA_JOINS} WHERE c.id=$1`, [req.params.id]);
  res.json(full[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
r.use('/compras', compRouter);

// ── PEDIDOS ────────────────────────────────────────────────
// Orden real del flujo: el pago debe quedar confirmado ANTES de que el
// pedido pase a preparación, no al final.
// 'cancelado' es aparte — no vive en esta secuencia porque se puede dar en
// cualquier momento antes de 'entregado', sin importar en qué paso vaya el
// pedido (ver PATCH /:id/estado más abajo).
const ESTADOS_PEDIDO_ORDEN = ['pendiente_verificacion', 'pendiente', 'en_proceso', 'listo', 'entregado'];
const IDX_EN_PROCESO = ESTADOS_PEDIDO_ORDEN.indexOf('en_proceso');

// Único conjunto de métodos de pago válido para pedidos NUEVOS — coincide
// con el CHECK pedidos_pago_check de config/db.js/schema.sql (agregado con
// NOT VALID: no toca pedidos ya guardados con un valor viejo como
// 'Bancolombia'/'Daviplata'/mayúsculas distintas, solo exige esta lista
// desde acá en adelante). En minúscula porque así es como lo manda
// realmente el frontend — antes la lista estaba en mayúscula
// ('Nequi'/'Bancolombia'/'Efectivo'), lo que nunca coincidía con lo que de
// verdad llegaba y rechazaba pedidos válidos.
const METODOS_PAGO_VALIDOS = ['efectivo', 'nequi', 'transferencia'];
const metodoPagoInvalido = (pago) => !!pago && !METODOS_PAGO_VALIDOS.includes(String(pago).toLowerCase());
// Normaliza a minúscula antes de guardar: así CUALQUIER comparación
// posterior contra 'pago' (acá o en cualquier otra ruta) puede confiar en
// que un pedido nuevo siempre lo tiene en minúscula, sin tener que volver
// a repetir .toLowerCase() en cada sitio. Pedidos viejos con otra
// capitalización no se tocan (esto solo aplica al guardar, no migra datos
// existentes) — por eso esEfectivo() de abajo sigue siendo case-insensitive,
// para seguir funcionando también con esos pedidos viejos.
const normalizarPago = (pago) => (pago ? String(pago).toLowerCase() : null);
// Único punto de verdad para "¿es efectivo?" — case-insensitive a
// propósito, porque no todo pedido en la tabla tiene 'pago' ya normalizado
// a minúscula (los guardados antes de este cambio pueden tener
// 'Efectivo'). Antes esta comparación estaba repetida e inconsistente en
// 3 lugares distintos, todas con === 'Efectivo' (case-sensitive) contra un
// valor real que el frontend siempre mandó en minúscula — de ahí que el
// pago en efectivo quedara bloqueado como si no lo fuera.
const esEfectivo = (pago) => String(pago || '').toLowerCase() === 'efectivo';

// Separa, para cada línea de "items" de un pedido, la RECETA BASE del
// producto (fija, sale de fichas_tecnicas — nunca cambia por pedido) de la
// PERSONALIZACIÓN de esa línea (toppings/adiciones que el cliente eligió
// para esa unidad, ya venían guardados en el propio ítem). No se quita ni
// se sobrescribe ningún campo original del ítem (nombre, precio,
// cantidad, toppings, adiciones, etc.) — esto solo AGREGA "receta" y
// "personalizacion" encima de lo que ya traía.
//
// ⚠️ Límite real de esta función: este backend nunca ha validado ni
// transformado el array "items" que arma el carrito al crear el pedido
// (POST /pedidos lo guarda tal cual con JSON.stringify) — así que si el
// frontend agrupa varias unidades del mismo producto con toppings
// distintos bajo una sola línea (ej. { id, cantidad: 3, toppings: [...] }
// en vez de 3 líneas separadas), esas unidades comparten la misma
// "personalizacion" acá también: no hay forma de reconstruir, después del
// hecho, una separación por unidad que nunca se guardó. Si tu carrito no
// crea una línea de "items" por cada combinación distinta de toppings/
// adiciones (una línea por unidad o por combinación, no una línea por
// producto con cantidad agregada), avísame la forma real para ajustar
// esto — no pude confirmarlo desde este repo: no hay pedidos guardados
// todavía en esta base de datos para inspeccionar, y el carrito/checkout
// que arma "items" vive en el frontend, no aquí.
const enriquecerItemsPedido = async (items) => {
  const lista = Array.isArray(items) ? items : [];
  if (lista.length === 0) return [];

  const datos = await prepararDatosReceta(lista);
  const { idProducto, fichaPorProducto, toppingPorId, adicionPorId } = datos;

  // "receta_efectiva" de cada línea (ver calcularRecetaEfectiva) — ya
  // cubre combos (suma la receta de cada producto que los compone). Se
  // calcula UNA vez acá, antes de resolver nombres, para saber de
  // antemano qué insumos hace falta consultar (insumoIds más abajo).
  const recetaEfectivaPorItem = lista.map(it => calcularRecetaEfectiva(it, datos));

  // Las fichas técnicas solo guardan id_insumo (nunca el nombre), así que
  // hay que resolverlo aparte para que la receta sea legible en la vista
  // de Bartender y no solo una lista de ids. Se resuelven de una sola vez
  // TODOS los insumos que aparezcan en cualquier receta_efectiva (cubre
  // insumos base, vaso, toppings y adiciones — es un superset de lo que
  // antes solo cubría los insumos base de la ficha).
  const insumoIds = [...new Set(recetaEfectivaPorItem.flatMap(m => [...m.keys()]))];
  const insumoPorId = new Map();
  if (insumoIds.length) {
    const { rows: insumos } = await pool.query(
      `SELECT id, nombre, unidad FROM insumos WHERE id = ANY($1)`, [insumoIds]
    );
    for (const i of insumos) insumoPorId.set(i.id, i);
  }

  // Por si el ítem del carrito solo guardó los ids elegidos (no el objeto
  // completo con nombre) en personalizacion.toppings/adiciones.
  const resolver = (valor, mapaPorId) => {
    if (!Array.isArray(valor)) return [];
    return valor.map(v => (v !== null && typeof v === 'object') ? v : { id: v, nombre: mapaPorId.get(v)?.nombre ?? null });
  };

  return lista.map((it, i) => {
    const productoId = idProducto(it);
    const ficha = productoId ? fichaPorProducto.get(productoId) : null;
    return {
      ...it,
      producto_id: productoId ?? (it.id ?? it.id_producto ?? it.producto_id ?? null),
      producto_nombre: it.nombre ?? it.producto_nombre ?? null,
      cantidad: it.cantidad ?? 1,
      receta: ficha ? {
        insumos: (ficha.ingredientes || []).map(ing => ({
          id_insumo: ing.id_insumo,
          nombre: insumoPorId.get(ing.id_insumo)?.nombre ?? null,
          unidad: insumoPorId.get(ing.id_insumo)?.unidad ?? null,
          cantidad: ing.cantidad,
        })),
        // Toppings definidos en la ficha de ESTE producto, con la cantidad
        // que efectivamente se descuenta (el override de la ficha si lo
        // tiene, si no el "cantidad" por defecto del topping) — fija,
        // igual que insumos/preparación; no confundir con
        // personalizacion.toppings, que es lo que el cliente eligió en
        // ESTA unidad.
        toppings: (ficha.toppings_ficha || []).map(tf => ({
          topping_id: tf.topping_id,
          nombre: toppingPorId.get(tf.topping_id)?.nombre ?? null,
          cantidad: tf.cantidad ?? (toppingPorId.get(tf.topping_id)?.cantidad ?? null),
        })),
        preparacion: ficha.preparacion ?? null,
      } : null, // sin ficha técnica activa (o es un combo): sin receta conocida
      personalizacion: {
        toppings: resolver(it.toppings, toppingPorId),
        adiciones: resolver(it.adiciones, adicionPorId),
      },
      // Receta efectiva: insumos base + vaso + toppings que la unidad
      // conservó + adiciones elegidas, YA combinados y sumados por insumo
      // (una sola entrada aunque el mismo insumo venga de más de una
      // fuente) — por UNA unidad de esta línea (no multiplicada por
      // "cantidad"). Si la línea es un combo, ya incluye la suma de todos
      // sus productos componentes. El Bartender solo necesita leer esta
      // lista, sin recalcular nada.
      receta_efectiva: [...recetaEfectivaPorItem[i].entries()].map(([idInsumo, cant]) => ({
        id_insumo: idInsumo,
        nombre: insumoPorId.get(idInsumo)?.nombre ?? null,
        unidad: insumoPorId.get(idInsumo)?.unidad ?? null,
        cantidad: cant,
      })),
    };
  });
};

const pedRouter = require('express').Router();
pedRouter.param('id', validateId); // valida :id (numérico) antes de las rutas de abajo
pedRouter.get('/', auth, async (req, res) => {
  try {
  // El frontend espera "productos" y "comprobanteImg"; la tabla real usa
  // "items" y "comprobante_img". Antes esto solo se resolvía a medias en
  // la tabla (con un fallback manual) y nunca en el modal de detalle, así
  // que el detalle de un pedido siempre mostraba "Sin productos
  // registrados" y jamás el comprobante subido.
  // Filtro opcional por local (?sede=Local 1 / Local 2). El Administrador
  // (sede='Ambos') no manda este filtro y ve todos los pedidos; el cajero
  // y el bartender de cada local sí lo mandan para no ver pedidos ajenos.
  //
  // Un cliente autenticado es un caso aparte: SIEMPRE se filtra por su
  // propio cliente_id (del token, nunca de un query param que pudiera
  // manipular) — antes esta ruta no distinguía el rol del token, así que
  // cualquier cliente logueado veía el historial de pedidos de TODOS los
  // clientes. ?sede= no aplica a un cliente (es un filtro de uso interno).
  const { sede } = req.query;
  const params = [];
  let where = '';
  if (req.user.rol === 'Cliente') {
    params.push(req.user.id);
    where = 'WHERE ped.cliente_id = $1';
  } else if (sede) {
    params.push(sede);
    where = 'WHERE ped.sede = $1 OR ped.sede IS NULL';
  }
  // LEFT JOIN locales: "local_nombre" es el nombre del local elegido para
  // recoger (solo si tipo = 'local' — ver POST /pedidos). "ped.*" (no "*"
  // a secas) evita el choque de nombre entre pedidos.estado y
  // locales.estado.
  const { rows } = await pool.query(
    `SELECT ped.*, l.nombre AS local_nombre, ped.comprobante_img AS "comprobanteImg"
       FROM pedidos ped LEFT JOIN locales l ON ped.local_id = l.id
       ${where} ORDER BY ped.id DESC`,
    params
  );
  // "productos" (mismo nombre que ya usaba el frontend) ahora trae, por
  // cada línea, la receta fija de la ficha técnica separada de la
  // personalización elegida en esa línea — ver enriquecerItemsPedido.
  const pedidos = await Promise.all(
    rows.map(async (p) => ({ ...p, productos: await enriquecerItemsPedido(p.items) }))
  );
  res.json(pedidos);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
pedRouter.get('/stats', auth, async (req, res) => {
  try {
  // El frontend (PedidosPage y Dashboard) espera { total, pendiente,
  // porVerificar, proceso, listo, ventas }. Antes esta consulta devolvía
  // { total, ingresos } — un objeto que no coincidía con ningún campo
  // usado en pantalla, así que las tarjetas de estadísticas de Pedidos
  // (Pendientes, Por verificar, En proceso, Ventas del día) siempre
  // quedaban en 0/undefined sin importar los pedidos reales.
  const { rows } = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE estado <> 'anulado')                AS total,
      COUNT(*) FILTER (WHERE estado = 'pendiente')                AS pendiente,
      COUNT(*) FILTER (WHERE estado = 'pendiente_verificacion')   AS "porVerificar",
      COUNT(*) FILTER (WHERE estado = 'en_proceso')                AS proceso,
      COUNT(*) FILTER (WHERE estado = 'listo')                     AS listo,
      COALESCE(SUM(total) FILTER (
        WHERE created_at::date = CURRENT_DATE
          AND estado NOT IN ('cancelado','anulado')
      ), 0)                                                        AS ventas
    FROM pedidos
  `);
  res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// GET /pedidos/mis-pedidos: historial de pedidos del cliente autenticado —
// se filtra por cliente_id = req.user.id (nunca por un id recibido en la
// URL/query), mismo criterio que ya usa GET /clientes/mi-perfil para que
// un cliente no pueda ver los datos de otro. GET /pedidos (sin filtro, más
// arriba) sigue existiendo tal cual para el panel admin/cajero/bartender,
// que sí necesitan ver los pedidos de todos los clientes — antes de esta
// ruta, la app móvil no tenía ninguna forma segura de traer "mis pedidos":
// el único GET /pedidos disponible le habría devuelto el historial
// completo de TODOS los clientes a cualquiera con sesión iniciada.
pedRouter.get('/mis-pedidos', auth, async (req, res) => {
  try {
  const { rows } = await pool.query(
    `SELECT ped.*, l.nombre AS local_nombre, ped.comprobante_img AS "comprobanteImg"
       FROM pedidos ped LEFT JOIN locales l ON ped.local_id = l.id
       WHERE ped.cliente_id = $1 ORDER BY ped.id DESC`,
    [req.user.id]
  );
  const pedidos = await Promise.all(
    rows.map(async (p) => ({ ...p, productos: await enriquecerItemsPedido(p.items) }))
  );
  res.json(pedidos);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
pedRouter.get('/:id', auth, async (req, res) => {
  try {
  const { rows } = await pool.query(
    `SELECT ped.*, l.nombre AS local_nombre, ped.comprobante_img AS "comprobanteImg"
       FROM pedidos ped LEFT JOIN locales l ON ped.local_id = l.id
       WHERE ped.id=$1`,
    [req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Pedido no encontrado' });
  // Mismo criterio que GET / de abajo: un cliente autenticado solo puede
  // ver SUS PROPIOS pedidos — sin este chequeo, cualquier cliente podía
  // pedir el detalle de un pedido ajeno con solo adivinar/incrementar el
  // id (los id son consecutivos).
  if (req.user.rol === 'Cliente' && rows[0].cliente_id !== req.user.id) {
    return res.status(403).json({ error: 'No tienes permiso para ver este pedido.' });
  }
  // "productos": misma clave que ya usaba el frontend, ahora con "receta"
  // (fija, de fichas_tecnicas) y "personalizacion" (toppings/adiciones de
  // esa línea) separados en cada ítem — ver enriquecerItemsPedido.
  const productos = await enriquecerItemsPedido(rows[0].items);
  res.json({ ...rows[0], productos });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
pedRouter.post('/', async (req, res) => {
  const { cliente_id, numero, cliente, tipo, pago, mesa, total, items, comprobante, comprobante_img, origen, direccion_alternativa, hora, estado, barista, domiciliario, sede, local_id, _meta } = req.body;
  // Compatibilidad: si vienen en _meta los usamos también
  const meta = _meta || {};
  const comprobanteImgFinal = comprobante_img || meta.comprobanteImg || null;
  const pagoFinal = normalizarPago(pago || meta.pago || null);
  if (metodoPagoInvalido(pagoFinal)) {
    return res.status(400).json({ error: `Método de pago inválido. Debe ser uno de: ${METODOS_PAGO_VALIDOS.join(', ')}.` });
  }
  // local_id solo tiene sentido cuando el tipo de entrega es 'local'
  // ("recoger en el local") — para cualquier otro tipo (ej. 'domicilio')
  // se ignora, aunque llegue en el body. Ver GET /api/locales.
  const tipoFinal = tipo || meta.tipo || null;
  const localIdFinal = tipoFinal === 'local' ? (local_id ?? meta.local_id ?? null) : null;
  try {
    if (tipoFinal === 'local') {
      if (!localIdFinal) {
        return res.status(400).json({ error: 'Debes indicar el local donde vas a recoger el pedido.' });
      }
      const { rows: localValido } = await pool.query(
        `SELECT id FROM locales WHERE id=$1 AND estado='Activo'`, [localIdFinal]
      );
      if (!localValido[0]) {
        return res.status(400).json({ error: 'El local seleccionado no existe o no está activo.' });
      }
    }

    // Evitar que el mismo pantallazo de pago se use para más de un pedido.
    // Se calcula un hash (SHA-256) del contenido de la imagen — no del
    // nombre de archivo, que se puede cambiar fácilmente — y se compara
    // contra los comprobantes ya recibidos en pedidos que siguen vigentes
    // (no cancelados). Si ya existe, se rechaza antes de tocar la base.
    let comprobanteHash = null;
    if (comprobanteImgFinal) {
      comprobanteHash = crypto.createHash('sha256').update(comprobanteImgFinal).digest('hex');
      const { rows: dup } = await pool.query(
        `SELECT id FROM pedidos WHERE comprobante_hash = $1 AND estado <> 'cancelado' LIMIT 1`,
        [comprobanteHash]
      );
      if (dup[0]) {
        return res.status(409).json({
          error: 'Este comprobante ya fue usado en otro pedido. Cada comprobante de pago solo se puede usar una vez.',
          pedidoExistente: dup[0].id,
        });
      }
    }

    // El pago se confirma en el backend, nunca lo decide el cliente que
    // crea el pedido: si trae comprobante de transferencia, SIEMPRE queda
    // 'pendiente_verificacion' hasta que el cajero lo apruebe (ver PATCH
    // /:id/comprobante/aprobar) — pisa cualquier "estado" que hubiera
    // mandado el body. Sin comprobante (efectivo/pago en el local), se usa
    // el estado que mande el cliente o 'pendiente' por defecto, pero el
    // pago igual queda sin confirmar (pago_confirmado=false) hasta que el
    // cajero lo confirme a mano (ver PATCH /:id/confirmar-pago) — sin eso,
    // el pedido no puede pasar a 'en_proceso' (preparación).
    const estadoInicial = comprobanteImgFinal ? 'pendiente_verificacion' : (estado || meta.estado || 'pendiente');

    const { rows } = await pool.query(
      `INSERT INTO pedidos(cliente_id,numero,cliente,tipo,pago,mesa,total,items,comprobante,comprobante_img,comprobante_hash,origen,direccion_alternativa,hora,estado,barista,domiciliario,sede,local_id)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING *`,
      [
        cliente_id || null,
        numero || meta.numero || null,
        cliente || meta.cliente || null,
        tipoFinal,
        pagoFinal,
        mesa || null,
        total || 0,
        JSON.stringify(items || []),
        comprobante || meta.comprobante || null,
        comprobanteImgFinal,
        comprobanteHash,
        origen || meta.origen || 'landing',
        direccion_alternativa || meta.direccionAlternativa || null,
        hora || meta.hora || null,
        estadoInicial,
        // "Atendido por" y "domiciliario" — antes se descartaban porque no
        // existía la columna ni se leían del body en absoluto, así que se
        // perdían aunque el formulario del admin los pidiera y validara.
        barista || meta.barista || null,
        domiciliario || meta.domiciliario || null,
        // Local al que pertenece el pedido. Lo manda el cajero (su propio
        // local, tomado de su sesión) o el admin (lo elige en el
        // formulario). Si no llega ninguno y el pedido viene de la tienda
        // (origen 'landing'), queda sin local asignado (NULL) — es un
        // pedido de cliente aún no reclamado por ningún local (ver PATCH
        // /pedidos/:id/tomar). Si no llega ninguno y el origen NO es
        // 'landing' (caso raro), se mantiene 'Local 1' como fallback.
        (() => {
          const sedeFinal = sede || meta.sede || null;
          if (sedeFinal) return sedeFinal;
          const origenFinal = origen || meta.origen || 'landing';
          return origenFinal === 'landing' ? null : 'Local 1';
        })(),
        localIdFinal,
      ]
    );
    res.status(201).json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Edición de un pedido existente (cliente, tipo de entrega, método de pago,
// productos/total, personal asignado, dirección). Antes este endpoint no
// existía: el módulo permitía crear, cambiar estado y "detener" un pedido,
// pero no corregir un pedido ya creado.
pedRouter.put('/:id', auth, async (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: 'ID de pedido inválido' });
  const { cliente, tipo, pago, total, items, barista, domiciliario, direccion_alternativa, sede, local_id } = req.body;
  const pagoFinal = normalizarPago(pago);
  if (metodoPagoInvalido(pagoFinal)) {
    return res.status(400).json({ error: `Método de pago inválido. Debe ser uno de: ${METODOS_PAGO_VALIDOS.join(', ')}.` });
  }
  try {
    // Igual que en POST: si mandan local_id, tiene que ser un local activo
    // real (no se valida acá si tipo='local' porque PUT es una edición
    // parcial — tipo puede no venir en este body).
    if (local_id != null) {
      const { rows: localValido } = await pool.query(
        `SELECT id FROM locales WHERE id=$1 AND estado='Activo'`, [local_id]
      );
      if (!localValido[0]) {
        return res.status(400).json({ error: 'El local seleccionado no existe o no está activo.' });
      }
    }
    const { rows } = await pool.query(
      `UPDATE pedidos SET
         cliente = COALESCE($1, cliente),
         tipo    = COALESCE($2, tipo),
         pago    = COALESCE($3, pago),
         total   = COALESCE($4, total),
         items   = COALESCE($5, items),
         barista = COALESCE($6, barista),
         domiciliario = COALESCE($7, domiciliario),
         direccion_alternativa = COALESCE($8, direccion_alternativa),
         sede = COALESCE($9, sede),
         local_id = COALESCE($10, local_id)
       WHERE id=$11 RETURNING *`,
      [
        cliente ?? null,
        tipo ?? null,
        pagoFinal,
        total ?? null,
        items ? JSON.stringify(items) : null,
        barista ?? null,
        domiciliario ?? null,
        direccion_alternativa ?? null,
        sede ?? null,
        local_id ?? null,
        id,
      ]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Pedido no encontrado' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Cambia el estado de un pedido respetando el flujo real: no se puede
// retroceder a un estado anterior de ESTADOS_PEDIDO_ORDEN (se compara por
// índice: el nuevo debe ser >= al actual — sí permite saltar pasos hacia
// adelante), y no se puede entrar a 'en_proceso' (preparación) —ni a nada
// posterior— sin el pago confirmado. 'cancelado' es la única excepción a
// la regla de avance: se puede dar en cualquier momento antes de
// 'entregado', sin importar el estado actual.
pedRouter.patch('/:id/estado', auth, async (req, res) => {
  const { estado } = req.body;
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: 'ID de pedido inválido' });
  if (estado !== 'cancelado' && !ESTADOS_PEDIDO_ORDEN.includes(estado)) {
    return res.status(400).json({ error: `Estado inválido: "${estado}"` });
  }
  try {
    const { rows: actual } = await pool.query('SELECT estado, pago, pago_confirmado FROM pedidos WHERE id=$1', [id]);
    if (!actual[0]) return res.status(404).json({ error: 'Pedido no encontrado' });
    const estadoActual = actual[0].estado;

    if (estadoActual === 'entregado') {
      return res.status(400).json({ error: 'Este pedido ya fue entregado y no puede cambiar de estado.' });
    }
    if (estadoActual === 'cancelado') {
      return res.status(400).json({ error: 'Este pedido está cancelado y no puede cambiar de estado.' });
    }

    if (estado === 'cancelado') {
      // Siempre permitido en este punto: ya se descartó 'entregado' arriba.
    } else {
      const idxActual = ESTADOS_PEDIDO_ORDEN.indexOf(estadoActual);
      const idxNuevo  = ESTADOS_PEDIDO_ORDEN.indexOf(estado);
      // Si el estado actual no está en la secuencia conocida (dato legado
      // o valor exótico ya guardado antes de esta validación), no se puede
      // comparar por índice — se deja pasar en vez de bloquear el pedido
      // para siempre.
      if (idxActual !== -1 && idxNuevo < idxActual) {
        return res.status(400).json({ error: `No se puede retroceder de "${estadoActual}" a "${estado}".` });
      }
      // El pago debe estar confirmado antes de entrar a preparación (o a
      // cualquier estado posterior, si el cambio salta pasos) — PERO solo
      // para pago por transferencia (nequi/transferencia), que depende de
      // que el cajero apruebe el comprobante (ver PATCH
      // /:id/comprobante/aprobar). En efectivo el cobro se confirma en
      // persona al momento de la entrega, no por comprobante, así que no
      // aplica ninguna restricción de pago acá — el cajero mueve el
      // estado libremente. esEfectivo() compara sin importar mayúsculas/
      // minúsculas (bug confirmado: 'pago' se guarda en minúscula, pero
      // esta condición comparaba contra 'Efectivo' con mayúscula, así que
      // NUNCA coincidía y todo pedido en efectivo quedaba bloqueado igual
      // que uno por transferencia).
      if (idxNuevo >= IDX_EN_PROCESO && !esEfectivo(actual[0].pago) && !actual[0].pago_confirmado) {
        return res.status(400).json({ error: 'El comprobante de pago debe ser aprobado antes de pasar a preparación.' });
      }
    }

    const { rows } = await pool.query('UPDATE pedidos SET estado=$1 WHERE id=$2 RETURNING *', [estado, id]);
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// El cajero puede marcar el cobro de un pedido como confirmado a mano —
// pensado originalmente para efectivo/pago en el local, sin comprobante
// que aprobar. Nota: desde que el pago en efectivo quedó exento del todo
// de la validación de "pago confirmado" en PATCH /:id/estado (ver más
// arriba: pago='Efectivo' nunca bloquea el avance de estado), llamar esta
// ruta para un pedido en efectivo ya NO es necesario para poder avanzarlo
// — queda como confirmación opcional a mano, útil solo si se quiere dejar
// registro explícito de que el cajero cobró. Para pedidos con comprobante
// de transferencia (Nequi/Bancolombia) se sigue usando
// /comprobante/aprobar, que además de confirmar el pago avanza el estado.
pedRouter.patch('/:id/confirmar-pago', auth, permitirRoles('Cajero', 'Administrador'), async (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: 'ID de pedido inválido' });
  try {
    const { rows } = await pool.query(
      `UPDATE pedidos SET pago_confirmado = TRUE WHERE id=$1 AND estado NOT IN ('cancelado','entregado') RETURNING *`,
      [id]
    );
    if (!rows[0]) {
      const { rows: existente } = await pool.query('SELECT id FROM pedidos WHERE id=$1', [id]);
      if (!existente[0]) return res.status(404).json({ error: 'Pedido no encontrado' });
      return res.status(400).json({ error: 'Este pedido está cancelado o ya entregado, no se puede confirmar el pago.' });
    }
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Aprobar/rechazar el comprobante de transferencia (Nequi/Bancolombia) de
// un pedido en 'pendiente_verificacion'. Aprobar confirma el pago y avanza
// a 'pendiente' (ya puede empezar a prepararse en cuanto el cajero mueva
// el estado); rechazar cancela el pedido de una vez — el cliente tendría
// que volver a hacer el pedido con un comprobante válido.
//
// Un pedido en efectivo NUNCA debería llegar a 'pendiente_verificacion'
// (POST /pedidos solo pone ese estado cuando hay comprobante adjunto), así
// que en la práctica esta ruta ya quedaba fuera de su alcance para
// efectivo. Se agrega igual un rechazo explícito por pago='Efectivo' —con
// un mensaje que dice por qué, en vez del genérico "no tiene comprobante
// pendiente"— para que quede a prueba de futuros cambios de flujo y para
// que el frontend tenga una señal clara de cuándo estos botones no
// aplican (pago efectivo usa /confirmar-pago en su lugar).
pedRouter.patch('/:id/comprobante/aprobar', auth, permitirRoles('Cajero', 'Administrador'), async (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: 'ID de pedido inválido' });
  try {
    const { rows: actual } = await pool.query('SELECT estado, pago FROM pedidos WHERE id=$1', [id]);
    if (!actual[0]) return res.status(404).json({ error: 'Pedido no encontrado' });
    if (esEfectivo(actual[0].pago)) {
      return res.status(400).json({ error: 'Los pedidos en efectivo no requieren aprobación de comprobante — usa PATCH /:id/confirmar-pago.' });
    }
    if (actual[0].estado !== 'pendiente_verificacion') {
      return res.status(400).json({ error: 'Este pedido no tiene un comprobante pendiente de verificación.' });
    }
    const { rows } = await pool.query(
      `UPDATE pedidos SET estado = 'pendiente', pago_confirmado = TRUE WHERE id=$1 RETURNING *`,
      [id]
    );
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
pedRouter.patch('/:id/comprobante/rechazar', auth, permitirRoles('Cajero', 'Administrador'), async (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: 'ID de pedido inválido' });
  const { motivo } = req.body;
  try {
    const { rows: actual } = await pool.query('SELECT estado, pago FROM pedidos WHERE id=$1', [id]);
    if (!actual[0]) return res.status(404).json({ error: 'Pedido no encontrado' });
    if (esEfectivo(actual[0].pago)) {
      return res.status(400).json({ error: 'Los pedidos en efectivo no tienen comprobante que rechazar.' });
    }
    if (actual[0].estado !== 'pendiente_verificacion') {
      return res.status(400).json({ error: 'Este pedido no tiene un comprobante pendiente de verificación.' });
    }
    const { rows } = await pool.query(
      `UPDATE pedidos SET estado = 'cancelado', comprobante_motivo_rechazo = $1 WHERE id=$2 RETURNING *`,
      [motivo || null, id]
    );
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Un cajero/bartender de un local específico "toma" (reclama) un pedido de
// cliente que todavía no tiene local asignado (sede IS NULL). El UPDATE es
// atómico en una sola consulta (WHERE sede IS NULL en el mismo UPDATE, sin
// SELECT previo) para que, si dos locales intentan tomarlo casi al mismo
// tiempo, Postgres garantice que solo uno de los dos lo consiga.
pedRouter.patch('/:id/tomar', auth, async (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: 'ID de pedido inválido' });
  const miSede = req.user.sede;
  if (!miSede || miSede === 'Ambos') {
    return res.status(403).json({ error: 'Un Administrador no puede tomar pedidos para un local específico.' });
  }
  try {
    const { rows } = await pool.query(
      'UPDATE pedidos SET sede=$1 WHERE id=$2 AND sede IS NULL RETURNING *',
      [miSede, id]
    );
    if (!rows[0]) {
      const { rows: existente } = await pool.query('SELECT sede FROM pedidos WHERE id=$1', [id]);
      if (!existente[0]) return res.status(404).json({ error: 'Pedido no encontrado' });
      return res.status(409).json({ error: `Este pedido ya fue tomado por ${existente[0].sede}` });
    }
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
pedRouter.delete('/:id', auth, async (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: 'ID de pedido inválido' });
  try {
    await pool.query('DELETE FROM pedidos WHERE id=$1', [id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
r.use('/pedidos', pedRouter);

// ── VENTAS ─────────────────────────────────────────────────
const ventRouter = require('express').Router();
// El frontend (Ventas, Devoluciones, Dashboard, Cajero, Landing) espera que
// cada venta traiga: id_venta, id_pedido, cliente, fecha, metodo_pago,
// tipo_venta, productos y estado en minúscula ('vendido' / 'devuelto').
// Esos datos no vivían todos en la tabla `ventas`: cliente/método de
// pago/tipo/productos se derivan del pedido asociado mediante el JOIN.
const VENTA_SELECT = `
  SELECT
    v.id,
    v.id                              AS id_venta,
    v.pedido_id,
    v.pedido_id                       AS id_pedido,
    p.cliente,
    v.created_at                      AS fecha,
    v.total,
    p.pago                            AS metodo_pago,
    p.tipo                            AS tipo_venta,
    v.estado,
    p.mesa,
    p.sede,
    COALESCE(p.items, '[]'::jsonb)    AS productos
  FROM ventas v
  LEFT JOIN pedidos p ON v.pedido_id = p.id
`;
// Filtro opcional por local (?sede=Local 1 / Local 2), igual que en
// /pedidos: el cajero/bartender de un local solo debe ver sus propias
// ventas, y el Administrador puede acotar la vista de Administración a un
// local específico sin dejar de ver "Todos" cuando no manda el parámetro.
ventRouter.get('/', auth, async (req, res) => {
  try {
  const { sede } = req.query;
  const params = [];
  let where = '';
  if (sede) { params.push(sede); where = 'WHERE p.sede = $1'; }
  const { rows } = await pool.query(`${VENTA_SELECT} ${where} ORDER BY v.id DESC`, params);
  res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
ventRouter.get('/stats', auth, async (req, res) => {
  try {
  const { rows } = await pool.query(
    `SELECT COUNT(*) as total,
            COUNT(*) FILTER (WHERE estado='vendido')  as vendido,
            COUNT(*) FILTER (WHERE estado='devuelto') as devuelto,
            COALESCE(SUM(total) FILTER (WHERE estado='vendido'),0) as ingresos
     FROM ventas`
  );
  res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
ventRouter.get('/:id', auth, async (req, res) => {
  try {
  const { rows } = await pool.query(`${VENTA_SELECT} WHERE v.id=$1`, [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'No encontrada' });
  res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
ventRouter.post('/desde-pedido', auth, async (req, res) => {
  try {
    // Accept either id_pedido number or full pedido object
    let id_pedido = req.body.id_pedido;
    if (typeof id_pedido === 'object' && id_pedido !== null) id_pedido = id_pedido.id;
    id_pedido = parseInt(id_pedido);
    if (isNaN(id_pedido)) return res.status(400).json({ error: 'ID de pedido inválido' });

    const { rows: ped } = await pool.query('SELECT * FROM pedidos WHERE id=$1', [id_pedido]);
    if (!ped[0]) return res.status(404).json({ error: 'Pedido no encontrado' });

    // Crear la venta (registro contable/de inventario) es independiente
    // del estado del PEDIDO — antes esta ruta forzaba estado='entregado'
    // acá mismo, así que un pedido marcado "Listo" (que dispara la
    // creación automática de su venta desde el frontend) saltaba directo
    // a "Entregado" sin pasar por "Listo" de verdad, rompiendo el flujo de
    // ESTADOS_PEDIDO_ORDEN. El pedido ahora se queda en el estado que el
    // usuario eligió explícitamente, y solo llega a 'entregado' cuando
    // alguien lo cambia desde PATCH /pedidos/:id/estado.
    // Descontar del inventario los insumos + el vaso de la ficha técnica de
    // cada producto vendido (ver descontarInventarioPorVenta arriba) sigue
    // pasando igual, sin cambios.
    await descontarInventarioPorVenta(ped[0].items);

    const { rows } = await pool.query(
      // Antes no se pasaba `estado`, así que la venta quedaba con el
      // default de la columna ('Activa'), un valor que ninguna pantalla
      // del frontend reconoce (todas comparan contra 'vendido'/'devuelto').
      // Eso hacía que la venta recién creada apareciera sin badge de estado
      // y el botón "Registrar devolución" nunca se mostrara.
      `INSERT INTO ventas(pedido_id, total, estado) VALUES($1,$2,'vendido') RETURNING *`,
      [id_pedido, ped[0].total]
    );
    const { rows: full } = await pool.query(`${VENTA_SELECT} WHERE v.id=$1`, [rows[0].id]);
    res.status(201).json(full[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});
ventRouter.patch('/:id/estado', auth, async (req, res) => {
  try {
  const { estado } = req.body;
  const { rows } = await pool.query('UPDATE ventas SET estado=$1 WHERE id=$2 RETURNING *', [estado, req.params.id]);
  res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
r.use('/ventas', ventRouter);

// ── DEVOLUCIONES ───────────────────────────────────────────
const devRouter = require('express').Router();
// El listado de Devoluciones (admin) necesita el nombre del cliente y el
// número de venta asociada, que solo se pueden sacar uniendo con pedidos/
// ventas. Antes se hacía un SELECT * plano y el frontend nunca podía
// mostrar el cliente ni cruzar la devolución con su venta.
const DEV_SELECT = `
  SELECT
    d.id,
    d.id                       AS id_dev,
    d.pedido_id,
    p.cliente,
    p.sede,
    v.id                       AS id_venta,
    d.motivo,
    d.tipo,
    d.monto,
    d.estado,
    d.items                    AS productos_devueltos,
    d.created_at                AS fecha
  FROM devoluciones d
  LEFT JOIN pedidos p ON d.pedido_id = p.id
  LEFT JOIN ventas  v ON v.pedido_id = d.pedido_id
`;
// Mismo filtro opcional por local que /ventas (ver comentario arriba).
devRouter.get('/', auth, async (req, res) => {
  try {
  const { sede } = req.query;
  const params = [];
  let where = '';
  if (sede) { params.push(sede); where = 'WHERE p.sede = $1'; }
  const { rows } = await pool.query(`${DEV_SELECT} ${where} ORDER BY d.id DESC`, params);
  res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
devRouter.post('/', auth, async (req, res) => {
  try {
  // Antes no se leía `tipo` (total/parcial) del body ni existía la columna
  // en la tabla, así que toda devolución se mostraba como "Parcial" sin
  // importar lo que el usuario hubiera elegido.
  const { pedido_id, motivo, monto, items, tipo } = req.body;
  if (!pedido_id) return res.status(400).json({ error: 'pedido_id es requerido' });
  const { rows } = await pool.query(
    // El default de la columna quedó en 'Pendiente' (con mayúscula) pero
    // todo el frontend compara contra 'pendiente' en minúscula; sin este
    // INSERT explícito la devolución recién creada no coincidía con
    // ningún filtro ni mostraba los botones de aprobar/rechazar.
    `INSERT INTO devoluciones(pedido_id,motivo,monto,items,tipo,estado)
     VALUES($1,$2,$3,$4,$5,'pendiente') RETURNING id`,
    [pedido_id, motivo, monto || 0, JSON.stringify(items || []), tipo || 'total']
  );
  const { rows: full } = await pool.query(`${DEV_SELECT} WHERE d.id=$1`, [rows[0].id]);
  res.status(201).json(full[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
devRouter.patch('/:id/estado', auth, async (req, res) => {
  try {
  const estado = (req.body.estado || '').toLowerCase();
  if (!['pendiente','aprobada','rechazada'].includes(estado)) {
    return res.status(400).json({ error: 'Estado inválido' });
  }
  const { rows } = await pool.query('UPDATE devoluciones SET estado=$1 WHERE id=$2 RETURNING *', [estado, req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Devolución no encontrada' });

  // La UI le informa al usuario que aprobar/rechazar una devolución
  // actualiza automáticamente el estado de la venta. Antes esto nunca
  // pasaba: solo se tocaba la fila de `devoluciones`, así que la venta
  // se quedaba "vendida" para siempre aunque la devolución estuviera
  // aprobada.
  if (rows[0].pedido_id) {
    const nuevoEstadoVenta = estado === 'aprobada' ? 'devuelto' : 'vendido';
    await pool.query('UPDATE ventas SET estado=$1 WHERE pedido_id=$2', [nuevoEstadoVenta, rows[0].pedido_id]);
  }

  const { rows: full } = await pool.query(`${DEV_SELECT} WHERE d.id=$1`, [rows[0].id]);
  res.json(full[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
r.use('/devoluciones', devRouter);

// ── FICHAS TÉCNICAS ────────────────────────────────────────
// ── FICHAS TÉCNICAS ─────────────────────────────────────────
// El formulario (ModalFichaForm en FichasTecnicasPage) maneja bastante más
// que producto/ingredientes: categoría de preparación, porciones, tiempo,
// costo estimado, estado activo/inactivo, notas, resumen, preparación paso
// a paso, el vaso usado, y la lista de insumos con cantidad/unidad. Los
// alias de abajo devuelven exactamente esos nombres (id_producto, insumos,
// fecha_registro, etc.) para que coincidan con lo que ya lee React.
// f.toppings_ficha AS toppings: [{ topping_id, cantidad }] — cuánto de cada
// topping asociado a este producto se usa específicamente en él (puede ser
// distinto al "cantidad" por defecto del topping). Ver
// descontarInventarioPorVenta más abajo, que la usa para saber cuánto
// descontar del insumo del topping al confirmarse un pedido.
const FICHA_COLS = `
  SELECT f.id, f.producto_id AS id_producto, p.nombre AS producto_nombre,
    f.categoria_prep, f.porciones, f.tiempo_prep, f.costo_estimado, f.estado,
    f.notas, f.resumen_prep, f.preparacion, f.vaso_id,
    f.ingredientes AS insumos, f.toppings_ficha AS toppings, f.created_at AS fecha_registro
  FROM fichas_tecnicas f LEFT JOIN productos p ON f.producto_id = p.id
`;

// El costo estimado de producción nunca puede superar el precio de venta
// del producto. Antes esto solo se validaba en el formulario (React) — una
// petición directa a la API (o un cliente desactualizado) podía guardar
// una ficha inconsistente sin que nada del lado del servidor lo impidiera.
// Se usa desde POST y PUT para no duplicar la consulta/comparación.
const costoEstimadoSuperaPrecio = async (idProducto, costoEstimado) => {
  if (!idProducto || costoEstimado === undefined || costoEstimado === null) return false;
  const { rows } = await pool.query('SELECT precio FROM productos WHERE id=$1', [idProducto]);
  if (!rows[0]) return false;
  return Number(costoEstimado) > Number(rows[0].precio);
};

// Ya existe una ficha técnica activa para ese producto (ver el índice único
// parcial fichas_tecnicas_producto_activo_uidx en config/db.js/schema.sql).
// Se valida aparte, antes del INSERT, para poder devolver un 400 con un
// mensaje claro en vez de que el usuario se encuentre con un 500 genérico
// de violación de restricción única. excluirId se usa desde el PUT: al
// editar una ficha no debe chocar contra sí misma.
const existeFichaActivaParaProducto = async (idProducto, excluirId) => {
  if (!idProducto) return false;
  const { rows } = await pool.query(
    `SELECT id FROM fichas_tecnicas WHERE producto_id=$1 AND estado=true AND id <> COALESCE($2, -1)`,
    [idProducto, excluirId || null]
  );
  return rows.length > 0;
};

const fichaRouter = require('express').Router();
fichaRouter.get('/', auth, async (req, res) => {
  try {
  const { rows } = await pool.query(`${FICHA_COLS} ORDER BY f.id DESC`);
  res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
fichaRouter.get('/:id', auth, async (req, res) => {
  try {
  const { rows } = await pool.query(`${FICHA_COLS} WHERE f.id=$1`, [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Ficha técnica no encontrada' });
  res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
fichaRouter.post('/', auth, async (req, res) => {
  try {
  const {
    id_producto, categoria_prep, porciones, tiempo_prep, costo_estimado,
    estado, notas, resumen_prep, preparacion, vaso_id, insumos, toppings,
  } = req.body;
  if (await costoEstimadoSuperaPrecio(id_producto, costo_estimado)) {
    return res.status(400).json({ error: 'El costo estimado supera el valor de venta del producto.' });
  }
  const estadoNuevo = estado !== undefined ? estado : true;
  if (estadoNuevo && await existeFichaActivaParaProducto(id_producto)) {
    return res.status(400).json({ error: 'Ya existe una ficha técnica activa para este producto. Edítala en vez de crear una nueva.' });
  }
  const { rows } = await pool.query(
    `INSERT INTO fichas_tecnicas
       (producto_id,categoria_prep,porciones,tiempo_prep,costo_estimado,estado,notas,resumen_prep,preparacion,vaso_id,ingredientes,toppings_ficha)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
    [
      id_producto || null, categoria_prep || 'Caliente', porciones || 1, tiempo_prep || 5,
      costo_estimado || 0, estadoNuevo, notas || null,
      resumen_prep || null, preparacion || null, vaso_id || null, JSON.stringify(insumos || []),
      JSON.stringify(toppings || []),
    ]
  );
  const { rows: full } = await pool.query(`${FICHA_COLS} WHERE f.id=$1`, [rows[0].id]);
  res.status(201).json(full[0]);
  } catch (e) {
    // Red de seguridad ante una condición de carrera (dos peticiones POST
    // casi simultáneas pasan la verificación de arriba antes de que
    // cualquiera de las dos inserte): el índice único parcial de la base
    // de datos (fichas_tecnicas_producto_activo_uidx) es la última línea
    // de defensa, y su violación se traduce en el mismo 400 claro en vez
    // de un 500 genérico.
    if (e.code === '23505') {
      return res.status(400).json({ error: 'Ya existe una ficha técnica activa para este producto. Edítala en vez de crear una nueva.' });
    }
    res.status(500).json({ error: e.message });
  }
});
fichaRouter.put('/:id', auth, async (req, res) => {
  try {
  const {
    id_producto, categoria_prep, porciones, tiempo_prep, costo_estimado,
    estado, notas, resumen_prep, preparacion, vaso_id, insumos, toppings,
  } = req.body;
  if (await costoEstimadoSuperaPrecio(id_producto, costo_estimado)) {
    return res.status(400).json({ error: 'El costo estimado supera el valor de venta del producto.' });
  }
  const estadoNuevo = estado !== undefined ? estado : true;
  if (estadoNuevo && await existeFichaActivaParaProducto(id_producto, req.params.id)) {
    return res.status(400).json({ error: 'Ya existe una ficha técnica activa para este producto. Edítala en vez de crear una nueva.' });
  }
  const { rows } = await pool.query(
    `UPDATE fichas_tecnicas SET
       producto_id=$1, categoria_prep=$2, porciones=$3, tiempo_prep=$4, costo_estimado=$5,
       estado=$6, notas=$7, resumen_prep=$8, preparacion=$9, vaso_id=$10, ingredientes=$11, toppings_ficha=$12
     WHERE id=$13 RETURNING id`,
    [
      id_producto || null, categoria_prep || 'Caliente', porciones || 1, tiempo_prep || 5,
      costo_estimado || 0, estadoNuevo, notas || null,
      resumen_prep || null, preparacion || null, vaso_id || null, JSON.stringify(insumos || []),
      JSON.stringify(toppings || []),
      req.params.id,
    ]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Ficha técnica no encontrada' });
  const { rows: full } = await pool.query(`${FICHA_COLS} WHERE f.id=$1`, [req.params.id]);
  res.json(full[0]);
  } catch (e) {
    if (e.code === '23505') {
      return res.status(400).json({ error: 'Ya existe una ficha técnica activa para este producto. Edítala en vez de crear una nueva.' });
    }
    res.status(500).json({ error: e.message });
  }
});
// El botón de "Activar/Inactivar" del listado llama a esta ruta — antes no
// existía y cada clic fallaba con 404.
fichaRouter.patch('/:id/estado', auth, async (req, res) => {
  try {
  // Reactivar una ficha inactiva puede chocar con la que ya esté activa
  // para el mismo producto (mismo índice único parcial que POST/PUT) — se
  // valida antes del UPDATE para devolver el mismo 400 claro.
  const { rows: actual } = await pool.query(
    'SELECT producto_id, estado FROM fichas_tecnicas WHERE id=$1', [req.params.id]
  );
  if (!actual[0]) return res.status(404).json({ error: 'Ficha técnica no encontrada' });
  const vaAQuedarActiva = !actual[0].estado;
  if (vaAQuedarActiva && await existeFichaActivaParaProducto(actual[0].producto_id, req.params.id)) {
    return res.status(400).json({ error: 'Ya existe una ficha técnica activa para este producto. Edítala en vez de crear una nueva.' });
  }
  const { rows } = await pool.query(
    `UPDATE fichas_tecnicas SET estado = NOT estado WHERE id=$1 RETURNING id`,
    [req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Ficha técnica no encontrada' });
  const { rows: full } = await pool.query(`${FICHA_COLS} WHERE f.id=$1`, [req.params.id]);
  res.json(full[0]);
  } catch (e) {
    if (e.code === '23505') {
      return res.status(400).json({ error: 'Ya existe una ficha técnica activa para este producto. Edítala en vez de crear una nueva.' });
    }
    res.status(500).json({ error: e.message });
  }
});
fichaRouter.delete('/:id', auth, async (req, res) => {
  try {
  await pool.query('DELETE FROM fichas_tecnicas WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
r.use('/fichas-tecnicas', fichaRouter);

// ── DISPONIBILIDAD (pública) ─────────────────────────────────
// El Landing (tienda de cara al cliente) necesita saber cuántas unidades de
// cada producto se pueden vender según el inventario real — pero /insumos y
// /fichas-tecnicas viven detrás de `auth` porque exponen costos, proveedores
// y recetas completas, datos que un visitante sin sesión no debe ver. Esta
// ruta es la única forma pública de consultar disponibilidad: hace el mismo
// cálculo que ya hacía el frontend (maxDisponible en Landing.jsx) pero del
// lado del servidor, y solo devuelve { id_producto, stock_disponible }.
//
// Un producto SIN ficha técnica activa, o con una ficha sin insumos
// registrados, no tiene límite conocido — se omite del arreglo (en vez de
// mandar null/Infinity) para que el contrato de la respuesta sea siempre
// un número real. El frontend debe interpretar "producto ausente de esta
// lista" como "sin límite de stock".
const dispRouter = require('express').Router();
dispRouter.get('/', async (req, res) => {
  try {
    const { rows: fichas } = await pool.query(
      `SELECT producto_id, ingredientes FROM fichas_tecnicas WHERE estado = true`
    );
    // Solo id + stock: nunca precio_unitario, proveedor_id ni nada más de
    // la tabla insumos llega a esta respuesta.
    const { rows: insumos } = await pool.query(`SELECT id, stock FROM insumos`);
    const stockPorInsumo = new Map(insumos.map(i => [String(i.id), Number(i.stock) || 0]));

    const disponibilidad = [];
    for (const ficha of fichas) {
      const ingredientes = Array.isArray(ficha.ingredientes) ? ficha.ingredientes : [];
      if (ingredientes.length === 0) continue; // sin receta = sin límite conocido

      let max = Infinity;
      for (const ing of ingredientes) {
        const porUnidad = Number(ing.cantidad) || 0;
        if (porUnidad <= 0) continue; // dato de receta inválido, no debe tumbar el cálculo
        // Insumo eliminado o sin stock registrado: se trata como 0
        // disponibles (mejor subestimar el stock que vender de más).
        const stockInsumo = stockPorInsumo.get(String(ing.id_insumo)) ?? 0;
        const disponibles = Math.floor(stockInsumo / porUnidad);
        if (disponibles < max) max = disponibles;
      }
      if (max === Infinity) continue; // ningún ingrediente tenía cantidad válida
      disponibilidad.push({ id_producto: ficha.producto_id, stock_disponible: max });
    }

    res.json(disponibilidad);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
r.use('/disponibilidad', dispRouter);

// ── LOCALES (pública) ─────────────────────────────────────────
// Lista de locales físicos donde un cliente puede elegir "recoger en el
// local" al hacer el pedido (tipo = 'local' — ver POST /pedidos más abajo).
// Pública porque el checkout del Landing la necesita antes de que el
// cliente inicie sesión. Solo locales activos, y solo lo que hace falta
// mostrar en un selector (nombre/dirección) — nunca "estado" ni nada más.
const localRouter = require('express').Router();
localRouter.param('id', validateId); // valida :id (numérico) antes de las rutas de abajo
localRouter.get('/', async (req, res) => {
  try {
  const { rows } = await pool.query(
    `SELECT id, nombre, direccion FROM locales WHERE estado='Activo' ORDER BY id`
  );
  res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Administración de locales — solo Administrador, a diferencia del resto
// de este módulo (público). "/todos" antes de cualquier ruta con :id para
// que Express no intente interpretarlo como un id.
localRouter.get('/todos', auth, permitirRoles('Administrador'), async (req, res) => {
  try {
  const { rows } = await pool.query(`SELECT * FROM locales ORDER BY id`);
  res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
localRouter.post('/', auth, permitirRoles('Administrador'), async (req, res) => {
  try {
  const { nombre, direccion } = req.body;
  if (!nombre || !nombre.trim()) return res.status(400).json({ error: 'El nombre es obligatorio.' });
  const { rows } = await pool.query(
    `INSERT INTO locales(nombre, direccion) VALUES($1,$2) RETURNING *`,
    [nombre, direccion || null]
  );
  res.status(201).json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
localRouter.put('/:id', auth, permitirRoles('Administrador'), async (req, res) => {
  try {
  const { nombre, direccion } = req.body;
  if (!nombre || !nombre.trim()) return res.status(400).json({ error: 'El nombre es obligatorio.' });
  const { rows } = await pool.query(
    `UPDATE locales SET nombre=$1, direccion=$2 WHERE id=$3 RETURNING *`,
    [nombre, direccion || null, req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Local no encontrado' });
  res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
localRouter.patch('/:id/estado', auth, permitirRoles('Administrador'), async (req, res) => {
  try {
  const { rows } = await pool.query(
    `UPDATE locales SET estado = CASE WHEN estado='Activo' THEN 'Inactivo' ELSE 'Activo' END WHERE id=$1 RETURNING *`,
    [req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Local no encontrado' });
  res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
r.use('/locales', localRouter);

// ── RESEÑAS ────────────────────────────────────────────────
const resenasRouter = require('express').Router();
resenasRouter.get('/', async (req, res) => {
  try {
  const { rows } = await pool.query(`SELECT r.*, c.nombre as cliente_nombre FROM resenas r LEFT JOIN clientes c ON r.cliente_id=c.id WHERE r.aprobada=true ORDER BY r.id DESC`);
  res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
resenasRouter.get('/todas', auth, async (req, res) => {
  try {
  const { rows } = await pool.query('SELECT r.*, c.nombre as cliente_nombre FROM resenas r LEFT JOIN clientes c ON r.cliente_id=c.id ORDER BY r.id DESC');
  res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
resenasRouter.post('/', async (req, res) => {
  try {
  const { cliente_id, texto, calificacion } = req.body;
  const { rows } = await pool.query(
    `INSERT INTO resenas(cliente_id,texto,calificacion) VALUES($1,$2,$3) RETURNING *`,
    [cliente_id || null, texto, calificacion || 5]
  );
  res.status(201).json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
resenasRouter.patch('/:id/aprobar', auth, async (req, res) => {
  try {
  const { rows } = await pool.query('UPDATE resenas SET aprobada=true WHERE id=$1 RETURNING *', [req.params.id]);
  res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
resenasRouter.delete('/:id', auth, async (req, res) => {
  try {
  await pool.query('DELETE FROM resenas WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
r.use('/resenas', resenasRouter);

module.exports = r;