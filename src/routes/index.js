const express = require('express');
const crypto  = require('crypto');
const pool    = require('../config/db');
const { auth, permitirRoles } = require('../middleware/auth');
const bcrypt  = require('bcryptjs');
const crud    = require('./crud');
const validateId = require('../middleware/validateId');
const { passwordValida, PASSWORD_ERROR, errorPassword } = require('../config/passwordPolicy');
// Validaciones compartidas de texto: nombres vacíos / solo espacios,
// duplicados sin distinguir mayúsculas ni espacios de más, y topes de
// longitud. Ver config/validaciones.js.
const {
  textoLimpio, nombreNormalizado, LIMITES,
  errorNombre, errorLongitud, errorDocumento, nombreDuplicado,
} = require('../config/validaciones');
// Vocabulario y derivación del "tipo de preparación" de una ficha técnica a
// partir de la categoría del producto. Ver config/tiposPreparacion.js.
const { resolverTipoPreparacion } = require('../config/tiposPreparacion');

const r = express.Router();

// Traduce el "local" que manda el formulario de usuarios/empleados a un
// locales.id real, para guardar usuarios.local_id (lo que POST /insumos
// necesita después): usa el local_id explícito si vino y existe; si no, el
// local cuyo nombre coincide con "sede" (los registros nuevos ya guardan
// ahí el nombre real del local); si nada coincide (ej. Administrador con
// sede 'Ambos', o 'Local 1'/'Local 2' heredados), devuelve null.
const resolverLocalIdUsuario = async (localIdBody, sede) => {
  const explicito = Number(localIdBody);
  if (Number.isInteger(explicito) && explicito > 0) {
    const { rows } = await pool.query('SELECT id FROM locales WHERE id=$1', [explicito]);
    if (rows[0]) return explicito;
  }
  if (sede) {
    const { rows } = await pool.query(
      `SELECT id FROM locales WHERE lower(btrim(nombre)) = lower(btrim($1)) LIMIT 1`, [sede]
    );
    if (rows[0]) return rows[0].id;
  }
  return null;
};

// El formulario de usuarios (UsuarioFormPage.jsx) manda `rolId` — el id de
// la fila en `roles` — pero POST y PUT /usuarios solo leían `rol`, que es
// el NOMBRE. Ese campo nunca llegaba, así que el INSERT recibía `undefined`
// → NULL, y como usuarios.rol es NOT NULL la creación fallaba (o, en las
// rutas que sí pasaban, dejaba el usuario con un rol que no existe en la
// tabla `roles` — y entonces permisosDeRol() no encuentra nada y ese
// usuario se queda con el panel vacío para siempre).
// Ahora se acepta cualquiera de los dos y se traduce el id a nombre, que
// es lo que guarda la columna (usuarios.rol NO es una FK, ver la nota de
// contarUsuariosConRol).
const resolverNombreRol = async (rolBody, rolIdBody) => {
  const nombreDirecto = String(rolBody ?? '').trim();
  if (nombreDirecto) {
    // Se devuelve el nombre tal como está guardado en `roles` (respetando
    // sus mayúsculas), no como lo escribió quien llamó la API: así
    // usuarios.rol siempre coincide exactamente con roles.nombre.
    const { rows } = await pool.query(
      'SELECT nombre FROM roles WHERE lower(btrim(nombre)) = lower(btrim($1)) LIMIT 1', [nombreDirecto]
    );
    return rows[0] ? rows[0].nombre : nombreDirecto;
  }
  const id = Number(rolIdBody);
  if (Number.isInteger(id) && id > 0) {
    const { rows } = await pool.query('SELECT nombre FROM roles WHERE id=$1', [id]);
    if (rows[0]) return rows[0].nombre;
  }
  return null;
};

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
  // Filtro opcional por local (?local_id=), igual que en /empleados.
  const { local_id } = req.query;
  const params = [];
  let where = '';
  if (local_id !== undefined && local_id !== '') {
    params.push(Number(local_id));
    where = 'WHERE local_id = $1';
  }
  const { rows } = await pool.query(`SELECT id,nombre,username,correo,rol,sede,local_id,estado,es_superadmin,created_at FROM usuarios ${where} ORDER BY id DESC`, params);
  res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
usrRouter.get('/:id', auth, async (req, res) => {
  try {
  const { rows } = await pool.query('SELECT id,nombre,username,correo,rol,sede,local_id,estado,es_superadmin FROM usuarios WHERE id=$1', [req.params.id]);
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

  if (!passwordValida(password)) return res.status(400).json({ error: errorPassword(password) });
  try {
    // Ver resolverNombreRol: el formulario manda rolId, no rol.
    const rolNombre = await resolverNombreRol(rol, req.body.rolId);
    if (!rolNombre) return res.status(400).json({ error: 'Selecciona un rol válido.' });
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
    const sedeFinal = rolNombre === 'Administrador' ? 'Ambos' : (sede || 'Local 1');
    // local_id: referencia real a locales.id (lo que POST /insumos usa para
    // el local de trabajo). Se deriva del local elegido en el formulario;
    // queda NULL para el Administrador o si "sede" no es un local del
    // catálogo. es_superadmin nunca se recibe del cliente: todo usuario
    // nuevo se crea con es_superadmin=false por el DEFAULT de la columna.
    const localIdUsuario = await resolverLocalIdUsuario(req.body.local_id, sedeFinal);
    const { rows } = await pool.query(
      'INSERT INTO usuarios(nombre,username,correo,password,rol,sede,local_id) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id,nombre,username,correo,rol,sede,local_id,es_superadmin',
      [nombre, username, correo || null, hash, rolNombre, sedeFinal, localIdUsuario]
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
    // Mismo caso que en el POST: el formulario manda rolId, no rol.
    const rolPedido = await resolverNombreRol(rol, req.body.rolId);
    const rolFinal = actual[0].es_superadmin ? actual[0].rol : (rolPedido || actual[0].rol);
    // Igual que en la creación: Administrador siempre queda en 'Ambos'.
    const sedeFinal = rolFinal === 'Administrador' ? 'Ambos' : (sede || 'Local 1');
    // Se mantiene usuarios.local_id en sync con el local elegido (ver POST).
    const localIdUsuario = await resolverLocalIdUsuario(req.body.local_id, sedeFinal);

    let q, vals;
    if (password) {
      if (!passwordValida(password)) return res.status(400).json({ error: errorPassword(password) });
      const hash = await bcrypt.hash(password, 10);
      q = 'UPDATE usuarios SET nombre=$1,username=$2,correo=$3,password=$4,rol=$5,sede=$6,local_id=$7 WHERE id=$8 RETURNING id,nombre,username,correo,rol,sede,local_id,es_superadmin';
      vals = [nombre, username, correo || null, hash, rolFinal, sedeFinal, localIdUsuario, req.params.id];
    } else {
      q = 'UPDATE usuarios SET nombre=$1,username=$2,correo=$3,rol=$4,sede=$5,local_id=$6 WHERE id=$7 RETURNING id,nombre,username,correo,rol,sede,local_id,es_superadmin';
      vals = [nombre, username, correo || null, rolFinal, sedeFinal, localIdUsuario, req.params.id];
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
  const errorDoc = errorDocumento(numeroDoc);
  if (errorDoc) return res.status(400).json({ error: errorDoc });
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
  // `comuna` se leía en el PUT del propio cliente (/me) pero NO aquí, así
  // que al editar un cliente desde el panel de administración el campo se
  // descartaba en silencio: la pantalla lo mostraba y lo enviaba, y el
  // cliente se quedaba con la comuna que puso al registrarse.
  //
  // El CASE de abajo distingue dos situaciones que NO son lo mismo:
  //   • el cliente HTTP no mandó "comuna"  → se conserva la que ya tenía
  //     (así un consumidor antiguo de esta API no borra el dato sin querer);
  //   • la mandó vacía                     → se limpia a propósito (es lo
  //     que pasa cuando el cliente deja de vivir en Medellín, donde el
  //     selector de comuna ni siquiera se muestra).
  const { nombre, telefono, tipoDoc, numeroDoc, departamento, municipio, comuna, direccion } = req.body;
  if (!nombre || !nombre.trim()) return res.status(400).json({ error: 'El nombre es obligatorio.' });
  if (tipoDoc === 'Otros') return res.status(400).json({ error: 'Debes especificar el tipo de documento.' });
  const errorDoc = errorDocumento(numeroDoc);
  if (errorDoc) return res.status(400).json({ error: errorDoc });
  const mandoComuna = comuna !== undefined;
  const { rows } = await pool.query(
    `UPDATE clientes SET nombre=$1, telefono=$2, tipo_doc=$3, numero_doc=$4,
       departamento=$5, municipio=$6, direccion=$7,
       comuna = CASE WHEN $8::boolean THEN $9 ELSE comuna END
     WHERE id=$10 RETURNING ${CLIENTE_COLS}`,
    [nombre, telefono || null, tipoDoc || null, numeroDoc || null, departamento || null, municipio || null, direccion || null,
     mandoComuna, mandoComuna ? (textoLimpio(comuna) || null) : null, req.params.id]
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
    // Filtro opcional por local (?local_id=): así el listado de Empleados
    // puede mostrarse "por local". Sin el parámetro, devuelve todos (igual
    // que antes). local_id se guarda por el formulario de empleados y se
    // propaga a usuarios.local_id (JWT) para Cajero/Bartender.
    const { local_id } = req.query;
    const params = [];
    let where = '';
    if (local_id !== undefined && local_id !== '') {
      params.push(Number(local_id));
      where = `WHERE local_id = $1`;
    }
    const { rows } = await pool.query(`SELECT * FROM empleados ${where} ORDER BY id DESC`, params);
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
  // Documento, dirección y local: el formulario siempre los envió, pero
  // antes se descartaban en silencio (ni el INSERT ni las columnas
  // existían). Ver la migración de empleados en config/db.js.
  const tipoDoc   = textoLimpio(req.body.tipoDoc   ?? req.body.tipo_doc)   || null;
  const numeroDoc = textoLimpio(req.body.numeroDoc ?? req.body.numero_doc) || null;
  const direccion = textoLimpio(req.body.direccion) || null;
  const localId   = Number.isInteger(Number(req.body.local_id)) && Number(req.body.local_id) > 0
    ? Number(req.body.local_id) : null;
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
      if (!passwordValida(password)) return res.status(400).json({ error: errorPassword(password) });
      const hash = await bcrypt.hash(password, 10);
      // usuarios.local_id en sync con el local del empleado (lo que POST
      // /insumos usa como "local de trabajo" del cajero/bartender).
      const localIdUsuario = await resolverLocalIdUsuario(localId, sedeFinal);
      const { rows: nuevoUsuario } = await pool.query(
        'INSERT INTO usuarios(nombre,username,correo,password,rol,sede,local_id) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id',
        [nombre, username, correo || null, hash, cargo, sedeFinal, localIdUsuario]
      );
      usuarioId = nuevoUsuario[0].id;
    }
    const { rows } = await pool.query(
      `INSERT INTO empleados(nombre,cargo,telefono,correo,estado,sede,usuario_id,tipo_doc,numero_doc,direccion,local_id)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [nombre, cargo || null, telefono || null, correo || null, estado || 'Activo', sedeFinal, usuarioId,
       tipoDoc, numeroDoc, direccion, localId]
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
  // Mismos campos que en el POST (ver ahí el motivo).
  const tipoDoc   = textoLimpio(req.body.tipoDoc   ?? req.body.tipo_doc)   || null;
  const numeroDoc = textoLimpio(req.body.numeroDoc ?? req.body.numero_doc) || null;
  const direccion = textoLimpio(req.body.direccion) || null;
  const localId   = Number.isInteger(Number(req.body.local_id)) && Number(req.body.local_id) > 0
    ? Number(req.body.local_id) : null;
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
    // usuarios.local_id en sync con el local del empleado (ver POST).
    const localIdUsuario = await resolverLocalIdUsuario(localId, sedeFinal);

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
          if (!passwordValida(password)) return res.status(400).json({ error: errorPassword(password) });
          const hash = await bcrypt.hash(password, 10);
          await pool.query(
            'UPDATE usuarios SET nombre=$1,username=COALESCE($2,username),correo=$3,password=$4,rol=$5,sede=$6,local_id=$7 WHERE id=$8',
            [nombre, username || null, correo || null, hash, cargo, sedeFinal, localIdUsuario, usuarioId]
          );
        } else {
          await pool.query(
            'UPDATE usuarios SET nombre=$1,username=COALESCE($2,username),correo=$3,rol=$4,sede=$5,local_id=$6 WHERE id=$7',
            [nombre, username || null, correo || null, cargo, sedeFinal, localIdUsuario, usuarioId]
          );
        }
      } else if (username && password) {
        // Antes no tenía cuenta (ej. cambió de "Barista" a "Cajero"): se crea ahora.
        if (!passwordValida(password)) return res.status(400).json({ error: errorPassword(password) });
        const hash = await bcrypt.hash(password, 10);
        const { rows: nuevoUsuario } = await pool.query(
          'INSERT INTO usuarios(nombre,username,correo,password,rol,sede,local_id) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id',
          [nombre, username, correo || null, hash, cargo, sedeFinal, localIdUsuario]
        );
        usuarioId = nuevoUsuario[0].id;
      } else {
        return res.status(400).json({ error: 'Usuario y contraseña son obligatorios para el cargo ' + cargo + '.' });
      }
    }

    const { rows } = await pool.query(
      `UPDATE empleados SET nombre=$1,cargo=$2,telefono=$3,correo=$4,estado=$5,sede=$6,usuario_id=$7,
         tipo_doc=$8,numero_doc=$9,direccion=$10,local_id=$11
       WHERE id=$12 RETURNING *`,
      [nombre, cargo || null, telefono || null, correo || null, estado || 'Activo', sedeFinal, usuarioId,
       tipoDoc, numeroDoc, direccion, localId, req.params.id]
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
  i.local_id AS "localId", lo.nombre AS "localNombre",
  i.created_at AS "fechaCreacion"
`;
const INSUMO_JOINS = `
  FROM insumos i
  LEFT JOIN proveedores p ON i.proveedor_id = p.id
  LEFT JOIN categorias_insumos ci ON i.categoria_id = ci.id
  LEFT JOIN locales lo ON i.local_id = lo.id
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
  const { estado, q, esTopping, local_id, stockBajo } = req.query;
  const condiciones = [];
  const params = [];
  if (estado)    { params.push(estado); condiciones.push(`i.estado = $${params.length}`); }
  if (q)         { params.push(`%${q}%`); condiciones.push(`i.nombre ILIKE $${params.length}`); }
  if (esTopping !== undefined) { params.push(esTopping === 'true'); condiciones.push(`i.es_topping = $${params.length}`); }
  // ?local_id= filtra por local (los insumos ahora son por local).
  if (local_id !== undefined && local_id !== '') { params.push(Number(local_id)); condiciones.push(`i.local_id = $${params.length}`); }
  // ?stockBajo=true → solo insumos en/por debajo de su stock mínimo (con
  // mínimo definido). Mismo criterio que GET /insumos/alertas-stock.
  if (stockBajo === 'true') {
    condiciones.push(`COALESCE(i.stock_minimo, 0) > 0`);
    condiciones.push(`COALESCE(i.stock, 0) <= COALESCE(i.stock_minimo, 0)`);
  }
  const where = condiciones.length ? `WHERE ${condiciones.join(' AND ')}` : '';
  const { rows } = await pool.query(`SELECT ${INSUMO_COLS} ${INSUMO_JOINS} ${where} ORDER BY i.id DESC`, params);
  res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Alerta de "stock bajo" del Dashboard: insumos ACTIVOS cuyo stock actual
// está en o por debajo de su stock mínimo (y con un mínimo > 0 definido).
// Filtrado por local:
//   • Empleado con local asignado (req.user.local_id, del JWT) → SOLO su
//     local — un cajero/bartender solo ve el stock bajo de su propio local.
//   • Administrador (sin local_id) → todos los locales; puede acotar con
//     ?local_id=<id>.
// Respuesta:
//   {
//     total,                       // conteo (para el badge "N insumos con stock bajo")
//     alcance: 'local' | 'todos',
//     nombres: [ ... ],            // solo los nombres, para un resumen rápido
//     items: [ { id, nombre, stockActual, stockMinimo, localId, localNombre, ... } ],
//     porLocal: [ { localId, localNombre, total, items: [...] } ]  // detalle agrupado
//   }
// El Dashboard muestra "total" en la tarjeta; al hacer clic, despliega
// "porLocal" (o "items") con el local de cada insumo.
insRouter.get('/alertas-stock', auth, async (req, res) => {
  try {
  const params = [];
  const cond = [
    `i.estado = 'Activo'`,
    `COALESCE(i.stock_minimo, 0) > 0`,
    `COALESCE(i.stock, 0) <= COALESCE(i.stock_minimo, 0)`,
  ];
  // Empleado con local fijo → SOLO su local. Admin/Superadmin (sin local) →
  // todos; puede acotar con ?local_id=.
  const localOperativo = Number(req.user.local_id) || Number(req.query.local_id) || null;
  if (localOperativo) { params.push(localOperativo); cond.push(`i.local_id = $${params.length}`); }
  const { rows } = await pool.query(
    `SELECT ${INSUMO_COLS} ${INSUMO_JOINS}
      WHERE ${cond.join(' AND ')}
      ORDER BY (COALESCE(i.stock,0) - COALESCE(i.stock_minimo,0)) ASC, i.nombre ASC`,
    params
  );
  // Agrupado por local para el detalle del Dashboard (útil sobre todo para
  // el Administrador, que ve varios locales a la vez).
  const grupos = new Map();
  for (const it of rows) {
    const clave = it.localId ?? 'sin_local';
    if (!grupos.has(clave)) {
      grupos.set(clave, { localId: it.localId ?? null, localNombre: it.localNombre ?? 'Sin local asignado', total: 0, items: [] });
    }
    const g = grupos.get(clave);
    g.total++;
    g.items.push(it);
  }
  res.json({
    total: rows.length,
    alcance: localOperativo ? 'local' : 'todos',
    nombres: rows.map(r => r.nombre),
    items: rows,
    porLocal: [...grupos.values()],
  });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
insRouter.get('/:id', auth, async (req, res) => {
  try {
  const { rows } = await pool.query(`SELECT ${INSUMO_COLS} ${INSUMO_JOINS} WHERE i.id=$1`, [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Insumo no encontrado' });
  res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// El nombre de un insumo debe ser único dentro de un mismo LOCAL (el mismo
// nombre SÍ puede existir en dos locales distintos — cada uno es un insumo
// aparte, con su propio stock). Antes la unicidad era por proveedor; ahora
// es por local, coherente con "cada insumo pertenece a un único local".
const insumoNombreDuplicado = async (nombre, localId, excluirId) => {
  if (!nombre || !localId) return false;
  const params = excluirId ? [nombre, localId, excluirId] : [nombre, localId];
  const cond = excluirId ? 'lower(nombre)=lower($1) AND local_id=$2 AND id<>$3' : 'lower(nombre)=lower($1) AND local_id=$2';
  const { rows } = await pool.query(`SELECT id FROM insumos WHERE ${cond} LIMIT 1`, params);
  return !!rows[0];
};

// ¿El usuario autenticado es el Superadministrador? (usuarios.es_superadmin —
// hoy: solo 'Admin_Sicaber', el usuario raíz sembrado en schema.sql). Se lee
// del JWT si viene (tokens nuevos) y, si no, de la BD — así funciona también
// con sesiones abiertas antes de este cambio.
const esSuperadmin = async (reqUser) => {
  if (reqUser && typeof reqUser.es_superadmin === 'boolean') return reqUser.es_superadmin;
  if (!reqUser?.id) return false;
  const { rows } = await pool.query('SELECT es_superadmin FROM usuarios WHERE id=$1', [reqUser.id]);
  return !!rows[0]?.es_superadmin;
};

// Local al que pertenece un insumo que se está registrando:
//   • Superadministrador (o cualquier usuario SIN local_id fijo): NO se le
//     asume ningún local — DEBE elegirlo explícitamente en el body
//     (`local_id`). Es el comportamiento previo a "local automático".
//   • Cajero/Bartender/Admin CON local_id: se usa el suyo, automático e
//     inmutable — cualquier `local_id` distinto en el body se ignora.
// Devuelve { localId } o { error, requiereSeleccionLocal } (para que el
// frontend sepa que tiene que mostrar el selector de local).
const resolverLocalDeTrabajo = async (req) => {
  const superadmin = await esSuperadmin(req.user);
  // El superadmin nunca "tiene" un local operativo aunque su fila lo tuviera.
  const asignado = superadmin ? null : (Number(req.user?.local_id) || null);
  let localId = asignado;
  if (!localId) {
    const explicito = Number(req.body?.local_id);
    if (!Number.isInteger(explicito) || explicito <= 0) {
      return {
        error: superadmin
          ? 'Como Superadministrador no tenés un local fijo: elegí a qué local pertenece este insumo (campo "local_id").'
          : 'Tu usuario no tiene un local de trabajo asignado: elegí el local ("local_id") o pedí a un administrador que te asigne uno.',
        requiereSeleccionLocal: true,
      };
    }
    localId = explicito;
  }
  const { rows } = await pool.query(`SELECT id FROM locales WHERE id=$1 AND estado='Activo'`, [localId]);
  if (!rows[0]) return { error: 'El local indicado no existe o no está activo.', requiereSeleccionLocal: !asignado };
  return { localId };
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
  // El local: automático para quien tiene local fijo (inmutable después),
  // elegido a mano por el Superadministrador / usuario sin local fijo.
  const { localId, error: errorLocal, requiereSeleccionLocal } = await resolverLocalDeTrabajo(req);
  if (errorLocal) return res.status(400).json({ error: errorLocal, requiereSeleccionLocal: !!requiereSeleccionLocal });
  if (await insumoNombreDuplicado(nombre, localId, null)) {
    return res.status(400).json({ error: 'Ya existe un insumo con ese nombre en este local.' });
  }
  const { rows } = await pool.query(
    `INSERT INTO insumos(nombre,categoria_id,unidad,stock,stock_minimo,precio_unitario,proveedor_id,descripcion,estado,es_topping,local_id)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
    [nombre, categoriaId || null, unidadMedida || null, stockActual || 0, stockMinimo || 0, precioUnitario || 0, proveedorId || null, descripcion || null, estado || 'Activo', !!esTopping, localId]
  );
  const { rows: full } = await pool.query(`SELECT ${INSUMO_COLS} ${INSUMO_JOINS} WHERE i.id=$1`, [rows[0].id]);
  res.status(201).json(full[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ error: 'Ya existe un insumo con ese nombre en este local.' });
    res.status(500).json({ error: e.message });
  }
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
  const { rows: actual } = await pool.query('SELECT unidad, local_id FROM insumos WHERE id=$1', [req.params.id]);
  if (!actual[0]) return res.status(404).json({ error: 'Insumo no encontrado' });
  const unidadEnviada = unidadMedida || null;
  if (unidadEnviada !== actual[0].unidad) {
    return res.status(400).json({ error: 'La unidad de medida no se puede modificar después de creado el insumo.' });
  }

  // El local de un insumo es inmutable: se ignora/rechaza cualquier intento
  // de cambiarlo. El UPDATE de abajo nunca toca local_id; además, si llega
  // un local_id distinto en el body, se responde con un error explícito.
  if (req.body.local_id !== undefined && req.body.local_id !== null
      && Number(req.body.local_id) !== actual[0].local_id) {
    return res.status(400).json({ error: 'El local de un insumo no se puede modificar después de creado.' });
  }

  // La unicidad de nombre se evalúa contra el local YA guardado del insumo
  // (no contra nada que venga en el body).
  if (await insumoNombreDuplicado(nombre, actual[0].local_id, req.params.id)) {
    return res.status(400).json({ error: 'Ya existe un insumo con ese nombre en este local.' });
  }
  const { rows } = await pool.query(
    `UPDATE insumos SET nombre=$1,categoria_id=$2,unidad=$3,stock_minimo=$4,precio_unitario=$5,proveedor_id=$6,descripcion=$7,estado=$8,es_topping=$9
     WHERE id=$10 RETURNING id`,
    [nombre, categoriaId || null, unidadEnviada, stockMinimo, precioUnitario, proveedorId || null, descripcion || null, estado, !!esTopping, req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Insumo no encontrado' });
  const { rows: full } = await pool.query(`SELECT ${INSUMO_COLS} ${INSUMO_JOINS} WHERE i.id=$1`, [req.params.id]);
  res.json(full[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ error: 'Ya existe un insumo con ese nombre en este local.' });
    res.status(500).json({ error: e.message });
  }
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
  c.local_id AS "localId", lo.nombre AS "localNombre",
  c.created_at AS "fechaCreacion", c.fecha_anulacion AS "fechaAnulacion"
`;
const COMPRA_JOINS = `FROM compras c
  LEFT JOIN proveedores p ON c.proveedor_id = p.id
  LEFT JOIN locales lo ON c.local_id = lo.id`;

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
// `db` opcional: cuando la venta se registra dentro de una transacción
// (marcar un pedido como 'entregado' → crea venta + descuenta stock de forma
// atómica), se pasa el client de esa transacción para que el descuento
// entre en el mismo BEGIN/COMMIT. Por defecto usa el pool (sin transacción).
const ajustarStockInsumoPorId = async (idInsumo, delta, db = pool) => {
  if (!idInsumo) return;
  await db.query(
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

// El local OPERATIVO de un pedido — a qué local pertenece la venta, para
// saber de qué insumos (los de ESE local) descontar el stock. Se resuelve:
//   1º) el local activo cuyo nombre coincide con pedidos.sede (los pedidos
//       nuevos ya guardan ahí el nombre real del local), y si no
//   2º) pedidos.local_id, si apunta a un local activo.
// Si ninguno resuelve, devuelve { error }: la venta NO se puede registrar
// porque el descuento de inventario no sabría a qué local imputarlo (esto
// no debería pasar tras la migración de los pedidos residuales en db.js,
// pero el bloqueo queda como protección).
const resolverLocalOperativoPedido = async (pedido) => {
  if (pedido?.sede) {
    const { rows } = await pool.query(
      `SELECT id, nombre FROM locales WHERE estado='Activo' AND lower(btrim(nombre)) = lower(btrim($1)) LIMIT 1`,
      [pedido.sede]
    );
    if (rows[0]) return { localId: rows[0].id, localNombre: rows[0].nombre };
  }
  if (pedido?.local_id) {
    const { rows } = await pool.query(
      `SELECT id, nombre FROM locales WHERE estado='Activo' AND id=$1 LIMIT 1`, [pedido.local_id]
    );
    if (rows[0]) return { localId: rows[0].id, localNombre: rows[0].nombre };
  }
  return { error: 'No se puede registrar la venta: el pedido no tiene un local válido resuelto (su "sede"/local_id no corresponde a ningún local activo). Asígnale un local al pedido antes de venderlo.' };
};

// Descuenta del inventario, por cada línea del pedido, la receta efectiva
// completa (× la cantidad vendida de esa línea) — insumos base + vaso de
// la ficha técnica + toppings que la unidad conservó + adiciones elegidas
// (sumando también, si la línea es un combo, la receta de cada producto
// que lo compone), ya combinados y sumados por insumo (ver
// calcularRecetaEfectiva).
//
// Multi-local: la ficha técnica (y toppings/adiciones) guarda un id_insumo
// FIJO, pero cada insumo pertenece a un único local. Así que el id_insumo
// de la receta se usa solo para saber el NOMBRE del insumo; el descuento
// real se aplica al insumo ACTIVO de ese mismo nombre EN EL LOCAL DEL
// PEDIDO (localId). Si algún insumo de la receta no existe (activo) en ese
// local, la venta se rechaza ENTERA y no se toca ningún stock — devuelve
// el mensaje de error (string). Devuelve null si todo se aplicó bien.
// `db` opcional (client de transacción): cuando se llama al marcar un pedido
// 'entregado', el descuento va dentro del mismo BEGIN/COMMIT que crea la
// venta. Por defecto usa el pool.
const descontarInventarioPorVenta = async (items, localId, db = pool) => {
  // Devuelve SIEMPRE { faltantes: [...] } — nunca un string de error. Los
  // insumos que no se pudieron descontar son un aviso, no un bloqueo.
  const lista = Array.isArray(items) ? items : [];
  if (!lista.length) return { faltantes: [] };
  const datos = await prepararDatosReceta(lista);

  // 1) Acumular la receta efectiva de TODO el pedido: Map<idInsumoFicha, cantidadTotal>.
  const totalPorInsumoFicha = new Map();
  for (const it of lista) {
    const cantidadVendida = Number(it.cantidad) || 1;
    for (const [idInsumo, cantidadPorUnidad] of calcularRecetaEfectiva(it, datos)) {
      totalPorInsumoFicha.set(idInsumo, (totalPorInsumoFicha.get(idInsumo) || 0) + cantidadPorUnidad * cantidadVendida);
    }
  }
  if (!totalPorInsumoFicha.size) return { faltantes: [] };

  // 2) Nombre de cada insumo referenciado por la receta (id_insumo puede
  //    venir como string desde el JSON de la ficha o como number desde
  //    vaso_id/topping.insumo_id — se normaliza a number para la consulta).
  const idsFicha = [...totalPorInsumoFicha.keys()].map(Number).filter(Number.isFinite);
  const { rows: refs } = idsFicha.length
    ? await db.query(`SELECT id, nombre FROM insumos WHERE id = ANY($1::int[])`, [idsFicha])
    : { rows: [] };
  const nombrePorIdFicha = new Map(refs.map(r => [r.id, r.nombre]));

  // 3) Insumos ACTIVOS del local del pedido, indexados por nombre normalizado.
  const { rows: insLocal } = await db.query(
    `SELECT id, nombre FROM insumos WHERE local_id = $1 AND estado = 'Activo'`, [localId]
  );
  const idLocalPorNombre = new Map(insLocal.map(i => [nombreNormalizado(i.nombre).toLowerCase(), i.id]));

  // 4) Validar TODO antes de tocar stock: cada insumo de la receta —venga de
  //    la ficha técnica, del vaso, de un topping o de una adición— tiene que
  //    tener un homónimo activo en el local del pedido.
  const ajustes = [];
  const faltantes = [];
  for (const [idFicha, total] of totalPorInsumoFicha) {
    if (!(total > 0)) continue;
    const nombre = nombrePorIdFicha.get(Number(idFicha));
    const idLocal = nombre ? idLocalPorNombre.get(nombreNormalizado(nombre).toLowerCase()) : undefined;
    if (!idLocal) { faltantes.push(nombre || `insumo #${idFicha}`); continue; }
    ajustes.push({ idLocal, delta: -total });
  }
  // ANTES: si UN solo insumo de la receta no existía como insumo activo en
  // el local del pedido, se devolvía un error, la transacción hacía ROLLBACK
  // y el pedido NO se podía marcar como entregado. En la práctica eso dejaba
  // pedidos ya servidos al cliente atascados en el sistema por un problema
  // de catálogo: un ingrediente registrado en otro local, dado de baja, o
  // escrito distinto ("Crema chantilly" vs "Crema Chantilly").
  //
  // AHORA no bloquea. Se descuenta todo lo que SÍ se puede descontar y los
  // que faltan se devuelven como AVISO, para que quien entrega se entere y
  // pueda corregir el inventario después. El razonamiento: el producto ya se
  // preparó y se entregó — impedir el registro no devuelve el insumo al
  // almacén, solo esconde la venta.
  //
  // Ojo con lo que esto implica: el stock de los insumos faltantes NO se
  // descuenta (no hay fila que descontar en ese local). El aviso es lo que
  // evita que esa diferencia pase inadvertida.
  //
  // El stock en CERO nunca fue el problema, y sigue sin serlo:
  // ajustarStockInsumoPorId usa GREATEST(stock + delta, 0), así que un insumo
  // en cero se descuenta hasta cero y la venta pasa igual.

  // 5) Aplicar los descuentos que sí se pudieron resolver.
  for (const a of ajustes) await ajustarStockInsumoPorId(a.idLocal, a.delta, db);
  return { faltantes: [...new Set(faltantes)] };
};

// Registra la venta de un pedido + descuenta su inventario, TODO en una
// transacción y de forma IDEMPOTENTE: si el pedido ya tiene venta, no hace
// nada (no re-inserta ni re-descuenta). Devuelve { ventaId } si quedó
// registrada (nueva o ya existente) o { error } si el local no resuelve o
// falta un insumo — en ese caso no se toca nada (ROLLBACK).
// La usan tanto PATCH /pedidos/:id/estado (al pasar a 'entregado') como
// POST /ventas/desde-pedido.
const registrarVentaDePedido = async (pedido) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: ya } = await client.query('SELECT id FROM ventas WHERE pedido_id=$1 LIMIT 1', [pedido.id]);
    if (ya[0]) { await client.query('COMMIT'); return { ventaId: ya[0].id, yaExistia: true }; }

    const local = await resolverLocalOperativoPedido(pedido);
    if (local.error) { await client.query('ROLLBACK'); return { error: local.error }; }

    // Ya no aborta por insumos faltantes: devuelve la lista para avisar.
    const { faltantes } = await descontarInventarioPorVenta(pedido.items, local.localId, client);

    const { rows } = await client.query(
      `INSERT INTO ventas(pedido_id, total, estado) VALUES($1,$2,'vendido') RETURNING id`,
      [pedido.id, pedido.total]
    );
    await client.query('COMMIT');
    return { ventaId: rows[0].id, faltantes };
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    return { error: e.message };
  } finally {
    client.release();
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
  // Filtro opcional por local (?local_id=): para "ver compras de este
  // local". Sin el parámetro, devuelve todas las activas (igual que antes).
  const { local_id } = req.query;
  const params = [];
  let cond = `c.estado='activa'`;
  if (local_id !== undefined && local_id !== '') {
    params.push(Number(local_id));
    cond += ` AND c.local_id = $${params.length}`;
  }
  const { rows } = await pool.query(`SELECT ${COMPRA_COLS} ${COMPRA_JOINS} WHERE ${cond} ORDER BY c.id DESC`, params);
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
  // Filtro opcional por local (?local_id=), igual que en GET /compras.
  const { local_id } = req.query;
  const params = [dias];
  let filtroLocal = '';
  if (local_id !== undefined && local_id !== '') {
    params.push(Number(local_id));
    filtroLocal = ` AND c.local_id = $${params.length}`;
  }
  const { rows } = await pool.query(
    `SELECT ${COMPRA_COLS} ${COMPRA_JOINS}
     WHERE (c.fecha < (CURRENT_DATE - $1::int) OR c.estado = 'anulada')${filtroLocal}
     ORDER BY c.id DESC`,
    params
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

  // Local de la compra: define a qué local se le suma el stock.
  //   • Usuario CON local fijo: si no manda `local_id`, se usa el suyo; si
  //     lo manda, se respeta (una compra puede ser para otro local).
  //   • Superadministrador / usuario SIN local fijo: DEBE elegirlo (selector).
  let localIdCompra = Number(req.body.local_id) || null;
  if (!localIdCompra) {
    const superadmin = await esSuperadmin(req.user);
    localIdCompra = superadmin ? null : (Number(req.user?.local_id) || null);
  }
  if (!Number.isInteger(localIdCompra) || localIdCompra <= 0) {
    return res.status(400).json({
      error: 'Elegí el local de la compra (campo "local_id"): define a qué local se le suma el stock.',
      requiereSeleccionLocal: true,
    });
  }
  const { rows: localOk } = await pool.query(
    `SELECT id FROM locales WHERE id=$1 AND estado='Activo'`, [localIdCompra]
  );
  if (!localOk[0]) {
    return res.status(400).json({ error: 'El local de la compra no existe o no está activo.', requiereSeleccionLocal: true });
  }

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

  // Cada insumo de la compra tiene que pertenecer al local elegido (los
  // ítems se identifican por nombre — el formulario de Compras no manda
  // insumo_id). Se resuelve aquí el insumo_id REAL de ese local y se sella
  // en cada ítem: así el incremento de stock (y su reversión al anular)
  // golpea exactamente esa fila de insumo, nunca la de otro local con el
  // mismo nombre. Si un ítem no coincide con ningún insumo del local, la
  // compra completa se rechaza.
  const { rows: insumosDelLocal } = await pool.query(
    `SELECT id, nombre FROM insumos WHERE local_id = $1`, [localIdCompra]
  );
  const insumoIdPorNombre = new Map(
    insumosDelLocal.map(i => [nombreNormalizado(i.nombre).toLowerCase(), i.id])
  );
  const itemsFinales = [];
  for (let i = 0; i < (items || []).length; i++) {
    const it = items[i];
    const clave = nombreNormalizado(it?.insumo || '').toLowerCase();
    const insumoId = clave ? insumoIdPorNombre.get(clave) : undefined;
    if (!insumoId) {
      return res.status(400).json({
        error: `El insumo "${it?.insumo || `#${i + 1}`}" no pertenece al local seleccionado.`,
      });
    }
    itemsFinales.push({ ...it, insumo_id: insumoId });
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
        `INSERT INTO compras(codigo,proveedor_id,fecha,descuento,total,items,observaciones,comprobante_url,comprobante_verificado,comprobante_total_ocr,ocr_resultado,local_id,estado)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'activa') RETURNING id`,
        [
          codigo, proveedorId || null, fecha || new Date(), descuentoNum, totalFinal,
          JSON.stringify(itemsFinales), observaciones || null, comprobante_url || null,
          comprobante_verificado || false, comprobante_total_ocr ?? null,
          ocr_resultado ? JSON.stringify(ocr_resultado) : null, localIdCompra,
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

  // Sumar al stock — SOLO al insumo del local elegido (it.insumo_id ya fue
  // resuelto arriba a la fila exacta de ese local). La cantidad se calcula
  // igual que antes (directa o por presentación): esa lógica no cambia.
  for (const it of itemsFinales) {
    await ajustarStockInsumoPorId(it.insumo_id, calcularCantidadStock(it));
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
  // que se usó al crearla. Las compras nuevas traen it.insumo_id (la fila
  // exacta del local de la compra), así que se revierte por id. Las compras
  // viejas (sin insumo_id en sus ítems) caen al ajuste por nombre de antes.
  for (const it of (actual[0].items || [])) {
    if (it.insumo_id) await ajustarStockInsumoPorId(it.insumo_id, -calcularCantidadStock(it));
    else await ajustarStockInsumo(it.insumo, -calcularCantidadStock(it));
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
// Secuencia VISIBLE del flujo: pendiente → en_proceso → en_camino → entregado.
// Se quitó 'listo' y se agregó 'en_camino' — para un pedido a domicilio el
// frontend lo muestra "En camino"; para uno de recogida en local, el MISMO
// estado se muestra "Listo para recoger". 'pendiente_verificacion' encabeza
// la secuencia porque es el paso previo real de un pedido con comprobante.
const ESTADOS_PEDIDO_ORDEN = ['pendiente_verificacion', 'pendiente', 'en_proceso', 'en_camino', 'entregado'];
const IDX_EN_PROCESO = ESTADOS_PEDIDO_ORDEN.indexOf('en_proceso');
const IDX_EN_CAMINO  = ESTADOS_PEDIDO_ORDEN.indexOf('en_camino');
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
// Normaliza el "estado" que llega del cliente ANTES de validarlo: los
// valores canónicos son minúscula con guion_bajo ('en_proceso'), pero el
// frontend a veces manda la etiqueta de pantalla ('En proceso', 'Entregado',
// 'entregado ' con espacio final). Se recorta, se pasa a minúscula y se
// reemplaza cualquier espacio/guion por '_' — así 'En proceso' → 'en_proceso'
// deja de ser un "estado inválido".
const normalizarEstadoPedido = (v) =>
  String(v ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');

// Único conjunto de métodos de pago válido para pedidos NUEVOS — coincide
// con el CHECK pedidos_pago_check de config/db.js/schema.sql (agregado con
// NOT VALID: no toca pedidos ya guardados con un valor viejo como
// 'Bancolombia'/'Daviplata'/mayúsculas distintas, solo exige esta lista
// desde acá en adelante). En minúscula porque así es como lo manda
// realmente el frontend — antes la lista estaba en mayúscula
// ('Nequi'/'Bancolombia'/'Efectivo'), lo que nunca coincidía con lo que de
// verdad llegaba y rechazaba pedidos válidos.
// El valor guardado sigue siendo 'transferencia' — el frontend solo cambió
// la ETIQUETA visible a "Llave Bancolombia" y sigue enviando 'transferencia'.
// No se toca el enum ni el CHECK de la BD.
const METODOS_PAGO_VALIDOS = ['efectivo', 'nequi', 'transferencia'];
const metodoPagoInvalido = (pago) => !!pago && !METODOS_PAGO_VALIDOS.includes(String(pago).toLowerCase());
// Métodos que se pagan con comprobante que el cliente sube y el cajero
// aprueba (nequi / llave bancolombia). Son los ÚNICOS que bloquean el avance
// a 'en_proceso' hasta que el pago esté confirmado — el efectivo se cobra en
// persona a la entrega y no frena la preparación. Es la definición que usan
// tanto el gate de PATCH /:id/estado como /confirmar-pago y /comprobante/*.
const METODOS_CON_COMPROBANTE = ['nequi', 'transferencia'];
const pagoRequiereComprobante = (pago) => METODOS_CON_COMPROBANTE.includes(String(pago || '').toLowerCase());
// Un pedido creado por el propio cliente en la tienda (landing/app) SIEMPRE
// debe llevar un método de pago real — no existe "pagar después" / "pagar al
// recoger sin verificación". Un pedido cargado por personal de mostrador sí
// puede quedar sin método (se cobra en caja).
const ORIGENES_CLIENTE = ['landing', 'app', 'tienda', 'web'];
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

// SELECT + JOINs comunes a las 3 rutas GET de pedidos. Trae:
//   local_nombre        → nombre del local que atiende el pedido
//   atendidoPorNombre   → nombre del cajero/bartender que lo dejó "en_camino"
//   domiciliarioNombre  → nombre del repartidor asignado (si hay)
//   tieneComprobante     → true/false según comprobante_img esté lleno — deja
//                          al frontend distinguir, dentro de la lista de
//                          'pendiente_verificacion', los pedidos con
//                          comprobante listo para revisar de los que quedaron
//                          sin comprobante subido (hay que contactar al cliente)
const PEDIDO_SELECT = `
  SELECT ped.*,
         l.nombre  AS local_nombre,
         ua.nombre AS "atendidoPorNombre",
         ud.nombre AS "domiciliarioNombre",
         (ped.comprobante_img IS NOT NULL) AS "tieneComprobante",
         ped.comprobante_img AS "comprobanteImg",
         ped.comprobante_ocr AS "comprobanteOcr"
    FROM pedidos ped
    LEFT JOIN locales  l  ON ped.local_id        = l.id
    LEFT JOIN usuarios ua ON ped.atendido_por    = ua.id
    LEFT JOIN usuarios ud ON ped.domiciliario_id = ud.id
`;

pedRouter.get('/', auth, async (req, res) => {
  try {
  // El frontend espera "productos" y "comprobanteImg"; la tabla real usa
  // "items" y "comprobante_img". Antes esto solo se resolvía a medias en
  // la tabla (con un fallback manual) y nunca en el modal de detalle, así
  // que el detalle de un pedido siempre mostraba "Sin productos
  // registrados" y jamás el comprobante subido.
  // Filtro por local:
  //   • Cliente autenticado → SIEMPRE solo sus propios pedidos (cliente_id
  //     del token, nunca de un query param manipulable).
  //   • Cajero / Bartender → su local, tomado del token (req.user.local_id):
  //     ve los pedidos ya asignados a SU local + los que están sin asignar
  //     (local_id IS NULL, reclamables). Nunca ve los de otro local.
  //   • Administrador (sin local_id) → ve todos; puede acotar con ?local_id=.
  //   • ?sede= se mantiene solo como respaldo para tokens viejos sin local_id.
  const { sede, local_id: localIdQuery, comprobante } = req.query;
  const params = [];
  const conds = [];
  if (req.user.rol === 'Cliente') {
    params.push(req.user.id);
    conds.push(`ped.cliente_id = $${params.length}`);
  } else {
    const localOperativo = Number(req.user.local_id) || Number(localIdQuery) || null;
    if (localOperativo) {
      params.push(localOperativo);
      conds.push(`(ped.local_id = $${params.length} OR ped.local_id IS NULL)`);
    } else if (sede) {
      params.push(sede);
      conds.push(`(ped.sede = $${params.length} OR ped.sede IS NULL)`);
    }
  }
  // ?comprobante=con|sin → filtra la lista por si el comprobante_img está
  // lleno o no (útil para revisar los 'pendiente_verificacion' por separado).
  if (comprobante === 'con') conds.push('ped.comprobante_img IS NOT NULL');
  if (comprobante === 'sin') conds.push('ped.comprobante_img IS NULL');
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const { rows } = await pool.query(`${PEDIDO_SELECT} ${where} ORDER BY ped.id DESC`, params);
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
      -- 'listo' se reemplazó por 'en_camino'. Se exponen las dos claves con
      -- el mismo valor para no romper al frontend durante la transición.
      COUNT(*) FILTER (WHERE estado = 'en_camino')                 AS "enCamino",
      COUNT(*) FILTER (WHERE estado = 'en_camino')                 AS listo,
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
    `${PEDIDO_SELECT} WHERE ped.cliente_id = $1 ORDER BY ped.id DESC`,
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
    `${PEDIDO_SELECT} WHERE ped.id=$1`,
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
  const { cliente_id, numero, cliente, tipo, pago, mesa, total, items, comprobante, comprobante_img, comprobante_ocr, origen, direccion_alternativa, hora, estado, atendido_por, domiciliario_id, sede, local_id, _meta } = req.body;
  // Compatibilidad: si vienen en _meta los usamos también
  const meta = _meta || {};
  const comprobanteImgFinal = comprobante_img || meta.comprobanteImg || null;
  // OCR del comprobante: se guarda tal cual llega, SIN validar nada. Aunque
  // el OCR haya fallado, no haya leído nada, o el monto no cuadre, el pedido
  // se crea igual y el comprobante queda adjunto — la decisión de aprobar o
  // rechazar el pago es 100% manual (Cajero/Admin).
  const comprobanteOcrFinal = comprobante_ocr ?? meta.comprobanteOcr ?? meta.ocr ?? null;
  const pagoFinal = normalizarPago(pago || meta.pago || null);
  if (metodoPagoInvalido(pagoFinal)) {
    return res.status(400).json({ error: `Método de pago inválido. Debe ser uno de: ${METODOS_PAGO_VALIDOS.join(', ')}.` });
  }
  const origenFinal = origen || meta.origen || 'landing';
  // Sin "pagar después": un pedido que arma el propio cliente en la tienda
  // (landing/app) SIEMPRE tiene que elegir un método de pago. Efectivo (se
  // cobra a la entrega) o pago con comprobante (Nequi / Llave Bancolombia).
  if (ORIGENES_CLIENTE.includes(String(origenFinal).toLowerCase()) && !pagoFinal) {
    return res.status(400).json({ error: 'Debés elegir un método de pago: Efectivo, Nequi o Llave Bancolombia.' });
  }
  const tipoFinal = tipo || meta.tipo || null;
  // Local OPERATIVO del pedido — qué local lo atiende (cajeros/bartender de
  // ESE local lo ven; los de otro local, no). Se fija desde la creación:
  //   • el cliente que recoge en local (tipo='local') → su local elegido;
  //   • el Admin/cajero que crea el pedido y elige un local en el formulario
  //     → ese local, ya asignado (NO hay que "reclamarlo").
  // Puede llegar como `local_id` numérico o como nombre en `sede`. Si no se
  // especifica ninguno, queda NULL = pedido sin asignar, reclamable por
  // cualquier local vía PATCH /:id/tomar.
  let localIdFinal = null;
  const localIdRaw = local_id ?? meta.local_id ?? null;
  const sedeNombre = sede || meta.sede || null;
  try {
    if (localIdRaw != null && String(localIdRaw).trim() !== '') {
      localIdFinal = Number(localIdRaw);
      if (!Number.isInteger(localIdFinal) || localIdFinal <= 0) {
        return res.status(400).json({ error: 'El local seleccionado no es válido.' });
      }
    } else if (sedeNombre) {
      const { rows } = await pool.query(
        `SELECT id FROM locales WHERE lower(btrim(nombre)) = lower(btrim($1)) AND estado='Activo' LIMIT 1`,
        [sedeNombre]
      );
      if (rows[0]) localIdFinal = rows[0].id;
    }
    if (tipoFinal === 'local' && !localIdFinal) {
      return res.status(400).json({ error: 'Debes indicar el local donde vas a recoger el pedido.' });
    }
    let localNombreResuelto = null;
    if (localIdFinal != null) {
      const { rows: localValido } = await pool.query(
        `SELECT id, nombre FROM locales WHERE id=$1 AND estado='Activo'`, [localIdFinal]
      );
      if (!localValido[0]) {
        return res.status(400).json({ error: 'El local seleccionado no existe o no está activo.' });
      }
      localNombreResuelto = localValido[0].nombre;
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
    const estadoCrudoPost = estado || meta.estado || null;
    const estadoSolicitado = estadoCrudoPost ? normalizarEstadoPedido(estadoCrudoPost) : null;
    if (estadoCrudoPost && !ESTADOS_PEDIDO_VALIDOS.includes(estadoSolicitado)) {
      return res.status(400).json({ error: `Estado no reconocido: "${estadoCrudoPost}". Los valores válidos son: ${ESTADOS_PEDIDO_VALIDOS.join(', ')}.` });
    }
    // Un pedido con método de pago digital (Nequi / Llave Bancolombia)
    // SIEMPRE nace en 'pendiente_verificacion', tenga o no comprobante
    // adjunto: si lo trae, el cajero lo revisa; si no, el cajero lo ve en
    // esa misma lista marcado como "sin comprobante" y contacta al cliente.
    // En efectivo se usa el estado que pida el body (o 'pendiente').
    const digital = pagoRequiereComprobante(pagoFinal);
    const estadoInicial = (comprobanteImgFinal || digital)
      ? 'pendiente_verificacion'
      : (estadoSolicitado || 'pendiente');
    // "Atendido por" / "Domiciliario" por id (usuarios.id). Normalmente NO
    // se mandan al crear — se asignan en la transición a 'en_camino' (ver
    // PATCH /:id/estado) — pero se aceptan si el formulario los envía.
    const atendidoPorId    = Number.isInteger(Number(atendido_por))    && Number(atendido_por)    > 0 ? Number(atendido_por)    : null;
    const domiciliarioIdN  = Number.isInteger(Number(domiciliario_id)) && Number(domiciliario_id) > 0 ? Number(domiciliario_id) : null;

    const { rows } = await pool.query(
      `INSERT INTO pedidos(cliente_id,numero,cliente,tipo,pago,mesa,total,items,comprobante,comprobante_img,comprobante_hash,comprobante_ocr,origen,direccion_alternativa,hora,estado,atendido_por,domiciliario_id,sede,local_id)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING *`,
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
        comprobanteOcrFinal ? JSON.stringify(comprobanteOcrFinal) : null,
        origenFinal,
        direccion_alternativa || meta.direccionAlternativa || null,
        hora || meta.hora || null,
        estadoInicial,
        atendidoPorId,
        domiciliarioIdN,
        // "sede" (texto) se mantiene solo por compatibilidad: si se resolvió
        // un local operativo, se guarda su nombre real; si no, el nombre
        // recibido; si tampoco, NULL (pedido sin asignar). La fuente de
        // verdad de "qué local atiende el pedido" es local_id (abajo).
        localNombreResuelto || sedeNombre || null,
        // Local operativo, ya asignado desde la creación. NULL = pedido sin
        // asignar, reclamable por cualquier local (ver PATCH /:id/tomar).
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
  const { cliente, tipo, pago, total, items, atendido_por, domiciliario_id, direccion_alternativa, sede, local_id, comprobante_img } = req.body;
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
    // Adjuntar un comprobante DESPUÉS de creado el pedido: sirve para el
    // caso "cliente pidió por Nequi pero no subió comprobante" — el cajero
    // lo contacta, el cliente lo manda, y acá se adjunta (con su hash, para
    // que siga aplicando el anti-reutilización). No se toca 'estado' ni
    // 'pago_confirmado' — eso lo decide /comprobante/aprobar.
    let comprobanteHash = null;
    if (comprobante_img) {
      comprobanteHash = crypto.createHash('sha256').update(comprobante_img).digest('hex');
      const { rows: dup } = await pool.query(
        `SELECT id FROM pedidos WHERE comprobante_hash = $1 AND estado <> 'cancelado' AND id <> $2 LIMIT 1`,
        [comprobanteHash, id]
      );
      if (dup[0]) {
        return res.status(409).json({ error: 'Este comprobante ya fue usado en otro pedido.', pedidoExistente: dup[0].id });
      }
    }
    const { rows } = await pool.query(
      `UPDATE pedidos SET
         cliente = COALESCE($1, cliente),
         tipo    = COALESCE($2, tipo),
         pago    = COALESCE($3, pago),
         total   = COALESCE($4, total),
         items   = COALESCE($5, items),
         atendido_por    = COALESCE($6, atendido_por),
         domiciliario_id = COALESCE($7, domiciliario_id),
         direccion_alternativa = COALESCE($8, direccion_alternativa),
         sede = COALESCE($9, sede),
         local_id = COALESCE($10, local_id),
         comprobante_img  = COALESCE($12, comprobante_img),
         comprobante_hash = COALESCE($13, comprobante_hash)
       WHERE id=$11 RETURNING *`,
      [
        cliente ?? null,
        tipo ?? null,
        pagoFinal,
        total ?? null,
        items ? JSON.stringify(items) : null,
        Number.isInteger(Number(atendido_por))    && Number(atendido_por)    > 0 ? Number(atendido_por)    : null,
        Number.isInteger(Number(domiciliario_id)) && Number(domiciliario_id) > 0 ? Number(domiciliario_id) : null,
        direccion_alternativa ?? null,
        sede ?? null,
        local_id ?? null,
        id,
        comprobante_img ?? null,
        comprobanteHash,
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
//
// Códigos de respuesta (para que el frontend los distinga):
//   400 → la PETICIÓN está mal formada (falta 'estado', o su valor no es
//         ninguno de los reconocidos).
//   409 → la petición es válida pero CHOCA con el estado real del pedido
//         (ya terminó, se intenta retroceder, o falta confirmar el pago).
//         La respuesta incluye estadoActual/estadoSolicitado para que el
//         frontend pueda re-sincronizar su vista.
//   404 → el pedido no existe.
pedRouter.patch('/:id/estado', auth, async (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: 'ID de pedido inválido' });

  const estadoCrudo = req.body?.estado;
  if (estadoCrudo === undefined || estadoCrudo === null || String(estadoCrudo).trim() === '') {
    return res.status(400).json({
      error: "Falta el campo 'estado' en la petición. Si lo que querés es solo confirmar el cobro (sin mover el estado), usá PATCH /pedidos/:id/confirmar-pago.",
    });
  }
  const estado = normalizarEstadoPedido(estadoCrudo);
  if (!ESTADOS_PEDIDO_VALIDOS.includes(estado)) {
    return res.status(400).json({
      error: `Estado no reconocido: "${estadoCrudo}". Los valores válidos son: ${ESTADOS_PEDIDO_VALIDOS.join(', ')}.`,
      estadoSolicitado: estadoCrudo,
      valoresValidos: ESTADOS_PEDIDO_VALIDOS,
    });
  }
  try {
    const { rows: actual } = await pool.query(
      'SELECT id, estado, pago, pago_confirmado, tipo, sede, local_id, items, total FROM pedidos WHERE id=$1', [id]
    );
    if (!actual[0]) return res.status(404).json({ error: 'Pedido no encontrado' });
    const ped = actual[0];
    const estadoActual = ped.estado;
    // Aviso NO bloqueante que viaja junto al pedido actualizado: se llena si
    // al entregar hubo insumos de la receta que no existen en el local y por
    // tanto no se pudieron descontar del inventario.
    let avisoInventario = null;

    if (estadoActual === 'entregado' || estadoActual === 'cancelado') {
      return res.status(409).json({
        error: `El pedido #${id} ya está "${estadoActual}" y no admite más cambios de estado.`,
        estadoActual, estadoSolicitado: estado,
      });
    }

    if (estado !== 'cancelado') { // 'cancelado' siempre permitido en este punto
      const idxActual = ESTADOS_PEDIDO_ORDEN.indexOf(estadoActual);
      const idxNuevo  = ESTADOS_PEDIDO_ORDEN.indexOf(estado);
      if (idxActual !== -1 && idxNuevo < idxActual) {
        return res.status(409).json({
          error: `El pedido #${id} ya está en "${estadoActual}"; no se puede regresar a "${estado}". Si tu pantalla lo muestra en un estado anterior, recargá la lista de pedidos.`,
          estadoActual, estadoSolicitado: estado,
        });
      }
      // Gate de pago — UN SOLO camino, según el método real del pedido:
      //   • nequi / llave bancolombia (transferencia) → el pago se confirma
      //     aprobando el comprobante (PATCH /:id/comprobante/aprobar), que
      //     además de aprobar pone pago_confirmado=true. NO se menciona
      //     /confirmar-pago acá (era la fuente del "pide las dos cosas").
      //   • efectivo / sin método → sin bloqueo: el cobro se hace en persona
      //     a la entrega, no frena la preparación.
      if (idxNuevo >= IDX_EN_PROCESO && pagoRequiereComprobante(ped.pago) && !ped.pago_confirmado) {
        return res.status(409).json({
          error: `El pedido #${id} se paga por ${ped.pago} y su comprobante todavía no fue aprobado. Aprobalo con PATCH /pedidos/${id}/comprobante/aprobar antes de pasarlo a "${estado}".`,
          estadoActual, estadoSolicitado: estado, pago: ped.pago, pagoConfirmado: ped.pago_confirmado,
        });
      }
    }

    // ── Transición a 'entregado': crea la venta + descuenta inventario, en
    //    una sola transacción e idempotente.
    //    Un insumo que no existe en el local YA NO bloquea la entrega (ver
    //    descontarInventarioPorVenta): se descuenta lo que se puede y los
    //    faltantes viajan en `avisoInventario` para mostrarlos como
    //    advertencia. Solo sigue bloqueando el caso en que el pedido no
    //    tiene un local válido, porque ahí no hay inventario contra el cual
    //    registrar nada.
    if (estado === 'entregado') {
      const r = await registrarVentaDePedido(ped);
      if (r.error) {
        return res.status(409).json({
          error: `No se puede marcar el pedido #${id} como entregado: ${r.error}`,
          estadoActual, estadoSolicitado: estado,
        });
      }
      if (r.faltantes?.length) {
        avisoInventario = `El pedido se entregó y la venta quedó registrada, pero no se descontó el inventario de: ${r.faltantes.join(', ')} (no existe(n) como insumo activo en el local del pedido). Revisa la receta y el inventario de ese local.`;
      }
    }

    // ── Transición a 'en_camino' (estado de espera antes de la entrega):
    //    "atendido_por" = el usuario autenticado que hace la transición
    //    (automático, no se elige). "domiciliario_id" es opcional y solo
    //    aplica a domicilio — puede quedar NULL si nadie lo tomó todavía.
    const sets = ['estado=$1'];
    const vals = [estado];
    if (estado === 'en_camino') {
      vals.push(req.user.id); sets.push(`atendido_por = COALESCE(atendido_por, $${vals.length})`);
      const domi = Number(req.body?.domiciliario_id);
      if (ped.tipo === 'domicilio' && Number.isInteger(domi) && domi > 0) {
        vals.push(domi); sets.push(`domiciliario_id = $${vals.length}`);
      }
    }
    vals.push(id);
    const { rows } = await pool.query(
      `UPDATE pedidos SET ${sets.join(', ')} WHERE id=$${vals.length} RETURNING *`, vals
    );
    res.json(avisoInventario ? { ...rows[0], avisoInventario } : rows[0]);
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
    const { rows: actual } = await pool.query('SELECT estado, pago FROM pedidos WHERE id=$1', [id]);
    if (!actual[0]) return res.status(404).json({ error: 'Pedido no encontrado' });
    // Esta ruta es SOLO para efectivo / pago en el local. Un pedido que se
    // paga por Nequi o Llave Bancolombia se confirma revisando el
    // comprobante (PATCH /:id/comprobante/aprobar) — nunca "a mano" acá, que
    // saltaría la verificación del comprobante.
    if (pagoRequiereComprobante(actual[0].pago)) {
      return res.status(400).json({
        error: `El pedido #${id} se paga por ${actual[0].pago}: su pago se confirma aprobando el comprobante con PATCH /pedidos/${id}/comprobante/aprobar, no con /confirmar-pago.`,
      });
    }
    if (actual[0].estado === 'cancelado' || actual[0].estado === 'entregado') {
      return res.status(400).json({ error: 'Este pedido está cancelado o ya entregado, no se puede confirmar el pago.' });
    }
    const { rows } = await pool.query(
      `UPDATE pedidos SET pago_confirmado = TRUE WHERE id=$1 RETURNING *`, [id]
    );
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
    const { rows: actual } = await pool.query('SELECT estado, pago, comprobante_img FROM pedidos WHERE id=$1', [id]);
    if (!actual[0]) return res.status(404).json({ error: 'Pedido no encontrado' });
    if (esEfectivo(actual[0].pago)) {
      return res.status(400).json({ error: 'Los pedidos en efectivo no requieren aprobación de comprobante — usa PATCH /:id/confirmar-pago.' });
    }
    if (actual[0].estado !== 'pendiente_verificacion') {
      return res.status(400).json({ error: 'Este pedido no tiene un comprobante pendiente de verificación.' });
    }
    // No se puede "aprobar" un comprobante que no existe. Si el cliente eligió
    // Nequi/Llave Bancolombia pero no subió la imagen, el pedido quedó igual
    // en 'pendiente_verificacion' (para que el cajero lo vea en esa lista),
    // pero acá no hay nada que aprobar hasta que el cliente lo envíe y se
    // adjunte con PUT /pedidos/:id.
    if (!actual[0].comprobante_img) {
      return res.status(400).json({ error: `El pedido #${id} no tiene comprobante subido. Contactá al cliente para que lo envíe y adjuntalo con PUT /pedidos/${id} antes de aprobarlo.` });
    }
    // Aprobar = confirmar el pago y pasar a 'pendiente' (listo para que el
    // cajero dé "empezar preparación" → en_proceso, como paso aparte).
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
  // El motivo es OBLIGATORIO: queda guardado en el pedido para que el
  // cliente pueda ver por qué se rechazó su comprobante (GET /pedidos lo
  // devuelve en comprobante_motivo_rechazo).
  const motivo = textoLimpio(req.body?.motivo);
  if (!motivo) {
    return res.status(400).json({ error: 'Tenés que indicar un motivo para rechazar el comprobante.' });
  }
  const errorMotivo = errorLongitud(motivo, 'El motivo de rechazo', LIMITES.MOTIVO, 5);
  if (errorMotivo) return res.status(400).json({ error: errorMotivo });
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
      [motivo, id]
    );
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Un cajero/bartender "toma" (reclama) un pedido que todavía NO está
// asignado a ningún local (local_id IS NULL) — solo aplica a esos; un
// pedido que el Admin creó ya con un local elegido nunca pasa por aquí.
// El UPDATE es atómico (WHERE local_id IS NULL en la misma consulta) para
// que, si dos locales intentan tomarlo a la vez, solo uno lo consiga.
pedRouter.patch('/:id/tomar', auth, async (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: 'ID de pedido inválido' });
  const miLocal = Number(req.user.local_id) || null;
  if (!miLocal) {
    return res.status(403).json({ error: 'Solo un cajero o bartender con local asignado puede tomar un pedido.' });
  }
  try {
    const { rows } = await pool.query(
      `UPDATE pedidos
          SET local_id = $1,
              sede = (SELECT nombre FROM locales WHERE id = $1)
        WHERE id = $2 AND local_id IS NULL
        RETURNING *`,
      [miLocal, id]
    );
    if (!rows[0]) {
      const { rows: existente } = await pool.query(
        `SELECT l.nombre FROM pedidos p LEFT JOIN locales l ON l.id = p.local_id WHERE p.id=$1`, [id]
      );
      if (!existente[0]) return res.status(404).json({ error: 'Pedido no encontrado' });
      return res.status(409).json({ error: `Este pedido ya fue tomado por ${existente[0].nombre || 'otro local'}` });
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

    // Misma lógica atómica e idempotente que usa PATCH /pedidos/:id/estado al
    // marcar 'entregado': crea la venta + descuenta inventario en una
    // transacción, y si el pedido ya tenía venta, no duplica nada. Si el
    // local no resuelve o falta un insumo → 400 sin tocar stock.
    const r = await registrarVentaDePedido(ped[0]);
    if (r.error) return res.status(400).json({ error: r.error });

    const { rows: full } = await pool.query(`${VENTA_SELECT} WHERE v.id=$1`, [r.ventaId]);
    // Mismo aviso que en PATCH /pedidos/:id/estado: la venta se registra
    // igual, pero se informa qué insumos no se pudieron descontar.
    const avisoInv = r.faltantes?.length
      ? `La venta quedó registrada, pero no se descontó el inventario de: ${r.faltantes.join(', ')} (no existe(n) como insumo activo en el local del pedido).`
      : undefined;
    res.status(r.yaExistia ? 200 : 201).json(avisoInv ? { ...full[0], avisoInventario: avisoInv } : full[0]);
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
    d.motivo_rechazo,
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

  // Rechazar SIEMPRE exige un motivo. Antes el rechazo solo cambiaba el
  // estado, así que la devolución quedaba marcada como rechazada sin que
  // nadie —ni el cliente ni el siguiente cajero— pudiera saber por qué.
  // Mismo criterio que ya usa el rechazo de comprobantes
  // (PATCH /pedidos/:id/comprobante/rechazar), y misma validación: sin
  // espacios en blanco solamente, y con tope de longitud.
  let motivoRechazo = null;
  if (estado === 'rechazada') {
    motivoRechazo = textoLimpio(req.body.motivo_rechazo ?? req.body.motivoRechazo);
    if (!motivoRechazo) {
      return res.status(400).json({ error: 'Tenés que indicar un motivo para rechazar la devolución.' });
    }
    const errorMotivo = errorLongitud(motivoRechazo, 'El motivo de rechazo', LIMITES.MOTIVO, 10);
    if (errorMotivo) return res.status(400).json({ error: errorMotivo });
  }

  // Al salir del estado 'rechazada' (ej. se reabre como 'pendiente') el
  // motivo se limpia: dejarlo colgado mostraría un rechazo que ya no existe.
  const { rows } = await pool.query(
    'UPDATE devoluciones SET estado=$1, motivo_rechazo=$2 WHERE id=$3 RETURNING *',
    [estado, motivoRechazo, req.params.id]
  );
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


// ── Validación de una ficha técnica ─────────────────────────────────────────
// Antes, la API aceptaba prácticamente cualquier cosa en este módulo: una
// ficha sin producto, sin insumos, sin vaso y sin preparación; cantidades en
// 0 o negativas; insumos que no existen; notas de puros espacios; y un
// "tipo de preparación" cualquiera. Todas esas reglas vivían solo en el
// formulario de React, así que llamando la API directamente (Postman/curl,
// o la app móvil) se saltaban por completo. Estas funciones las replican en
// el servidor, que es el único lugar donde no se pueden evadir.

// Devuelve el producto (id, nombre, categoria, precio) o null si no existe.
const obtenerProductoDeFicha = async (idProducto) => {
  const { rows } = await pool.query(
    'SELECT id, nombre, categoria, precio FROM productos WHERE id=$1', [idProducto]
  );
  return rows[0] || null;
};

// Un producto solo puede tener UNA ficha técnica, activa o inactiva. Antes
// esto solo se revisaba entre fichas ACTIVAS, así que se podían acumular
// fichas inactivas repetidas del mismo producto (duplicados reales, que
// además reaparecían al reactivarlas). `excluirId` es el id de la propia
// ficha al editar, para que no se detecte a sí misma.
const existeFichaParaProducto = async (idProducto, excluirId) => {
  if (!idProducto) return false;
  const { rows } = await pool.query(
    `SELECT id, estado FROM fichas_tecnicas
      WHERE producto_id=$1 AND id <> COALESCE($2, -1) LIMIT 1`,
    [idProducto, excluirId || null]
  );
  return rows[0] || false;
};

const ERROR_FICHA_DUPLICADA =
  'Este producto ya tiene una ficha técnica registrada. Edítala en vez de crear una nueva.';

// Número entero dentro de un rango. Rechaza texto, decimales, NaN, Infinity
// y valores fuera de rango — antes `porciones: "abc"` llegaba a Postgres y
// reventaba con un error 500 crudo de tipos.
const errorEntero = (valor, etiqueta, min, max) => {
  const n = Number(valor);
  if (valor === undefined || valor === null || String(valor).trim() === '' || !Number.isFinite(n)) {
    return `${etiqueta} es obligatorio y debe ser un número.`;
  }
  if (!Number.isInteger(n)) return `${etiqueta} debe ser un número entero.`;
  if (n < min || n > max) return `${etiqueta} debe estar entre ${min} y ${max}.`;
  return null;
};

// Valida una lista de insumos/toppings de la ficha: [{ id_insumo, cantidad,
// unidad }]. Revisa que cada fila esté completa, con cantidad > 0, que el
// insumo exista de verdad en la tabla `insumos`, y que no se repita el mismo
// insumo dos veces en la misma lista. Devuelve { error } o { filas } ya
// normalizadas (números, no texto) listas para guardar.
// `contexto` es cómo se llama la sección en la pantalla ("los insumos
// requeridos" / "los toppings"), para que el mensaje se lea natural y el
// usuario sepa exactamente en qué parte del formulario está el problema.
const validarLineasInsumo = async (lista, contexto, { obligatoria }) => {
  const errorVacio = 'Debes registrar al menos un insumo en la ficha técnica.';
  if (lista === undefined || lista === null) {
    return obligatoria ? { error: errorVacio } : { filas: [] };
  }
  if (!Array.isArray(lista)) return { error: `El formato de ${contexto} no es válido.` };
  const filas = [];
  const vistos = new Set();
  for (const item of lista) {
    if (!item || typeof item !== 'object') return { error: `El formato de ${contexto} no es válido.` };
    const idInsumo = Number(item.id_insumo);
    const cantidad = Number(item.cantidad);
    if (!Number.isInteger(idInsumo) || idInsumo <= 0) {
      return { error: `Hay una fila en ${contexto} sin insumo seleccionado.` };
    }
    if (!Number.isFinite(cantidad) || cantidad <= 0) {
      return { error: `Las cantidades de ${contexto} deben ser números mayores a 0.` };
    }
    if (vistos.has(idInsumo)) {
      return { error: `No puedes repetir el mismo insumo dos veces en ${contexto}.` };
    }
    vistos.add(idInsumo);
    filas.push({ id_insumo: idInsumo, cantidad, unidad: textoLimpio(item.unidad) || null });
  }
  if (obligatoria && filas.length === 0) return { error: errorVacio };
  if (filas.length > 0) {
    // Un solo SELECT para todos los ids: comprueba de una vez que todos
    // existan, y de paso trae la unidad real registrada para cada insumo
    // (la ficha nunca debe guardar una unidad distinta a la del insumo).
    const ids = filas.map(f => f.id_insumo);
    const { rows } = await pool.query('SELECT id, unidad FROM insumos WHERE id = ANY($1::int[])', [ids]);
    const unidadPorId = new Map(rows.map(r => [r.id, r.unidad]));
    const faltantes = ids.filter(id => !unidadPorId.has(id));
    if (faltantes.length) {
      return { error: `En ${contexto} hay insumos que ya no existen en el inventario (id: ${faltantes.join(', ')}).` };
    }
    for (const f of filas) f.unidad = unidadPorId.get(f.id_insumo) || f.unidad;
  }
  return { filas };
};

// Validación completa del cuerpo de una ficha técnica, compartida por POST y
// PUT. Devuelve { error } con el primer problema encontrado, o { datos } con
// todos los valores ya limpios y normalizados, listos para el INSERT/UPDATE.
const validarFichaTecnica = async (body, excluirId) => {
  // 1. Producto: obligatorio y tiene que existir. Antes se guardaba como
  //    NULL sin quejarse, dejando fichas "huérfanas" imposibles de asociar
  //    a nada y que además burlaban el control de duplicados.
  const idProducto = Number(body.id_producto);
  if (!Number.isInteger(idProducto) || idProducto <= 0) {
    return { error: 'Debes seleccionar el producto al que pertenece esta ficha técnica.' };
  }
  const producto = await obtenerProductoDeFicha(idProducto);
  if (!producto) return { error: 'El producto seleccionado no existe.' };

  // 2. Un producto = una ficha (activa o inactiva).
  if (await existeFichaParaProducto(idProducto, excluirId)) {
    return { error: ERROR_FICHA_DUPLICADA };
  }

  // 3. Parámetros de producción.
  const errorPorciones = errorEntero(body.porciones, 'La unidad (porciones)', 1, 1000);
  if (errorPorciones) return { error: errorPorciones };
  const errorTiempo = errorEntero(body.tiempo_prep, 'El tiempo de preparación', 1, 1440);
  if (errorTiempo) return { error: errorTiempo };

  const costo = Number(body.costo_estimado);
  if (body.costo_estimado === undefined || body.costo_estimado === null ||
      String(body.costo_estimado).trim() === '' || !Number.isFinite(costo) || costo < 0) {
    return { error: 'El costo estimado es obligatorio y debe ser un número mayor o igual a 0.' };
  }
  // Mismo criterio que el formulario: igualar el precio de venta ya
  // significa vender sin ganancia, así que también se bloquea (antes el
  // servidor solo rechazaba costo > precio, y la pantalla costo >= precio).
  if (Number(producto.precio) > 0 && costo >= Number(producto.precio)) {
    return { error: 'El costo estimado supera o iguala el precio de venta del producto. Revisa la ficha técnica para evitar pérdidas.' };
  }

  // 4. Textos: obligatorios los que de verdad lo son, y nunca "solo espacios".
  const preparacion = textoLimpio(body.preparacion);
  if (!preparacion) {
    return { error: 'El proceso de preparación es obligatorio y no puede contener solo espacios en blanco.' };
  }
  const errorTextoFicha =
    errorLongitud(body.notas,        'Las notas',                 LIMITES.NOTAS_FICHA) ||
    errorLongitud(body.resumen_prep, 'El resumen de preparación', LIMITES.NOTAS_FICHA) ||
    errorLongitud(preparacion,       'La preparación',            LIMITES.PREPARACION);
  if (errorTextoFicha) return { error: errorTextoFicha };

  // 5. Insumos (obligatorios) y toppings propios de la ficha (opcionales).
  //    El frontend manda los toppings en `toppings_ficha`; se acepta también
  //    `toppings` por compatibilidad con cualquier cliente anterior.
  const resInsumos = await validarLineasInsumo(body.insumos, 'los insumos requeridos', { obligatoria: true });
  if (resInsumos.error) return { error: resInsumos.error };
  const listaToppings = body.toppings_ficha !== undefined ? body.toppings_ficha : body.toppings;
  const resToppings = await validarLineasInsumo(listaToppings, 'los toppings', { obligatoria: false });
  if (resToppings.error) return { error: resToppings.error };

  // 6. Vaso: obligatorio y tiene que ser un insumo real. El formulario ya lo
  //    exigía; el servidor lo aceptaba vacío, y sin vaso el descuento de
  //    inventario por venta se queda corto (ver descontarInventarioPorVenta).
  const vasoId = Number(body.vaso_id);
  if (!Number.isInteger(vasoId) || vasoId <= 0) {
    return { error: 'Debes seleccionar el vaso utilizado para este producto.' };
  }
  const { rows: vaso } = await pool.query('SELECT id FROM insumos WHERE id=$1', [vasoId]);
  if (!vaso[0]) return { error: 'El vaso seleccionado no existe en el inventario de insumos.' };

  // 7. Tipo de preparación: se deduce de la categoría del producto siempre
  //    que se pueda (es lo mismo que muestra el formulario, bloqueado), y
  //    solo si no se puede deducir se respeta lo que haya elegido el
  //    usuario. Ver config/tiposPreparacion.js.
  const categoriaPrep = resolverTipoPreparacion(producto.categoria, body.categoria_prep);

  // 8. Estado: solo booleano real (antes un "false" en texto se guardaba
  //    como true, porque Postgres lo interpreta como cadena no vacía).
  const estado = body.estado === undefined || body.estado === null
    ? true
    : (body.estado === true || body.estado === 'true' || body.estado === 1 || body.estado === '1');

  return {
    datos: {
      producto_id: idProducto,
      categoria_prep: categoriaPrep,
      porciones: Number(body.porciones),
      tiempo_prep: Number(body.tiempo_prep),
      costo_estimado: costo,
      estado,
      notas: textoLimpio(body.notas) || null,
      resumen_prep: textoLimpio(body.resumen_prep) || null,
      preparacion,
      vaso_id: vasoId,
      insumos: resInsumos.filas,
      toppings: resToppings.filas,
    },
  };
};


const fichaRouter = require('express').Router();
// Valida :id (numérico) antes de que llegue a cualquier consulta, igual que
// el resto de routers. Sin esto, un id no numérico llegaba tal cual a
// Postgres y devolvía un 500 críptico ("la sintaxis de entrada no es válida
// para tipo integer") en vez de un 400 claro.
fichaRouter.param('id', validateId);
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
    // Toda la validación vive en validarFichaTecnica (arriba): producto
    // obligatorio y existente, sin fichas repetidas, parámetros numéricos
    // dentro de rango, costo por debajo del precio de venta, preparación
    // obligatoria, insumos y vaso reales, y tipo de preparación derivado de
    // la categoría del producto.
    const { error, datos } = await validarFichaTecnica(req.body, null);
    if (error) return res.status(400).json({ error });

    const { rows } = await pool.query(
      `INSERT INTO fichas_tecnicas
         (producto_id,categoria_prep,porciones,tiempo_prep,costo_estimado,estado,notas,resumen_prep,preparacion,vaso_id,ingredientes,toppings_ficha)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
      [
        datos.producto_id, datos.categoria_prep, datos.porciones, datos.tiempo_prep,
        datos.costo_estimado, datos.estado, datos.notas,
        datos.resumen_prep, datos.preparacion, datos.vaso_id,
        JSON.stringify(datos.insumos), JSON.stringify(datos.toppings),
      ]
    );
    const { rows: full } = await pool.query(`${FICHA_COLS} WHERE f.id=$1`, [rows[0].id]);
    res.status(201).json(full[0]);
  } catch (e) {
    // Red de seguridad ante dos peticiones simultáneas para el mismo
    // producto: el índice único parcial de Postgres las frena aunque la
    // consulta de duplicados de arriba no alcance a verlas.
    if (e.code === '23505') return res.status(400).json({ error: ERROR_FICHA_DUPLICADA });
    res.status(500).json({ error: e.message });
  }
});
fichaRouter.put('/:id', auth, async (req, res) => {
  try {
    const { rows: actual } = await pool.query('SELECT id FROM fichas_tecnicas WHERE id=$1', [req.params.id]);
    if (!actual[0]) return res.status(404).json({ error: 'Ficha técnica no encontrada' });

    const { error, datos } = await validarFichaTecnica(req.body, req.params.id);
    if (error) return res.status(400).json({ error });

    const { rows } = await pool.query(
      `UPDATE fichas_tecnicas SET
         producto_id=$1, categoria_prep=$2, porciones=$3, tiempo_prep=$4, costo_estimado=$5,
         estado=$6, notas=$7, resumen_prep=$8, preparacion=$9, vaso_id=$10, ingredientes=$11, toppings_ficha=$12
       WHERE id=$13 RETURNING id`,
      [
        datos.producto_id, datos.categoria_prep, datos.porciones, datos.tiempo_prep,
        datos.costo_estimado, datos.estado, datos.notas,
        datos.resumen_prep, datos.preparacion, datos.vaso_id,
        JSON.stringify(datos.insumos), JSON.stringify(datos.toppings),
        req.params.id,
      ]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Ficha técnica no encontrada' });
    const { rows: full } = await pool.query(`${FICHA_COLS} WHERE f.id=$1`, [req.params.id]);
    res.json(full[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ error: ERROR_FICHA_DUPLICADA });
    res.status(500).json({ error: e.message });
  }
});

fichaRouter.patch('/:id/estado', auth, async (req, res) => {
  try {
  const { rows: actual } = await pool.query(
    'SELECT producto_id, estado FROM fichas_tecnicas WHERE id=$1', [req.params.id]
  );
  if (!actual[0]) return res.status(404).json({ error: 'Ficha técnica no encontrada' });
  // Con la regla de "un producto = una ficha" ya no puede haber otra ficha
  // del mismo producto compitiendo, pero el chequeo se mantiene como red de
  // seguridad para bases de datos que traigan duplicados de antes de esta
  // corrección: en ese caso reactivar una avisa en vez de fallar con un
  // error 500 crudo del índice único.
  const vaAQuedarActiva = !actual[0].estado;
  if (vaAQuedarActiva && actual[0].producto_id) {
    const { rows: otraActiva } = await pool.query(
      `SELECT id FROM fichas_tecnicas WHERE producto_id=$1 AND estado=true AND id <> $2 LIMIT 1`,
      [actual[0].producto_id, req.params.id]
    );
    if (otraActiva[0]) return res.status(400).json({ error: ERROR_FICHA_DUPLICADA });
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
    if (e.code === '23505') return res.status(400).json({ error: ERROR_FICHA_DUPLICADA });
    res.status(500).json({ error: e.message });
  }
});

fichaRouter.delete('/:id', auth, async (req, res) => {
  try {
  // RETURNING id: antes esto respondía { ok: true } aunque no se hubiera
  // borrado nada (id inexistente o ya eliminado por otra pestaña), y la
  // pantalla mostraba "Ficha técnica anulada" sin que pasara nada.
  const { rows } = await pool.query('DELETE FROM fichas_tecnicas WHERE id=$1 RETURNING id', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Ficha técnica no encontrada' });
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
// Nombres de locales obsoletos que NUNCA deben aparecer en ningún endpoint
// (ver limpieza en config/db.js): se borran si no tienen registros, y si
// los tienen quedan ocultos aquí de todos modos.
const LOCALES_OBSOLETOS = ['Local 1', 'Local 2', 'Local Principal'];
localRouter.get('/', async (req, res) => {
  try {
  const { rows } = await pool.query(
    `SELECT id, nombre, direccion FROM locales
      WHERE estado='Activo' AND nombre <> ALL($1) ORDER BY id`,
    [LOCALES_OBSOLETOS]
  );
  res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Administración de locales — solo Administrador, a diferencia del resto
// de este módulo (público). "/todos" antes de cualquier ruta con :id para
// que Express no intente interpretarlo como un id.
localRouter.get('/todos', auth, permitirRoles('Administrador'), async (req, res) => {
  try {
  const { rows } = await pool.query(
    `SELECT * FROM locales WHERE nombre <> ALL($1) ORDER BY id`,
    [LOCALES_OBSOLETOS]
  );
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
// Un local solo se puede eliminar si NO tiene ningún registro asociado.
// Antes no había ruta DELETE (el frontend recibía un 404/500 genérico —
// "Error en la solicitud"); y aunque la hubiera, algunas FK a locales
// borran en cascada suave (pedidos_local_id_fkey es ON DELETE SET NULL, así
// que un borrado "exitoso" habría dejado pedidos huérfanos sin local). Este
// chequeo explícito responde 409 diciendo exactamente qué hay asociado y
// cuántos, y solo deja borrar el local si está completamente libre.
localRouter.delete('/:id', auth, permitirRoles('Administrador'), async (req, res) => {
  try {
  const { rows: existe } = await pool.query('SELECT id FROM locales WHERE id=$1', [req.params.id]);
  if (!existe[0]) return res.status(404).json({ error: 'Local no encontrado' });

  const { rows: [n] } = await pool.query(
    `SELECT
       (SELECT COUNT(*) FROM compras   WHERE local_id = $1)                                   AS compras,
       (SELECT COUNT(*) FROM pedidos   WHERE local_id = $1)                                   AS pedidos,
       (SELECT COUNT(*) FROM ventas v JOIN pedidos p ON p.id = v.pedido_id WHERE p.local_id = $1) AS ventas,
       (SELECT COUNT(*) FROM insumos   WHERE local_id = $1)                                   AS insumos,
       (SELECT COUNT(*) FROM empleados WHERE local_id = $1)                                   AS empleados,
       (SELECT COUNT(*) FROM usuarios  WHERE local_id = $1)                                   AS usuarios`,
    [req.params.id]
  );
  const cats = [
    [Number(n.compras),   'compra',   'compras'],
    [Number(n.pedidos),   'pedido',   'pedidos'],
    [Number(n.ventas),    'venta',    'ventas'],
    [Number(n.insumos),   'insumo',   'insumos'],
    [Number(n.empleados), 'empleado', 'empleados'],
    [Number(n.usuarios),  'usuario',  'usuarios'],
  ];
  const partes = cats.filter(([c]) => c > 0).map(([c, s, p]) => `${c} ${c === 1 ? s : p}`);
  if (partes.length) {
    const total = cats.reduce((a, [c]) => a + c, 0);
    const listado = partes.length === 1
      ? partes[0]
      : `${partes.slice(0, -1).join(', ')} y ${partes[partes.length - 1]}`;
    return res.status(409).json({
      error: `No se puede eliminar: este local tiene ${listado} asociado${total === 1 ? '' : 's'}. Elimina o reasigna esos registros primero.`,
    });
  }

  await pool.query('DELETE FROM locales WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
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