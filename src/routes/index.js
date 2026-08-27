const express = require('express');
const crypto  = require('crypto');
const pool    = require('../config/db');
const { auth, permitirRoles } = require('../middleware/auth');
const bcrypt  = require('bcryptjs');
const crud    = require('./crud');
const validateId = require('../middleware/validateId');
const { passwordValida, PASSWORD_ERROR } = require('../config/passwordPolicy');
// Validaciones compartidas de texto: nombres vacíos / solo espacios,
// duplicados sin distinguir mayúsculas ni espacios de más, y topes de
// longitud. Ver config/validaciones.js.
const {
  textoLimpio, nombreNormalizado, LIMITES,
  errorNombre, errorLongitud, nombreDuplicado,
} = require('../config/validaciones');

const r = express.Router();

// ── ROLES ──────────────────────────────────────────────────
// Antes esto era un CRUD genérico (crud('roles', [...])), que no validaba
// absolutamente nada del lado del servidor — todas estas reglas (nombre
// obligatorio, solo letras/números/espacios, nombre único, al menos un
// permiso, no borrar un rol con usuarios asignados) solo existían en
// RolForm.jsx/RolesPage.jsx del frontend, así que se podían saltar por
// completo llamando la API directamente (ej. con curl/Postman). Este router
// propio replica esas mismas reglas acá.
//
// La tabla "roles" (ver schema.sql) ya tiene nombre, descripcion, permisos
// y created_at — los campos que pide la historia de usuario de "crear rol"
// además del nombre — así que no hace falta ninguna migración para este
// punto, solo las validaciones de abajo.
const ROL_NOMBRE_REGEX = /^[a-zA-Z0-9À-ÿñÑ\s]+$/;

// usuarios.rol NO es una FK al id de "roles": guarda el NOMBRE del rol como
// texto plano (ver usrRouter/empRouter más abajo, que siempre insertan
// "rol" con el nombre tal cual, nunca un id) — así que "¿hay usuarios con
// este rol?" se resuelve comparando por nombre (sin distinguir mayúsculas),
// no por una FK.
const contarUsuariosConRol = async (nombreRol) => {
  const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM usuarios WHERE lower(rol) = lower($1)`, [nombreRol]);
  return rows[0].n;
};

const rolNombreDuplicado = async (nombre, excluirId) => {
  const params = excluirId ? [nombre, excluirId] : [nombre];
  const cond = excluirId ? 'lower(nombre)=lower($1) AND id<>$2' : 'lower(nombre)=lower($1)';
  const { rows } = await pool.query(`SELECT id FROM roles WHERE ${cond} LIMIT 1`, params);
  return !!rows[0];
};

// Mismas reglas que el formulario del frontend, para POST y PUT:
//   - nombre obligatorio (no solo espacios)
//   - nombre solo letras/números/espacios (con acentos y ñ)
//   - permisos: array con al menos un elemento
// La duplicidad del nombre se revisa aparte (necesita await a la base de
// datos, y en el PUT necesita excluir el propio id).
const validarRolBody = (body) => {
  const nombre = String(body.nombre ?? '').trim();
  if (!nombre) return 'El nombre del rol es obligatorio.';
  if (!ROL_NOMBRE_REGEX.test(nombre)) return 'El nombre del rol solo puede contener letras, números y espacios.';
  if (!Array.isArray(body.permisos) || body.permisos.length === 0) return 'Selecciona al menos un permiso.';
  return null;
};

const rolRouter = require('express').Router();
rolRouter.param('id', validateId); // valida :id (numérico) antes de las rutas de abajo
rolRouter.get('/', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM roles ORDER BY id DESC');
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
rolRouter.get('/:id', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM roles WHERE id=$1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'No encontrado' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
rolRouter.post('/', auth, async (req, res) => {
  try {
    const errorValidacion = validarRolBody(req.body);
    if (errorValidacion) return res.status(400).json({ error: errorValidacion });
    const nombre = String(req.body.nombre).trim();
    if (await rolNombreDuplicado(nombre, null)) {
      return res.status(400).json({ error: 'Ya existe un rol con ese nombre.' });
    }
    // BUG CORREGIDO: "color" llegaba en req.body (RolFormPage.jsx sí lo
    // manda) pero nunca se leía ni se incluía en el INSERT — se descartaba
    // en silencio y todo rol nuevo quedaba con color=NULL, cayendo siempre
    // al azul por defecto en el listado (RolesPage.jsx -> getColor()).
    const { rows } = await pool.query(
      'INSERT INTO roles(nombre, descripcion, permisos, color) VALUES($1,$2,$3,$4) RETURNING *',
      [nombre, req.body.descripcion || null, JSON.stringify(req.body.permisos), req.body.color || null]
    );
    res.status(201).json(rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ error: 'Ya existe un rol con ese nombre.' });
    res.status(500).json({ error: e.message });
  }
});
rolRouter.put('/:id', auth, async (req, res) => {
  try {
    const errorValidacion = validarRolBody(req.body);
    if (errorValidacion) return res.status(400).json({ error: errorValidacion });
    const nombre = String(req.body.nombre).trim();
    if (await rolNombreDuplicado(nombre, req.params.id)) {
      return res.status(400).json({ error: 'Ya existe un rol con ese nombre.' });
    }
    // Mismo bug que en el POST de arriba: "color" faltaba en el UPDATE, así
    // que editar el color de un rol existente tampoco se guardaba nunca.
    const { rows } = await pool.query(
      'UPDATE roles SET nombre=$1, descripcion=$2, permisos=$3, color=$4 WHERE id=$5 RETURNING *',
      [nombre, req.body.descripcion || null, JSON.stringify(req.body.permisos), req.body.color || null, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'No encontrado' });
    res.json(rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ error: 'Ya existe un rol con ese nombre.' });
    res.status(500).json({ error: e.message });
  }
});
// No se puede eliminar un rol que todavía tiene usuarios asignados — mismo
// mensaje que ya usa el frontend (RolesPage.jsx), para que coincida
// exactamente sin importar si el bloqueo lo hizo el frontend o el backend.
rolRouter.delete('/:id', auth, async (req, res) => {
  try {
    const { rows: actual } = await pool.query('SELECT nombre FROM roles WHERE id=$1', [req.params.id]);
    if (!actual[0]) return res.status(404).json({ error: 'No encontrado' });
    const n = await contarUsuariosConRol(actual[0].nombre);
    if (n > 0) {
      return res.status(409).json({ error: `No se puede eliminar: hay ${n} usuario(s) con este rol asignado.` });
    }
    await pool.query('DELETE FROM roles WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
r.use('/roles', rolRouter);

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
  const { correo, password, rol, sede } = req.body;
  // Nombre y usuario nunca se revisaban en el servidor: un nombre de puros
  // espacios ("   ") se guardaba tal cual. El username además se normaliza
  // (sin espacios sobrantes) porque es la llave con la que se inicia sesión.
  const errorNom = errorNombre(req.body.nombre, 'El nombre del usuario', LIMITES.NOMBRE);
  if (errorNom) return res.status(400).json({ error: errorNom });
  const errorUser = errorNombre(req.body.username, 'El nombre de usuario', LIMITES.NOMBRE_CORTO);
  if (errorUser) return res.status(400).json({ error: errorUser });
  const nombre   = nombreNormalizado(req.body.nombre);
  const username = nombreNormalizado(req.body.username);

  if (!passwordValida(password)) return res.status(400).json({ error: PASSWORD_ERROR });
  try {
    // Duplicado de username ignorando mayúsculas/espacios (el UNIQUE de la
    // columna sí distingue mayúsculas, así que "Ana" y "ANA" pasaban).
    if (await nombreDuplicado(pool, 'usuarios', username, null, 'username')) {
      return res.status(400).json({ error: 'Ese nombre de usuario ya está en uso.' });
    }
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
  const { correo, password, rol, sede } = req.body;
  const errorNom = errorNombre(req.body.nombre, 'El nombre del usuario', LIMITES.NOMBRE);
  if (errorNom) return res.status(400).json({ error: errorNom });
  const errorUser = errorNombre(req.body.username, 'El nombre de usuario', LIMITES.NOMBRE_CORTO);
  if (errorUser) return res.status(400).json({ error: errorUser });
  const nombre   = nombreNormalizado(req.body.nombre);
  const username = nombreNormalizado(req.body.username);

  try {
    const { rows: actual } = await pool.query('SELECT rol, es_superadmin FROM usuarios WHERE id=$1', [req.params.id]);
    if (!actual[0]) return res.status(404).json({ error: 'Usuario no encontrado' });
    // Excluye el propio registro para que editar sin cambiar el usuario no
    // se detecte a sí mismo como duplicado.
    if (await nombreDuplicado(pool, 'usuarios', username, req.params.id, 'username')) {
      return res.status(400).json({ error: 'Ese nombre de usuario ya está en uso.' });
    }

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
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ error: 'Ese nombre de usuario ya está en uso.' });
    res.status(500).json({ error: e.message });
  }
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

// Un empleado no puede reutilizar el correo ni el teléfono de otro empleado
// ya registrado (antes se podía repetir la información de otro empleado sin
// ningún aviso). Se compara ignorando mayúsculas y espacios de más, y
// excluyendo el propio registro al editar. Devuelve la lista de campos
// duplicados para poder decir exactamente cuál está repetido.
const buscarDuplicadosEmpleado = async ({ correo, telefono }, excluirId) => {
  const dup = [];
  for (const [campo, valor] of [['correo', correo], ['telefono', telefono]]) {
    const limpio = textoLimpio(valor);
    if (!limpio) continue; // ambos son opcionales: si no llegan, no hay nada que comparar
    if (await nombreDuplicado(pool, 'empleados', limpio, excluirId, campo)) dup.push(campo);
  }
  return dup;
};

// Etiquetas legibles para el mensaje de error de arriba.
const ETIQUETA_CAMPO_EMPLEADO = { correo: 'correo', telefono: 'teléfono' };

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
  const { cargo, estado, password, sede } = req.body;
  // El nombre nunca se revisaba: "     " se guardaba tal cual.
  const errorNom = errorNombre(req.body.nombre, 'El nombre del empleado', LIMITES.NOMBRE);
  if (errorNom) return res.status(400).json({ error: errorNom });
  const nombre   = nombreNormalizado(req.body.nombre);
  const telefono = textoLimpio(req.body.telefono) || null;
  const correo   = textoLimpio(req.body.correo)   || null;
  const username = req.body.username !== undefined && req.body.username !== null
    ? nombreNormalizado(req.body.username)
    : req.body.username;

  const necesitaLogin = CARGOS_CON_LOGIN.includes(cargo);
  // El local solo tiene sentido para Cajero/Bartender (son quienes operan
  // pedidos de un local específico); para el resto se guarda 'Local 1'
  // por el DEFAULT de la columna, sin que el formulario lo pida.
  const sedeFinal = necesitaLogin ? (sede || 'Local 1') : 'Local 1';
  try {
    const dup = await buscarDuplicadosEmpleado({ correo, telefono }, null);
    if (dup.length) {
      const etiquetas = dup.map(c => ETIQUETA_CAMPO_EMPLEADO[c] || c);
      return res.status(400).json({
        error: `Ya existe otro empleado con ese ${etiquetas.join(' y ese ')}.`,
        duplicateFields: dup,
      });
    }
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
  const { cargo, estado, password, sede } = req.body;
  const errorNom = errorNombre(req.body.nombre, 'El nombre del empleado', LIMITES.NOMBRE);
  if (errorNom) return res.status(400).json({ error: errorNom });
  const nombre   = nombreNormalizado(req.body.nombre);
  const telefono = textoLimpio(req.body.telefono) || null;
  const correo   = textoLimpio(req.body.correo)   || null;
  // Ojo: aquí username puede llegar ausente a propósito (el UPDATE de abajo
  // usa COALESCE para conservar el que ya tenía), así que solo se normaliza
  // si realmente vino algo — nunca se convierte un undefined en ''.
  const username = req.body.username !== undefined && req.body.username !== null
    ? nombreNormalizado(req.body.username)
    : req.body.username;

  const necesitaLogin = CARGOS_CON_LOGIN.includes(cargo);
  const sedeFinal = necesitaLogin ? (sede || 'Local 1') : 'Local 1';
  try {
    const { rows: actual } = await pool.query('SELECT usuario_id FROM empleados WHERE id=$1', [req.params.id]);
    if (!actual[0]) return res.status(404).json({ error: 'Empleado no encontrado' });

    const dup = await buscarDuplicadosEmpleado({ correo, telefono }, req.params.id);
    if (dup.length) {
      const etiquetas = dup.map(c => ETIQUETA_CAMPO_EMPLEADO[c] || c);
      return res.status(400).json({
        error: `Ya existe otro empleado con ese ${etiquetas.join(' y ese ')}.`,
        duplicateFields: dup,
      });
    }

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
// Antes este CRUD genérico no validaba nada: aceptaba un nombre de puros
// espacios, y permitía crear "Bebidas" y "bebidas" como dos categorías
// distintas (el UNIQUE de Postgres distingue mayúsculas, así que no lo
// frenaba). Tampoco había tope para la descripción.
r.use('/categorias', crud('categorias', ['nombre', 'descripcion', 'estado'], {
  etiqueta:      'El nombre de la categoría',
  validarNombre: true,
  maxNombre:     LIMITES.NOMBRE_CORTO,
  nombreUnico:   true,
  limites:       { descripcion: LIMITES.DESCRIPCION },
}));

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

// "Descuento vigente": el mismo cálculo que ya hacía el frontend
// (fecha_inicio_desc <= hoy <= fecha_fin_desc, con NULL = sin límite en ese
// extremo) pero ahora también en el backend — filtrando por CURRENT_DATE
// dentro de la propia consulta SQL, no solo en el navegador. Un producto
// con fecha_inicio_desc en el futuro (o con fecha_fin_desc ya vencida) sale
// SIEMPRE con descuento=0 en las rutas públicas, sin importar qué cliente
// las consulte ni qué valor de "descuento" tenga guardado en la tabla —
// así nunca se puede saltar esta regla llamando la API directo. La ruta de
// administración (GET /productos/todos, autenticada) sigue devolviendo el
// valor real de "descuento" tal como está guardado, porque ahí sí hace
// falta verlo/editarlo aunque todavía no esté vigente.
const DESCUENTO_VIGENTE_EXPR = `
  CASE
    WHEN descuento > 0
     AND (fecha_inicio_desc IS NULL OR fecha_inicio_desc <= CURRENT_DATE)
     AND (fecha_fin_desc   IS NULL OR fecha_fin_desc   >= CURRENT_DATE)
    THEN descuento ELSE 0
  END
`;
// Columnas explícitas de "productos" (ver schema.sql) con "descuento"
// reemplazado por el cálculo de arriba — se listan a mano (en vez de
// "SELECT *, ... AS descuento") porque repetir el nombre "descuento" como
// alias de una columna que también viene de "*" produce dos columnas con
// el mismo nombre en el resultado, y cuál de las dos "gana" en el objeto
// final que arma node-postgres no es algo en lo que valga la pena confiar.
const PRODUCTO_COLS_PUBLICO = `
  id, nombre, categoria, precio, ${DESCUENTO_VIGENTE_EXPR} AS descuento,
  fecha_inicio_desc, fecha_fin_desc, descripcion, imagen, estado, created_at
`;

// Nombre único de producto — la tabla ya tiene un UNIQUE real sobre
// "nombre" (productos_nombre_key, ver schema.sql), así que Postgres igual
// lo habría rechazado con 23505 (con el mensaje genérico "Producto ya
// existe" que ya capturaba el catch de abajo). Esta validación explícita
// no reemplaza esa restricción — la deja como red de seguridad final ante
// una carrera entre dos inserciones simultáneas — pero sí da un mensaje
// más claro y evita depender solo de adivinar el código de error de
// Postgres para saber qué fue lo que falló.
const productoNombreDuplicado = async (nombre, excluirId) => {
  if (!nombre) return false;
  const params = excluirId ? [nombre, excluirId] : [nombre];
  const cond = excluirId ? 'lower(nombre)=lower($1) AND id<>$2' : 'lower(nombre)=lower($1)';
  const { rows } = await pool.query(`SELECT id FROM productos WHERE ${cond} LIMIT 1`, params);
  return !!rows[0];
};

// fecha_inicio_desc no puede ser posterior a fecha_fin_desc — sin este
// chequeo, un producto podía quedar guardado con un rango de descuento
// invertido (ej. inicio 20/08, fin 10/08) que jamás estaría vigente para
// DESCUENTO_VIGENTE_EXPR de arriba, pero que el formulario del frontend no
// bloqueaba si se llamaba la API directamente.
const fechasDescuentoInvalidas = (inicio, fin) => {
  if (!inicio || !fin) return false;
  return new Date(inicio).getTime() > new Date(fin).getTime();
};

// Filtro de precio por "prefijo en miles": el cliente busca un número
// (ej. "3", "10", "15") y el Backend arma el rango completo de precios
// que empiezan así — "3" → 3000-3999, "10" → 10000-10999, "15" →
// 15000-15999 — en vez de que el Frontend tenga que mandar precioMin y
// precioMax ya calculados a mano. precio es NUMERIC(10,2) en la base de
// datos (ver schema.sql), así que la comparación se hace numéricamente
// (>=/<=), sin convertir nada a texto.
//
// Vacío/ausente ⇒ sin filtro (se devuelve null y la ruta no agrega
// condición). Cualquier otra cosa que no sea un entero no negativo
// (letras, negativos, decimales) ⇒ se devuelve el string 'invalido' para
// que la ruta responda 400 en vez de dejar pasar un valor sin sentido.
const RE_PRECIO_PREFIJO = /^\d+$/;
const filtroPrecioDesdeQuery = (raw) => {
  if (raw === undefined || raw === null) return null;
  const texto = String(raw).trim();
  if (texto === '') return null;
  if (!RE_PRECIO_PREFIJO.test(texto)) return 'invalido';
  const n = Number(texto);
  if (!Number.isSafeInteger(n)) return 'invalido';
  return { min: n * 1000, max: n * 1000 + 999 };
};

const prodRouter = require('express').Router();
// Catálogo público (Landing). Además del estado del propio producto, se
// respeta el estado de SU CATEGORÍA: si el administrador desactiva una
// categoría, sus productos dejan de ofrecerse en la tienda.
//
// ⚠️ Se resuelve filtrando aquí, NO sobrescribiendo productos.estado en
// cascada, y es a propósito: productos.categoria guarda el NOMBRE de la
// categoría (VARCHAR), no un id con llave foránea, y sobre todo un UPDATE
// masivo sería irreversible — si el admin ya había desactivado a mano
// algunos productos de esa categoría, al reactivar la categoría se
// activarían todos, incluidos los que él quería inactivos. Filtrando, el
// estado individual de cada producto se conserva intacto y todo vuelve
// solo al reactivar la categoría.
//
// El NOT EXISTS (en vez de un JOIN) mantiene visibles los productos cuya
// categoría está vacía o no existe en la tabla `categorias`: solo se
// esconden los que pertenecen a una categoría que existe Y está inactiva.
prodRouter.get('/', async (req, res) => {
  try {
  const filtroPrecio = filtroPrecioDesdeQuery(req.query.precio);
  if (filtroPrecio === 'invalido') {
    return res.status(400).json({ error: 'El precio de búsqueda debe ser un número entero (sin letras ni signos).' });
  }
  const params = [];
  let condicionPrecio = '';
  if (filtroPrecio) {
    params.push(filtroPrecio.min, filtroPrecio.max);
    condicionPrecio = 'AND p.precio >= $1 AND p.precio <= $2';
  }
  const { rows } = await pool.query(
    `SELECT ${PRODUCTO_COLS_PUBLICO} FROM productos p
      WHERE p.estado='Activo'
        AND NOT EXISTS (
          SELECT 1 FROM categorias c
           WHERE lower(btrim(c.nombre)) = lower(btrim(p.categoria))
             AND c.estado <> 'Activo'
        )
        ${condicionPrecio}
      ORDER BY p.id`,
    params
  );
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
    // Ruta pública (sin auth, la usa el carrito del Landing): mismo
    // criterio de "descuento vigente" que GET /productos, para que un
    // producto con descuento programado a futuro no vuelva a aparecer con
    // descuento>0 solo por consultarlo directo por id.
    const { rows } = await pool.query(`SELECT ${PRODUCTO_COLS_PUBLICO} FROM productos WHERE id=$1`, [identificador.id]);
    if (!rows[0]) return res.status(404).json({ error: 'No encontrado' });
    res.json({ tipo: 'producto', ...rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
prodRouter.post('/', auth, async (req, res) => {
  const { categoria, precio, descuento, fecha_inicio_desc, fecha_fin_desc, descripcion, imagen, estado } = req.body;
  // El nombre se guardaba tal cual llegaba: "   " pasaba sin ningún aviso, y
  // ni siquiera entraba a la revisión de duplicados de abajo.
  const errorNom = errorNombre(req.body.nombre, 'El nombre del producto', LIMITES.NOMBRE);
  if (errorNom) return res.status(400).json({ error: errorNom });
  const errorDesc = errorLongitud(descripcion, 'La descripción del producto', LIMITES.DESCRIPCION);
  if (errorDesc) return res.status(400).json({ error: errorDesc });
  const nombre = nombreNormalizado(req.body.nombre);
  try {
    if (fechasDescuentoInvalidas(fecha_inicio_desc, fecha_fin_desc)) {
      return res.status(400).json({ error: 'La fecha de inicio del descuento no puede ser posterior a la fecha de fin.' });
    }
    if (await productoNombreDuplicado(nombre, null)) {
      return res.status(400).json({ error: 'Ya existe un producto con este nombre.' });
    }
    const { rows } = await pool.query(
      `INSERT INTO productos(nombre,categoria,precio,descuento,fecha_inicio_desc,fecha_fin_desc,descripcion,imagen,estado)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [nombre, categoria, precio, descuento || 0, fecha_inicio_desc || null, fecha_fin_desc || null, descripcion, imagen, estado || 'Activo']
    );
    res.status(201).json(rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ error: 'Ya existe un producto con este nombre.' });
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
  const { categoria, precio, descuento, fecha_inicio_desc, fecha_fin_desc, descripcion, imagen, estado } = req.body;
  const errorNom = errorNombre(req.body.nombre, 'El nombre del producto', LIMITES.NOMBRE);
  if (errorNom) return res.status(400).json({ error: errorNom });
  const errorDesc = errorLongitud(descripcion, 'La descripción del producto', LIMITES.DESCRIPCION);
  if (errorDesc) return res.status(400).json({ error: errorDesc });
  const nombre = nombreNormalizado(req.body.nombre);
  if (fechasDescuentoInvalidas(fecha_inicio_desc, fecha_fin_desc)) {
    return res.status(400).json({ error: 'La fecha de inicio del descuento no puede ser posterior a la fecha de fin.' });
  }
  if (await productoNombreDuplicado(nombre, req.params.id)) {
    return res.status(400).json({ error: 'Ya existe un producto con este nombre.' });
  }
  const { rows } = await pool.query(
    `UPDATE productos SET nombre=$1,categoria=$2,precio=$3,descuento=$4,fecha_inicio_desc=$5,fecha_fin_desc=$6,descripcion=$7,imagen=$8,estado=$9 WHERE id=$10 RETURNING *`,
    [nombre, categoria, precio, descuento || 0, fecha_inicio_desc || null, fecha_fin_desc || null, descripcion, imagen, estado, req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'No encontrado' });
  res.json(rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ error: 'Ya existe un producto con este nombre.' });
    res.status(500).json({ error: e.message });
  }
});
// No se puede eliminar un producto que ya aparece en un pedido con el pago
// confirmado (o en una venta registrada a partir de un pedido) — borrarlo
// rompería el historial de ventas, que sigue guardando ese producto dentro
// de "pedidos.items" (jsonb). Solo se puede desactivar (estado='Inactivo',
// ver PATCH /:id/estado del CRUD genérico que sigue aplicando a otras
// tablas, o el propio PUT de arriba).
//
// ⚠️ Límite real de este chequeo: busca el id del producto directamente en
// "items" (it->>'id' / it->>'producto_id' / it->>'id_producto' — los
// mismos nombres de campo que ya usa idProductoDeItem/parseIdentificadorProducto
// más abajo en este archivo), así que sí detecta el caso normal (producto
// pedido suelto). Si el producto SOLO se vendió como parte de un combo
// (id del pedido = "combo-5", el id del producto nunca queda como campo
// propio de ese ítem), este chequeo no lo detecta — no pude confirmar
// desde este repo si eso pasa en la práctica, porque no hay pedidos con
// combos vendidos en esta base de datos para inspeccionar.
const productoAsociadoAVenta = async (productoId) => {
  const { rows } = await pool.query(
    `SELECT 1 FROM pedidos p
       WHERE (p.pago_confirmado = true OR EXISTS (SELECT 1 FROM ventas v WHERE v.pedido_id = p.id))
         AND EXISTS (
           SELECT 1 FROM jsonb_array_elements(p.items) it
            WHERE (it->>'id') = $1::text OR (it->>'producto_id') = $1::text OR (it->>'id_producto') = $1::text
         )
       LIMIT 1`,
    [productoId]
  );
  return !!rows[0];
};
prodRouter.delete('/:id', auth, async (req, res) => {
  if (!/^\d+$/.test(String(req.params.id))) return res.status(400).json({ error: `ID inválido: "${req.params.id}"` });
  try {
  if (await productoAsociadoAVenta(req.params.id)) {
    return res.status(409).json({ error: 'No se puede eliminar: este producto ya está asociado a una venta o a un pedido confirmado. Desactívalo en su lugar.' });
  }
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
// Antes se podía crear "Chocolate" y "CHOCOLATE" como dos toppings
// distintos, o guardar un nombre de puros espacios.
r.use('/toppings',  crud('toppings',  ['nombre', 'productos_ids', 'estado', 'insumo_id', 'cantidad'], {
  etiqueta:      'El nombre del topping',
  validarNombre: true,
  maxNombre:     LIMITES.NOMBRE_CORTO,
  nombreUnico:   true,
}));

// ── ADICIONES ──────────────────────────────────────────────
// Las adiciones siguen siendo universales (aplican igual a todos los
// productos, sin producto_id — a diferencia de toppings.productos_ids).
// insumo_id/cantidad: de qué insumo y cuánto descuenta del stock vender
// esta adición (mismo mecanismo que toppings.insumo_id/cantidad, pero sin
// override por producto — ver calcularRecetaEfectiva más abajo).
// 'descripcion': el whitelist de campos de este crud() no la incluía, así
// que aunque el formulario del frontend la capturaba y la mandaba, el
// helper genérico la descartaba antes del INSERT/UPDATE — nunca llegaba a
// guardarse (columna agregada en config/db.js).
// Mismo caso que toppings ("Leche" vs "LECHE"), más el tope de la
// descripción — que hasta ahora solo existía como límite de 20 palabras en
// la pantalla, saltable llamando la API directamente.
r.use('/adiciones', crud('adiciones', ['nombre', 'precio', 'estado', 'insumo_id', 'cantidad', 'descripcion'], {
  etiqueta:      'El nombre de la adición',
  validarNombre: true,
  maxNombre:     LIMITES.NOMBRE_CORTO,
  nombreUnico:   true,
  limites:       { descripcion: LIMITES.DESCRIPCION },
}));

// ── COMBOS ─────────────────────────────────────────────────
const comboRouter = require('express').Router();
comboRouter.param('id', validateId); // valida :id (numérico) antes de las rutas de abajo
// Público (Landing, sin auth): además de estado='Activo', un combo solo
// se ofrece si la fecha actual está dentro de su ventana fecha_inicio /
// fecha_fin — mismo criterio que ya usa DESCUENTO_VIGENTE_EXPR para
// productos.fecha_inicio_desc/fecha_fin_desc (NULL = sin límite en ese
// extremo), filtrando con CURRENT_DATE dentro de la propia consulta SQL
// para que la regla la imponga el Backend y no dependa de que el
// Frontend decida ocultarlo. GET /combos/todos (abajo, con auth) sigue
// devolviendo TODOS los combos sin este filtro, para que el
// Administrador pueda seguir viendo y gestionando combos futuros.
comboRouter.get('/', async (req, res) => {
  try {
  const { rows } = await pool.query(
    `SELECT * FROM combos
      WHERE estado='Activo'
        AND (fecha_inicio IS NULL OR fecha_inicio <= CURRENT_DATE)
        AND (fecha_fin    IS NULL OR fecha_fin    >= CURRENT_DATE)
      ORDER BY id`
  );
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
  // Antes: fechaInicio/fechaFin llegaban del formulario pero nunca se
  // incluían en el INSERT — las columnas fecha_inicio/fecha_fin de la
  // tabla (que sí existen) quedaban NULL para siempre sin importar qué
  // fecha eligiera el admin.
  const { descripcion, precio, imagen, items, fechaInicio, fechaFin } = req.body;
  // Este módulo era el más flojo de todos: ni siquiera exigía que el campo
  // "nombre" existiera (se podía crear un combo sin nombre), no comparaba
  // duplicados ignorando mayúsculas, y la descripción no tenía tope.
  const errorNom = errorNombre(req.body.nombre, 'El nombre del combo', LIMITES.NOMBRE);
  if (errorNom) return res.status(400).json({ error: errorNom });
  const errorDesc = errorLongitud(descripcion, 'La descripción del combo', LIMITES.DESCRIPCION);
  if (errorDesc) return res.status(400).json({ error: errorDesc });
  const nombre = nombreNormalizado(req.body.nombre);
  if (await nombreDuplicado(pool, 'combos', nombre, null)) {
    return res.status(400).json({ error: 'Ya existe un combo con ese nombre.' });
  }
  const { rows } = await pool.query(
    `INSERT INTO combos(nombre,descripcion,precio,imagen,items,fecha_inicio,fecha_fin)
     VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [nombre, descripcion, precio, imagen, JSON.stringify(items || []), fechaInicio || null, fechaFin || null]
  );
  res.status(201).json(rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ error: 'Ya existe un combo con ese nombre.' });
    res.status(500).json({ error: e.message });
  }
});
comboRouter.put('/:id', auth, async (req, res) => {
  try {
  const { descripcion, precio, imagen, items, fechaInicio, fechaFin } = req.body;
  const errorNom = errorNombre(req.body.nombre, 'El nombre del combo', LIMITES.NOMBRE);
  if (errorNom) return res.status(400).json({ error: errorNom });
  const errorDesc = errorLongitud(descripcion, 'La descripción del combo', LIMITES.DESCRIPCION);
  if (errorDesc) return res.status(400).json({ error: errorDesc });
  const nombre = nombreNormalizado(req.body.nombre);
  if (await nombreDuplicado(pool, 'combos', nombre, req.params.id)) {
    return res.status(400).json({ error: 'Ya existe un combo con ese nombre.' });
  }
  const { rows } = await pool.query(
    `UPDATE combos SET nombre=$1,descripcion=$2,precio=$3,imagen=$4,items=$5,fecha_inicio=$6,fecha_fin=$7
     WHERE id=$8 RETURNING *`,
    [nombre, descripcion, precio, imagen, JSON.stringify(items || []), fechaInicio || null, fechaFin || null, req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Combo no encontrado' });
  res.json(rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ error: 'Ya existe un combo con ese nombre.' });
    res.status(500).json({ error: e.message });
  }
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
// [columna en la BD, clave que manda el formulario] — nombres, apellidos y
// los campos heredados coinciden en ambos lados; tipoPersona/tipoDocumento/
// numeroDocumento son snake_case en la BD pero camelCase en el payload.
const PROVEEDOR_FIELD_MAP = [
  ['nombre', 'nombre'], ['nit', 'nit'], ['telefono', 'telefono'], ['correo', 'correo'],
  ['direccion', 'direccion'], ['ciudad', 'ciudad'], ['observaciones', 'observaciones'], ['estado', 'estado'],
  ['tipo_persona', 'tipoPersona'], ['nombres', 'nombres'], ['apellidos', 'apellidos'],
  ['tipo_documento', 'tipoDocumento'], ['numero_documento', 'numeroDocumento'],
  ['persona_contacto', 'personaContacto'],
];
const PROVEEDOR_FIELDS = PROVEEDOR_FIELD_MAP.map(([col]) => col);

// Revisa nombre/correo/teléfono siempre; NIT solo si es Persona Jurídica,
// número de documento solo si es Persona Natural (con el mismo tipo de
// documento) — mismo alcance que ya usa el frontend en su verificación
// local antes de enviar. Acumula TODOS los conflictos a la vez (no se
// detiene en el primero) para poder mostrarlos todos juntos, tal como se
// pidió para los 3 módulos.
const buscarDuplicadosProveedor = async ({ nombre, nit, telefono, correo, tipoPersona, tipoDocumento, numeroDocumento }, excluirId) => {
  const dup = [];
  const checks = [['nombre', nombre], ['telefono', telefono], ['correo', correo]];

  // El NIT vive en el mismo espacio de identificación sin importar si
  // viene de un proveedor Jurídico (columna nit) o de uno Natural que
  // eligió "NIT" como tipo de documento (columna numero_documento) —
  // antes cada uno se comparaba solo contra su propia columna, así que
  // un mismo NIT se podía repetir cruzando de un lado al otro.
  const nitDelRegistro = tipoPersona === 'Natural' ? (tipoDocumento === 'NIT' ? numeroDocumento : null) : nit;
  if (nitDelRegistro) {
    const params = excluirId ? [nitDelRegistro, excluirId] : [nitDelRegistro];
    const cond = excluirId
      ? `(nit=$1 OR (numero_documento=$1 AND tipo_documento='NIT')) AND id<>$2`
      : `(nit=$1 OR (numero_documento=$1 AND tipo_documento='NIT'))`;
    const { rows } = await pool.query(`SELECT id FROM proveedores WHERE ${cond} LIMIT 1`, params);
    if (rows[0]) dup.push(tipoPersona === 'Natural' ? 'numeroDocumento' : 'nit');
  }

  // El resto de tipos de documento (CC, TI, CE, Pasaporte) sí quedan
  // separados por tipo — solo NIT comparte espacio entre Natural y
  // Jurídica.
  if (tipoPersona === 'Natural' && tipoDocumento !== 'NIT' && numeroDocumento) {
    const params = excluirId ? [numeroDocumento, tipoDocumento, excluirId] : [numeroDocumento, tipoDocumento];
    const cond = excluirId
      ? `numero_documento=$1 AND tipo_documento=$2 AND tipo_persona='Natural' AND id<>$3`
      : `numero_documento=$1 AND tipo_documento=$2 AND tipo_persona='Natural'`;
    const { rows } = await pool.query(`SELECT id FROM proveedores WHERE ${cond} LIMIT 1`, params);
    if (rows[0]) dup.push('numeroDocumento');
  }
  for (const [campo, valor] of checks) {
    if (!valor) continue;
    const params = excluirId ? [valor, excluirId] : [valor];
    const cond = excluirId ? `lower(${campo})=lower($1) AND id<>$2` : `lower(${campo})=lower($1)`;
    const { rows } = await pool.query(`SELECT id FROM proveedores WHERE ${cond} LIMIT 1`, params);
    if (rows[0]) dup.push(campo);
  }
  return dup;
};

const PROVEEDOR_SELECT = `
  SELECT id, nombre, nit, telefono, correo, direccion, ciudad, observaciones, estado, created_at,
         tipo_persona AS "tipoPersona", nombres, apellidos,
         tipo_documento AS "tipoDocumento", numero_documento AS "numeroDocumento",
         persona_contacto AS "personaContacto"
  FROM proveedores`;

const provRouter = require('express').Router();
provRouter.get('/', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(`${PROVEEDOR_SELECT} ORDER BY id DESC`);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
provRouter.get('/:id', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(`${PROVEEDOR_SELECT} WHERE id=$1`, [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'No encontrado' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
provRouter.post('/', auth, async (req, res) => {
  try {
    // El nombre se guardaba tal cual llegaba, sin revisar que tuviera
    // contenido real, y las observaciones no tenían ningún tope. El
    // límite depende del tipo de persona: Natural usa "Nombre completo"
    // (100), Jurídica usa "Razón Social" (60) — mismo tope que ya aplica
    // el frontend en cada caso.
    const maxNombreProveedor = req.body.tipoPersona === 'Natural' ? 100 : 60;
    const errorNom = errorNombre(req.body.nombre, req.body.tipoPersona === 'Natural' ? 'El nombre completo' : 'La razón social', maxNombreProveedor);
    if (errorNom) return res.status(400).json({ error: errorNom });
    const errorObs = errorLongitud(req.body.observaciones, 'Las observaciones', LIMITES.OBSERVACIONES);
    if (errorObs) return res.status(400).json({ error: errorObs });

    const body = { ...req.body, nombre: nombreNormalizado(req.body.nombre) };
    const dup = await buscarDuplicadosProveedor(body, null);
    if (dup.length) {
      return res.status(400).json({ error: 'Ya existe un proveedor con ese ' + dup.join(', ') + '.', duplicateFields: dup });
    }
    const vals = PROVEEDOR_FIELD_MAP.map(([, key]) => body[key] ?? null);
    const { rows } = await pool.query(
      `INSERT INTO proveedores(${PROVEEDOR_FIELDS.join(',')}) VALUES(${PROVEEDOR_FIELDS.map((_, i) => `$${i + 1}`).join(',')}) RETURNING id`,
      vals
    );
    const { rows: full } = await pool.query(`${PROVEEDOR_SELECT} WHERE id=$1`, [rows[0].id]);
    res.status(201).json(full[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ error: 'Ya existe un registro con ese dato.' });
    res.status(500).json({ error: e.message });
  }
});
provRouter.put('/:id', auth, async (req, res) => {
  try {
    const maxNombreProveedor = req.body.tipoPersona === 'Natural' ? 100 : 60;
    const errorNom = errorNombre(req.body.nombre, req.body.tipoPersona === 'Natural' ? 'El nombre completo' : 'La razón social', maxNombreProveedor);
    if (errorNom) return res.status(400).json({ error: errorNom });
    const errorObs = errorLongitud(req.body.observaciones, 'Las observaciones', LIMITES.OBSERVACIONES);
    if (errorObs) return res.status(400).json({ error: errorObs });

    const body = { ...req.body, nombre: nombreNormalizado(req.body.nombre) };
    const dup = await buscarDuplicadosProveedor(body, req.params.id);
    if (dup.length) {
      return res.status(400).json({ error: 'Ya existe un proveedor con ese ' + dup.join(', ') + '.', duplicateFields: dup });
    }
    const { rows: actual } = await pool.query('SELECT estado FROM proveedores WHERE id=$1', [req.params.id]);
    if (!actual[0]) return res.status(404).json({ error: 'No encontrado' });
    const seDesactiva = actual[0].estado === 'Activo' && body.estado === 'Inactivo';

    const vals = [...PROVEEDOR_FIELD_MAP.map(([, key]) => body[key] ?? null), req.params.id];
    const { rows } = await pool.query(
      `UPDATE proveedores SET ${PROVEEDOR_FIELDS.map((f, i) => `${f}=$${i + 1}`).join(',')} WHERE id=$${PROVEEDOR_FIELDS.length + 1} RETURNING id`,
      vals
    );
    if (!rows[0]) return res.status(404).json({ error: 'No encontrado' });

    // Al desactivar un proveedor desde el formulario de edición, sus
    // insumos activos también quedan inactivos — igual que ya pasaba con
    // el interruptor rápido, pero acá nunca se aplicaba.
    let insumosDesactivados = [];
    if (seDesactiva) {
      const { rows: afectados } = await pool.query(`SELECT id, nombre FROM insumos WHERE proveedor_id=$1 AND estado='Activo'`, [req.params.id]);
      if (afectados.length) {
        await pool.query(`UPDATE insumos SET estado='Inactivo' WHERE proveedor_id=$1 AND estado='Activo'`, [req.params.id]);
        insumosDesactivados = afectados;
      }
    }
    const { rows: full } = await pool.query(`${PROVEEDOR_SELECT} WHERE id=$1`, [req.params.id]);
    res.json({ ...full[0], insumosDesactivados: insumosDesactivados.length, nombresInsumosDesactivados: insumosDesactivados.map(i => i.nombre) });
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ error: 'Ya existe un registro con ese dato.' });
    res.status(500).json({ error: e.message });
  }
});
provRouter.patch('/:id/estado', auth, async (req, res) => {
  try {
    const { rows: antes } = await pool.query('SELECT estado FROM proveedores WHERE id=$1', [req.params.id]);
    if (!antes[0]) return res.status(404).json({ error: 'No encontrado' });
    const { rows } = await pool.query(
      `UPDATE proveedores SET estado = CASE WHEN estado='Activo' THEN 'Inactivo' ELSE 'Activo' END WHERE id=$1 RETURNING estado`,
      [req.params.id]
    );
    let insumosDesactivados = [];
    if (antes[0].estado === 'Activo' && rows[0].estado === 'Inactivo') {
      const { rows: afectados } = await pool.query(`SELECT id, nombre FROM insumos WHERE proveedor_id=$1 AND estado='Activo'`, [req.params.id]);
      if (afectados.length) {
        await pool.query(`UPDATE insumos SET estado='Inactivo' WHERE proveedor_id=$1 AND estado='Activo'`, [req.params.id]);
        insumosDesactivados = afectados;
      }
    }
    const { rows: full } = await pool.query(`${PROVEEDOR_SELECT} WHERE id=$1`, [req.params.id]);
    res.json({ ...full[0], insumosDesactivados: insumosDesactivados.length, nombresInsumosDesactivados: insumosDesactivados.map(i => i.nombre) });
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
// El nombre se insertaba directo: se aceptaba "   ", y "Lácteos" vs
// " Lácteos " (o "LÁCTEOS") quedaban como dos categorías distintas, porque
// el UNIQUE de Postgres compara byte a byte.
catInsRouter.post('/', auth, async (req, res) => {
  try {
    const errorNom = errorNombre(req.body.nombre, 'El nombre de la categoría', LIMITES.NOMBRE_CORTO);
    if (errorNom) return res.status(400).json({ error: errorNom });
    const nombre = nombreNormalizado(req.body.nombre);
    if (await nombreDuplicado(pool, 'categorias_insumos', nombre, null)) {
      return res.status(400).json({ error: 'Ya existe una categoría con ese nombre' });
    }
    const { rows } = await pool.query(`INSERT INTO categorias_insumos(nombre) VALUES($1) RETURNING *`, [nombre]);
    res.status(201).json(rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ error: 'Ya existe una categoría con ese nombre' });
    res.status(500).json({ error: e.message });
  }
});
catInsRouter.put('/:id', auth, async (req, res) => {
  try {
    const errorNom = errorNombre(req.body.nombre, 'El nombre de la categoría', LIMITES.NOMBRE_CORTO);
    if (errorNom) return res.status(400).json({ error: errorNom });
    const nombre = nombreNormalizado(req.body.nombre);
    if (await nombreDuplicado(pool, 'categorias_insumos', nombre, req.params.id)) {
      return res.status(400).json({ error: 'Ya existe una categoría con ese nombre' });
    }
    const { rows } = await pool.query(`UPDATE categorias_insumos SET nombre=$1 WHERE id=$2 RETURNING *`, [nombre, req.params.id]);
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
      // Misma validación que el POST de arriba: crear la categoría destino
      // por esta vía no puede saltarse las reglas de nombre.
      const errorNom = errorNombre(nuevaCategoriaNombre, 'El nombre de la nueva categoría', LIMITES.NOMBRE_CORTO);
      if (errorNom) return res.status(400).json({ error: errorNom });
      const nombreNuevo = nombreNormalizado(nuevaCategoriaNombre);
      if (await nombreDuplicado(pool, 'categorias_insumos', nombreNuevo, null)) {
        return res.status(400).json({ error: 'Ya existe una categoría con ese nombre' });
      }
      const { rows } = await pool.query(`INSERT INTO categorias_insumos(nombre) VALUES($1) RETURNING id`, [nombreNuevo]);
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

// ── TIPOS DE PRESENTACIÓN (Compras) ───────────────────────────
// Antes una lista fija en el código del formulario de compra (Caja,
// Paquete, Bolsa) — ahora un catálogo gestionable, mismo patrón que
// categorias_insumos de arriba. Deliberadamente más simple: a diferencia
// de una categoría de insumo, un tipo de presentación no queda "pegado" a
// una entidad persistente (solo se usa en el momento de definir una
// compra puntual), así que no necesita ni bloqueo de eliminación por
// tener registros asociados, ni un flujo de recategorización — una compra
// ya registrada conserva el nombre del tipo que usó en su propio registro,
// sin importar si ese tipo sigue existiendo o activo en este catálogo.
const tiposPresentacionRouter = require('express').Router();
tiposPresentacionRouter.param('id', validateId);
tiposPresentacionRouter.get('/', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM tipos_presentacion ORDER BY id ASC`);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
tiposPresentacionRouter.post('/', auth, async (req, res) => {
  try {
    const errorNom = errorNombre(req.body.nombre, 'El nombre del tipo de presentación', LIMITES.NOMBRE_CORTO);
    if (errorNom) return res.status(400).json({ error: errorNom });
    const nombre = nombreNormalizado(req.body.nombre);
    if (await nombreDuplicado(pool, 'tipos_presentacion', nombre, null)) {
      return res.status(400).json({ error: 'Ya existe un tipo de presentación con ese nombre' });
    }
    if (nombre.toLowerCase() === 'unitario') {
      return res.status(400).json({ error: '"Unitario" es una opción fija del sistema, no se puede crear como tipo gestionable.' });
    }
    const { rows } = await pool.query(`INSERT INTO tipos_presentacion(nombre) VALUES($1) RETURNING *`, [nombre]);
    res.status(201).json(rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ error: 'Ya existe un tipo de presentación con ese nombre' });
    res.status(500).json({ error: e.message });
  }
});
tiposPresentacionRouter.put('/:id', auth, async (req, res) => {
  try {
    const errorNom = errorNombre(req.body.nombre, 'El nombre del tipo de presentación', LIMITES.NOMBRE_CORTO);
    if (errorNom) return res.status(400).json({ error: errorNom });
    const nombre = nombreNormalizado(req.body.nombre);
    if (await nombreDuplicado(pool, 'tipos_presentacion', nombre, req.params.id)) {
      return res.status(400).json({ error: 'Ya existe un tipo de presentación con ese nombre' });
    }
    if (nombre.toLowerCase() === 'unitario') {
      return res.status(400).json({ error: '"Unitario" es una opción fija del sistema, no se puede usar como nombre de un tipo gestionable.' });
    }
    const { rows } = await pool.query(`UPDATE tipos_presentacion SET nombre=$1 WHERE id=$2 RETURNING *`, [nombre, req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'No encontrado' });
    res.json(rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ error: 'Ya existe un tipo de presentación con ese nombre' });
    res.status(500).json({ error: e.message });
  }
});
tiposPresentacionRouter.patch('/:id/estado', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `UPDATE tipos_presentacion SET estado = CASE WHEN estado='Activo' THEN 'Inactivo' ELSE 'Activo' END WHERE id=$1 RETURNING *`,
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'No encontrado' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
r.use('/tipos-presentacion', tiposPresentacionRouter);

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
  const { categoriaId, unidadMedida, stockActual, stockMinimo, precioUnitario, proveedorId, descripcion, estado, esTopping } = req.body;
  // Antes el nombre se insertaba directo: si era solo espacios, ni siquiera
  // llegaba a insumoNombreDuplicado (que sale temprano con !nombre... pero
  // "   " es truthy, así que comparaba espacios contra espacios y guardaba).
  const errorNom = errorNombre(req.body.nombre, 'El nombre del insumo', LIMITES.NOMBRE);
  if (errorNom) return res.status(400).json({ error: errorNom });
  const errorDesc = errorLongitud(descripcion, 'La descripción del insumo', LIMITES.DESCRIPCION);
  if (errorDesc) return res.status(400).json({ error: errorDesc });
  const nombre = nombreNormalizado(req.body.nombre);
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
  const { categoriaId, unidadMedida, stockActual, stockMinimo, precioUnitario, proveedorId, descripcion, estado, esTopping } = req.body;
  const errorNom = errorNombre(req.body.nombre, 'El nombre del insumo', LIMITES.NOMBRE);
  if (errorNom) return res.status(400).json({ error: errorNom });
  const errorDesc = errorLongitud(descripcion, 'La descripción del insumo', LIMITES.DESCRIPCION);
  if (errorDesc) return res.status(400).json({ error: errorDesc });
  const nombre = nombreNormalizado(req.body.nombre);

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
    `UPDATE insumos SET nombre=$1,categoria_id=$2,unidad=$3,stock_minimo=$4,precio_unitario=$5,proveedor_id=$6,descripcion=$7,estado=$8,es_topping=$9
     WHERE id=$10 RETURNING id`,
    [nombre, categoriaId || null, unidadEnviada, stockMinimo, precioUnitario, proveedorId || null, descripcion || null, estado, !!esTopping, req.params.id]
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
  c.ocr_resultado AS "ocrResultado",
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
// Valida la forma de un ítem de compra en modo "presentacion" antes de
// guardarlo. Sin esto, un cantidad_presentaciones decimal/negativo o un
// contenido_por_presentacion en 0 dejaría el stock sumado mal calculado
// (o en 0) sin que nada lo impidiera.
const validarItemCompra = async (item, index) => {
  const etiqueta = item?.insumo || `ítem #${index + 1}`;

  // Cantidad: obligatoria, positiva, sin letras/símbolos, tope 999.999,99,
  // máximo 2 decimales. El propio frontend ya calcula y envía el valor
  // final (convertido a la unidad real, incluso en modo "por
  // presentación"), así que se valida siempre como un número plano.
  const cantidad = Number(item?.cantidad);
  if (item?.cantidad === undefined || item?.cantidad === null || item?.cantidad === '' || Number.isNaN(cantidad)) {
    return `"${etiqueta}": la cantidad es obligatoria y debe ser un número.`;
  }
  if (cantidad <= 0) return `"${etiqueta}": la cantidad no puede ser 0 ni negativa.`;
  if (cantidad > 999999.99) return `"${etiqueta}": la cantidad no puede superar 999.999,99.`;
  const decimalesCantidad = (String(item.cantidad).split('.')[1] || '').length;
  if (decimalesCantidad > 2) return `"${etiqueta}": la cantidad admite máximo 2 decimales.`;

  // Precio por unidad real (kg/L/unidad/etc.): es un valor CALCULADO
  // (precio total ÷ cantidad real), nunca lo que el usuario escribió
  // directamente — legítimamente puede tener decimales infinitos (ej. 3 kg
  // por $10.000 = $3.333,33... por kg) y eso no es un error. Por eso aquí
  // solo se valida que sea positivo y esté dentro de un rango razonable;
  // la exigencia de "entero, sin decimales" se aplica más abajo, al precio
  // que el usuario SÍ escribió a mano (presentacion.precioPresentacion).
  const precio = Number(item?.precioUnitario);
  if (item?.precioUnitario === undefined || item?.precioUnitario === null || item?.precioUnitario === '' || Number.isNaN(precio)) {
    return `"${etiqueta}": el precio es obligatorio y debe ser un número.`;
  }
  if (precio <= 0) return `"${etiqueta}": el precio no puede ser 0 ni negativo.`;
  if (precio > 999999999) return `"${etiqueta}": el precio no puede superar 999.999.999.`;

  // "Por presentación" es solo informativa (auditoría/despliegue en el
  // detalle) — el frontend la manda anidada en item.presentacion, ya
  // convertida a cantidad/precioUnitario reales arriba.
  if (item?.presentacion) {
    const p = item.presentacion;
    // El precio que SÍ escribió el usuario (no el calculado por
    // división de arriba) — este es el que debe ser un entero limpio de
    // pesos, sin decimales (en Colombia el punto separa miles, no
    // decimales).
    const precioEscrito = Number(p.precioPresentacion);
    if (p.precioPresentacion === undefined || p.precioPresentacion === null || p.precioPresentacion === '' || Number.isNaN(precioEscrito)) {
      return `"${etiqueta}": el precio es obligatorio y debe ser un número.`;
    }
    if (precioEscrito <= 0) return `"${etiqueta}": el precio no puede ser 0 ni negativo.`;
    if (precioEscrito > 999999999) return `"${etiqueta}": el precio no puede superar 999.999.999.`;
    if (!Number.isInteger(precioEscrito)) return `"${etiqueta}": el precio debe ser un número entero de pesos, sin decimales (en Colombia el punto se usa para separar miles, no como decimal).`;
    // El tipo ya no se compara contra una lista fija en el código —
    // "Unitario" sigue siendo una excepción fija (no vive en la tabla,
    // es una opción especial del sistema); cualquier otro tipo debe
    // existir y estar activo en tipos_presentacion. Esto también evita
    // que una compra guarde un tipo ya desactivado o inexistente, sin
    // necesitar bloquear la desactivación en sí (que sigue sin
    // restricciones, tal como se pidió).
    if (p.tipo !== 'Unitario') {
      const { rows } = await pool.query(
        `SELECT id FROM tipos_presentacion WHERE lower(nombre)=lower($1) AND estado='Activo' LIMIT 1`,
        [p.tipo]
      );
      if (!rows[0]) return `"${etiqueta}": tipo de presentación inválido o inactivo.`;
    }
    if (!Number.isInteger(p.cantidad) || p.cantidad <= 0) {
      return `"${etiqueta}": la cantidad de presentaciones debe ser un entero mayor a 0.`;
    }
    if (!Number.isFinite(Number(p.contenidoPorPresentacion)) || Number(p.contenidoPorPresentacion) <= 0) {
      return `"${etiqueta}": el contenido por presentación debe ser mayor a 0.`;
    }
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
    comprobante_url, comprobante_verificado, comprobante_total_ocr, ocr_resultado,
  } = req.body;

  // Una compra es un hecho ya ocurrido: no se puede registrar con una
  // fecha posterior al día de hoy. El frontend ya bloquea esto en el
  // propio calendario, pero acá queda la garantía real.
  if (fecha) {
    const hoy = new Date().toISOString().slice(0, 10);
    if (String(fecha).slice(0, 10) > hoy) {
      return res.status(400).json({ error: 'La fecha no puede ser futura — una compra es un hecho ya ocurrido.' });
    }
  }

  // El descuento es opcional (0 por defecto) pero, si llega, tiene que ser
  // un porcentaje válido entre 0 y 100. Sin esta validación un valor como
  // -10 o 500 se guardaría tal cual y el total final quedaría mal
  // calculado (incluso negativo o mayor al bruto).
  const descuentoNum = (descuento === undefined || descuento === null || descuento === '')
    ? 0 : Number(descuento);
  if (Number.isNaN(descuentoNum) || descuentoNum < 0 || descuentoNum > 100) {
    return res.status(400).json({ error: 'El descuento debe ser un número entre 0 y 100.' });
  }

  // Las observaciones son opcionales, pero no tenían ningún tope: se podía
  // pegar un texto de cualquier tamaño en el campo.
  const errorObs = errorLongitud(observaciones, 'Las observaciones de la compra', LIMITES.OBSERVACIONES);
  if (errorObs) return res.status(400).json({ error: errorObs });

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
    const errorItem = await validarItemCompra(items[i], i);
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
        `INSERT INTO compras(codigo,proveedor_id,fecha,descuento,total,items,observaciones,comprobante_url,comprobante_verificado,comprobante_total_ocr,ocr_resultado,estado)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'activa') RETURNING id`,
        [
          codigo, proveedorId || null, fecha || new Date(), descuentoNum, totalFinal,
          JSON.stringify(items || []), observaciones || null, comprobante_url || null,
          comprobante_verificado || false, comprobante_total_ocr ?? null,
          ocr_resultado ? JSON.stringify(ocr_resultado) : null,
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
  // El motivo de anulación queda como registro permanente de por qué se
  // revirtió el stock, así que no puede ser vacío ni puros espacios.
  const motivo = textoLimpio(req.body.motivo);
  if (!motivo) {
    return res.status(400).json({ error: 'El motivo de anulación es obligatorio y no puede contener solo espacios en blanco.' });
  }
  const errorMotivo = errorLongitud(motivo, 'El motivo de anulación', LIMITES.MOTIVO);
  if (errorMotivo) return res.status(400).json({ error: errorMotivo });

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
// Único conjunto de valores válidos para pedidos.estado en TODA la API —
// la secuencia de arriba más 'cancelado' (que no vive en la secuencia
// porque se puede dar en cualquier punto, no en un paso fijo). Antes, esta
// lista solo se exigía en PATCH /:id/estado — POST /pedidos (creación)
// aceptaba cualquier string que mandara el cliente en "estado" (o
// "_meta.estado") sin validar nada, así que una petición directa a la API
// (sin pasar por el formulario del frontend) podía crear un pedido con un
// "estado" inventado (ej. "stop", o cualquier typo) que después rompía
// cualquier pantalla que comparara contra esta lista. Coincide exactamente
// con el CHECK pedidos_estado_check de config/db.js/schema.sql, que es la
// misma regla aplicada también a nivel de base de datos.
const ESTADOS_PEDIDO_VALIDOS = [...ESTADOS_PEDIDO_ORDEN, 'cancelado'];

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
    //
    // El "estado" que llega del body solo se valida (y se usa) en el caso
    // sin comprobante — con comprobante siempre se pisa por
    // 'pendiente_verificacion' de todas formas. Antes esto no se validaba
    // en absoluto acá (solo en PATCH /:id/estado), así que una petición
    // directa a la API podía crear un pedido con cualquier "estado"
    // inventado — ver ESTADOS_PEDIDO_VALIDOS más arriba.
    const estadoSolicitado = estado || meta.estado || null;
    if (estadoSolicitado && !ESTADOS_PEDIDO_VALIDOS.includes(estadoSolicitado)) {
      return res.status(400).json({ error: `Estado inválido: "${estadoSolicitado}". Debe ser uno de: ${ESTADOS_PEDIDO_VALIDOS.join(', ')}.` });
    }
    const estadoInicial = comprobanteImgFinal ? 'pendiente_verificacion' : (estadoSolicitado || 'pendiente');

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
  if (!ESTADOS_PEDIDO_VALIDOS.includes(estado)) {
    return res.status(400).json({ error: `Estado inválido: "${estado}". Debe ser uno de: ${ESTADOS_PEDIDO_VALIDOS.join(', ')}.` });
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

    
    await descontarInventarioPorVenta(ped[0].items);

    const { rows } = await pool.query(
      
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


const devRouter = require('express').Router();

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
// Tope de 20 palabras en el motivo de la devolución — igual que ya exige la
// pantalla web, pero ahora también acá para que no se pueda saltar llamando
// la API directo. Es UN solo motivo por devolución, compartido entre TODOS
// los productos seleccionados en esa misma devolución (no hay tope "por
// producto": pedir 3 productos en una sola devolución sigue exigiendo un
// único motivo de máximo 20 palabras en total, no 20 por cada uno).
const MOTIVO_DEVOLUCION_MAX_PALABRAS = 20;
const contarPalabras = (texto) => textoLimpio(texto).split(/\s+/).filter(Boolean).length;

// Identificador de una línea de "pedidos.items" tal como quedó guardada al
// crear el pedido — mismo criterio de campos que idProductoDeItem (id /
// id_producto / producto_id), pero SIN pasar por parseIdentificadorProducto:
// acá interesa el identificador tal cual (incluido el "combo-5" sintético de
// un combo), no separarlo en tipo/id, para poder comparar contra lo que
// mande el cliente sin perder la posibilidad de devolver un combo completo.
const identificadorLineaPedido = (it) => {
  const raw = it?.id ?? it?.id_producto ?? it?.producto_id;
  return (raw === undefined || raw === null || raw === '') ? null : String(raw);
};

// Acepta tanto el formato nuevo ("items": [{producto_id o item_index,
// cantidad}, ...]) como el formato viejo (producto_id o item_index sueltos,
// junto a "cantidad", directo en el body) — se normalizan a la misma forma
// de lista para que el resto del handler no tenga que distinguir entre los
// dos. Un "items" vacío no cae al formato viejo (evita que {items: []} se
// confunda con "no mandaron items").
const normalizarItemsSolicitados = (body) => {
  if (Array.isArray(body.items) && body.items.length > 0) {
    return body.items.map(it => ({
      producto_id: it?.producto_id ?? it?.id ?? null,
      item_index:  it?.item_index,
      cantidad:    it?.cantidad,
    }));
  }
  if (body.producto_id !== undefined || body.item_index !== undefined) {
    return [{ producto_id: body.producto_id, item_index: body.item_index, cantidad: body.cantidad }];
  }
  return [];
};

devRouter.post('/', auth, async (req, res) => {
  try {

  const { pedido_id, monto, tipo } = req.body;
  if (!pedido_id) return res.status(400).json({ error: 'pedido_id es requerido' });

  const motivoLimpio = textoLimpio(req.body.motivo);
  if (!motivoLimpio) {
    return res.status(400).json({ error: 'El motivo de la devolución es obligatorio y no puede contener solo espacios en blanco.' });
  }
  const errorMotivo = errorLongitud(motivoLimpio, 'El motivo de la devolución', LIMITES.MOTIVO, LIMITES.MOTIVO_MINIMO);
  if (errorMotivo) return res.status(400).json({ error: errorMotivo });
  if (contarPalabras(motivoLimpio) > MOTIVO_DEVOLUCION_MAX_PALABRAS) {
    return res.status(400).json({ error: `El motivo de la devolución no puede superar las ${MOTIVO_DEVOLUCION_MAX_PALABRAS} palabras.` });
  }
  const motivo = motivoLimpio;

  const solicitados = normalizarItemsSolicitados(req.body);
  if (solicitados.length === 0) {
    return res.status(400).json({ error: 'Debes indicar al menos un producto a devolver ("items", o "producto_id"/"item_index" sueltos).' });
  }

  // Los productos/cantidades a devolver NUNCA se toman de lo que mande el
  // cliente: se resuelven contra "pedidos.items" ya guardado en el backend
  // (ver comentario de enriquecerItemsPedido más arriba — ese mismo array es
  // la fuente de verdad de qué y cuánto se compró en este pedido), así un
  // cliente no puede inventar un producto que no estaba en el pedido ni
  // pedir devolver más unidades de las que realmente compró.
  const { rows: pedidoRows } = await pool.query('SELECT id, items FROM pedidos WHERE id=$1', [pedido_id]);
  if (!pedidoRows[0]) return res.status(404).json({ error: 'Pedido no encontrado' });
  const pedidoItems = Array.isArray(pedidoRows[0].items) ? pedidoRows[0].items : [];

  const itemsResueltos = [];
  const acumuladoPorId = new Map(); // suma lo pedido en ESTA devolución por identificador, para el tope de "no exceder lo comprado" cuando el mismo producto aparece más de una vez en la solicitud
  for (let i = 0; i < solicitados.length; i++) {
    const solicitado = solicitados[i];
    const numeroItem = i + 1;

    let idx = null;
    if (solicitado.item_index !== undefined && solicitado.item_index !== null && solicitado.item_index !== '') {
      const n = Number(solicitado.item_index);
      if (!Number.isInteger(n) || n < 0 || n >= pedidoItems.length) {
        return res.status(400).json({ error: `item_index inválido en el ítem ${numeroItem}: no existe esa línea en el pedido ${pedido_id}.` });
      }
      idx = n;
    }

    const idPorIndex = idx !== null ? identificadorLineaPedido(pedidoItems[idx]) : null;
    const idPedido = idx !== null
      ? idPorIndex
      : (solicitado.producto_id !== undefined && solicitado.producto_id !== null && solicitado.producto_id !== ''
          ? String(solicitado.producto_id) : null);
    if (!idPedido) {
      return res.status(400).json({ error: `Cada ítem debe indicar "producto_id" o "item_index" (ítem ${numeroItem}).` });
    }

    if (idx === null) {
      idx = pedidoItems.findIndex(it => identificadorLineaPedido(it) === idPedido);
      if (idx === -1) {
        return res.status(400).json({ error: `El producto (${idPedido}) no pertenece al pedido ${pedido_id}.` });
      }
    } else if (solicitado.producto_id !== undefined && solicitado.producto_id !== null && solicitado.producto_id !== ''
               && String(solicitado.producto_id) !== idPorIndex) {
      return res.status(400).json({ error: `"producto_id" no coincide con "item_index" en el ítem ${numeroItem}.` });
    }

    const cantidad = Number(solicitado.cantidad);
    if (!Number.isInteger(cantidad) || cantidad <= 0) {
      return res.status(400).json({ error: `La cantidad a devolver del ítem ${numeroItem} debe ser un número entero mayor que cero.` });
    }

    // Cantidad comprada de este producto en TODO el pedido — sumada entre
    // todas las líneas que compartan el mismo identificador (ej. el mismo
    // producto pedido dos veces con toppings distintos), no solo la línea
    // puntual que resolvió este ítem.
    const totalComprado = pedidoItems.reduce(
      (suma, it) => identificadorLineaPedido(it) === idPedido ? suma + (Number(it.cantidad) || 1) : suma,
      0
    );
    const previoEnEstaSolicitud = acumuladoPorId.get(idPedido) || 0;
    if (previoEnEstaSolicitud + cantidad > totalComprado) {
      const linea = pedidoItems[idx];
      return res.status(400).json({
        error: `La cantidad a devolver de "${linea?.nombre ?? idPedido}" (${previoEnEstaSolicitud + cantidad}) excede lo comprado en el pedido (${totalComprado}).`,
      });
    }
    acumuladoPorId.set(idPedido, previoEnEstaSolicitud + cantidad);

    const linea = pedidoItems[idx];
    itemsResueltos.push({
      producto_id: idPedido,
      item_index: idx,
      nombre: linea?.nombre ?? null,
      precio: linea?.precio ?? null,
      cantidad,
    });
  }

  const { rows } = await pool.query(
    // El default de la columna quedó en 'Pendiente' (con mayúscula) pero
    // todo el frontend compara contra 'pendiente' en minúscula; sin este
    // INSERT explícito la devolución recién creada no coincidía con
    // ningún filtro ni mostraba los botones de aprobar/rechazar.
    `INSERT INTO devoluciones(pedido_id,motivo,monto,items,tipo,estado)
     VALUES($1,$2,$3,$4,$5,'pendiente') RETURNING id`,
    [pedido_id, motivo, monto || 0, JSON.stringify(itemsResueltos), tipo || (itemsResueltos.length > 1 ? 'parcial' : 'total')]
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

 
  if (rows[0].pedido_id) {
    const nuevoEstadoVenta = estado === 'aprobada' ? 'devuelto' : 'vendido';
    await pool.query('UPDATE ventas SET estado=$1 WHERE pedido_id=$2', [nuevoEstadoVenta, rows[0].pedido_id]);
  }

  const { rows: full } = await pool.query(`${DEV_SELECT} WHERE d.id=$1`, [rows[0].id]);
  res.json(full[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
r.use('/devoluciones', devRouter);


const FICHA_COLS = `
  SELECT f.id, f.producto_id AS id_producto, p.nombre AS producto_nombre,
    f.categoria_prep, f.porciones, f.tiempo_prep, f.costo_estimado, f.estado,
    f.notas, f.resumen_prep, f.preparacion, f.vaso_id,
    f.ingredientes AS insumos, f.toppings_ficha AS toppings, f.created_at AS fecha_registro
  FROM fichas_tecnicas f LEFT JOIN productos p ON f.producto_id = p.id
`;


const costoEstimadoSuperaPrecio = async (idProducto, costoEstimado) => {
  if (!idProducto || costoEstimado === undefined || costoEstimado === null) return false;
  const { rows } = await pool.query('SELECT precio FROM productos WHERE id=$1', [idProducto]);
  if (!rows[0]) return false;
  return Number(costoEstimado) > Number(rows[0].precio);
};


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
 
  const errorTextoFicha =
    errorLongitud(notas,        'Las notas',                 LIMITES.NOTAS_FICHA) ||
    errorLongitud(resumen_prep, 'El resumen de preparación', LIMITES.NOTAS_FICHA) ||
    errorLongitud(preparacion,  'La preparación',            LIMITES.PREPARACION);
  if (errorTextoFicha) return res.status(400).json({ error: errorTextoFicha });
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
  
  const errorTextoFicha =
    errorLongitud(notas,        'Las notas',                 LIMITES.NOTAS_FICHA) ||
    errorLongitud(resumen_prep, 'El resumen de preparación', LIMITES.NOTAS_FICHA) ||
    errorLongitud(preparacion,  'La preparación',            LIMITES.PREPARACION);
  if (errorTextoFicha) return res.status(400).json({ error: errorTextoFicha });
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

fichaRouter.patch('/:id/estado', auth, async (req, res) => {
  try {
  
  const { rows: actual } = await pool.query(
    'SELECT producto_id, estado FROM fichas_tecnicas WHERE id=$1', [req.params.id]
  );
  if (!actual[0]) return res.status(404).json({ error: 'Ficha técnica no encontrada' });
  const vaAQuedarActiva = !actual[0].estado;
  if (vaAQuedarActiva && await existeFichaActivaParaProducto(actual[0].producto_id, req.params.id)) {
    return res.status(400).json({ error: 'Ya existe una ficha técnica activa para este producto. Edítala en vez de crear una nueva.' });
  }
  const { rows } = await pool.query(
    `UPDATE fichas_tecnicas SET estado = NOT estado WHERE id=$1 RETURNING id, producto_id, estado`,
    [req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Ficha técnica no encontrada' });

  // Cascada ficha → producto: un producto sin ficha técnica activa no se
  // puede preparar, así que no debe seguir ofreciéndose en el menú. Al
  // desactivar la ficha se desactiva también su producto; al reactivarla se
  // vuelve a activar. Solo se toca el producto directamente asociado a esta
  // ficha (nunca otros), y solo si la ficha tiene producto.
  if (rows[0].producto_id) {
    await pool.query(
      `UPDATE productos SET estado=$1 WHERE id=$2`,
      [rows[0].estado ? 'Activo' : 'Inactivo', rows[0].producto_id]
    );
  }

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


const dispRouter = require('express').Router();
dispRouter.get('/', async (req, res) => {
  try {
    const { rows: fichas } = await pool.query(
      `SELECT producto_id, ingredientes FROM fichas_tecnicas WHERE estado = true`
    );
   
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
// La tabla "locales" no tiene UNIQUE sobre el nombre (la semilla inicial se
// apoya en eso), así que sin esta comprobación se podían crear dos sedes
// llamadas exactamente igual, y el selector del checkout quedaba con dos
// opciones idénticas e indistinguibles.
localRouter.post('/', auth, permitirRoles('Administrador'), async (req, res) => {
  try {
  const { direccion } = req.body;
  const errorNom = errorNombre(req.body.nombre, 'El nombre del local', LIMITES.NOMBRE_CORTO);
  if (errorNom) return res.status(400).json({ error: errorNom });
  const nombre = nombreNormalizado(req.body.nombre);
  if (await nombreDuplicado(pool, 'locales', nombre, null)) {
    return res.status(400).json({ error: 'Ya existe un local con ese nombre.' });
  }
  const { rows } = await pool.query(
    `INSERT INTO locales(nombre, direccion) VALUES($1,$2) RETURNING *`,
    [nombre, direccion || null]
  );
  res.status(201).json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
localRouter.put('/:id', auth, permitirRoles('Administrador'), async (req, res) => {
  try {
  const { direccion } = req.body;
  const errorNom = errorNombre(req.body.nombre, 'El nombre del local', LIMITES.NOMBRE_CORTO);
  if (errorNom) return res.status(400).json({ error: errorNom });
  const nombre = nombreNormalizado(req.body.nombre);
  if (await nombreDuplicado(pool, 'locales', nombre, req.params.id)) {
    return res.status(400).json({ error: 'Ya existe un local con ese nombre.' });
  }
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
  const { cliente_id, calificacion } = req.body;
  // El límite de 400 caracteres existía solo como contador visual en la
  // landing; por API se podía mandar cualquier tamaño, o puros espacios.
  const texto = textoLimpio(req.body.texto);
  if (!texto) {
    return res.status(400).json({ error: 'El texto de la reseña es obligatorio y no puede contener solo espacios en blanco.' });
  }
  const errorTexto = errorLongitud(texto, 'El texto de la reseña', LIMITES.RESENA);
  if (errorTexto) return res.status(400).json({ error: errorTexto });
  // La calificación debe ser un entero de 1 a 5 (la columna es integer y el
  // widget de estrellas nunca manda otra cosa, pero por API sí se podía).
  const nota = Number(calificacion ?? 5);
  if (!Number.isInteger(nota) || nota < 1 || nota > 5) {
    return res.status(400).json({ error: 'La calificación debe ser un número entero entre 1 y 5.' });
  }
  const { rows } = await pool.query(
    `INSERT INTO resenas(cliente_id,texto,calificacion) VALUES($1,$2,$3) RETURNING *`,
    [cliente_id || null, texto, nota]
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