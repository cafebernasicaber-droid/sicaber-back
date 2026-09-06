const router  = require('express').Router();
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const pool    = require('../config/db');
const { auth } = require('../middleware/auth');
// Misma constante que usa GET /clientes/mi-perfil (routes/index.js) — así
// el login/sesión de cliente (esta ruta y GET /me) devuelve exactamente
// el mismo perfil completo que ya muestra la web, con los mismos nombres
// de campo, en vez de un subconjunto recortado.
const { CLIENTE_COLS } = require('../config/clienteCols');
// Permisos vigentes del rol del usuario. Ver middleware/permisos.js: sin
// esto, /login y /me devolvían el usuario SIN su lista de permisos, así que
// el frontend (sidebar dinámico, PrivateRoute, HomeRedirect) se quedaba a
// ciegas y todo rol distinto de Administrador veía el panel vacío.
const { permisosDeRol } = require('../middleware/permisos');
const { passwordValida, PASSWORD_ERROR, errorPassword } = require('../config/passwordPolicy');
// Validaciones compartidas de texto (ver config/validaciones.js): nombre no
// vacío / no solo espacios y tope de longitud en el registro de clientes.
const { textoLimpio, nombreNormalizado, errorNombre, errorDocumento, LIMITES } = require('../config/validaciones');
const { enviarTokenRegistro, enviarTokenRecuperacion } = require('../services/mailer');

const sign = (payload) => jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '8h' });

const genToken = () => String(Math.floor(100000 + Math.random() * 900000)); // 6 dígitos

// Mensaje ÚNICO para cualquier fallo de login (usuario/correo inexistente,
// contraseña incorrecta, o ambos): nunca se revela cuál de los dos falló —
// si dijéramos "ese correo no existe" un atacante podría enumerar cuentas.
const ERROR_CREDENCIALES = 'El correo o la contraseña son incorrectos.';
// Hash "señuelo" (de una contraseña aleatoria descartada) para gastar el
// mismo tiempo de bcrypt cuando el usuario NO existe. Sin esto, "usuario
// inexistente" respondería al instante y "contraseña incorrecta" tardaría
// ~100ms (bcrypt.compare), y esa diferencia de latencia delataría igual qué
// correos están registrados.
const HASH_SENUELO = '$2a$10$ntHThjxQboTY7/XSp7IQUewDjoS1i2qiCY3KxwVIfPNapdO.M1DkC';

// ── ADMIN/EMPLEADO LOGIN (usuario, correo, o nombre) ────────────────────────
router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const { rows } = await pool.query(
      'SELECT * FROM usuarios WHERE lower(username)=lower($1) OR lower(correo)=lower($1) OR nombre ILIKE $1',
      [username]
    );
    const u = rows[0];
    // Siempre se ejecuta bcrypt.compare (contra el hash real o el señuelo),
    // para que la respuesta tarde lo mismo exista o no la cuenta.
    const ok = await bcrypt.compare(String(password || ''), u ? u.password : HASH_SENUELO);
    if (!u || !ok) return res.status(401).json({ error: ERROR_CREDENCIALES });
    // "sede" viaja en el JWT para que el middleware `auth` la exponga en
    // req.user y las rutas puedan filtrar pedidos por local sin tener que
    // volver a consultar la tabla usuarios en cada petición. "local_id" (la
    // referencia real a locales.id) viaja por el mismo motivo: POST /insumos
    // lo usa para asignar automáticamente el local del insumo. "es_superadmin"
    // viaja también: el Superadministrador NO tiene un local fijo, así que al
    // crear un insumo/compra debe ELEGIR el local a mano (el frontend usa
    // este flag para mostrar el selector en vez de asumir un local).
    const token = sign({ id: u.id, username: u.username, rol: u.rol, sede: u.sede, local_id: u.local_id, es_superadmin: u.es_superadmin });
    // Los permisos se leen de la tabla `roles` en cada login y NO viajan
    // dentro del JWT: si viajaran en el token, un cambio de permisos hecho
    // desde el panel de Roles no tendría efecto hasta que el token expirara
    // (8 h) o el usuario cerrara sesión a mano.
    const permisos = await permisosDeRol(u.rol);
    res.json({ token, usuario: { id: u.id, nombre: u.nombre, username: u.username, rol: u.rol, sede: u.sede, local_id: u.local_id, es_superadmin: u.es_superadmin, permisos } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── CLIENTE REGISTRO — envía token al correo ───────────────────────────────
router.post('/cliente/registro', async (req, res) => {
  const {
    nombre: nombre_, correo: correo_, username: username_,
    password, telefono, tipoDoc, numeroDoc, departamento, municipio, comuna, direccion,
  } = req.body;
  try {
    // El nombre nunca se revisaba: un registro con nombre = "   " quedaba
    // guardado tal cual. El correo se normaliza a minúsculas porque es la
    // llave de inicio de sesión y del envío del token de verificación:
    // "ana@gmail.com" y "Ana@Gmail.com" son la MISMA cuenta, pero antes se
    // registraban dos veces.
    const errorNom = errorNombre(nombre_, 'El nombre', LIMITES.NOMBRE);
    if (errorNom) return res.status(400).json({ error: errorNom });
    const nombre = nombreNormalizado(nombre_);

    const correo = textoLimpio(correo_).toLowerCase();
    if (!correo) return res.status(400).json({ error: 'El correo electrónico es obligatorio.' });

    const username = username_ ? nombreNormalizado(username_) : null;

    // El campo "Otros" del tipo de documento siempre debe llegar ya resuelto
    // al nombre real que escribió el usuario (ej. "Pasaporte"); si llega el
    // valor literal "Otros" es que el frontend no lo resolvió o alguien
    // intenta saltarse la validación manualmente.
    if (tipoDoc === 'Otros') return res.status(400).json({ error: 'Debes especificar el tipo de documento.' });

    // Número de documento: opcional, pero si viene → solo dígitos, máx 10.
    const errorDoc = errorDocumento(numeroDoc);
    if (errorDoc) return res.status(400).json({ error: errorDoc });

    if (!passwordValida(password)) return res.status(400).json({ error: errorPassword(password) });

    // Verificar duplicados. El correo se valida aparte porque es el caso
    // más común y necesita un mensaje claro y específico.
    // lower() a ambos lados: así también se detectan las cuentas viejas que
    // ya quedaron guardadas con mayúsculas antes de esta corrección.
    const existeCorreo = await pool.query('SELECT id FROM clientes WHERE lower(correo)=lower($1)', [correo]);
    if (existeCorreo.rows[0]) return res.status(400).json({ error: 'Este correo electrónico ya se encuentra registrado.' });
    if (username) {
      const existeUser = await pool.query('SELECT id FROM clientes WHERE lower(username)=lower($1)', [username]);
      if (existeUser.rows[0]) return res.status(400).json({ error: 'Ese nombre de usuario ya está en uso.' });
    }

    // Guardar cliente sin verificar
    const hash = await bcrypt.hash(password, 10);
    const { rows } = await pool.query(
      `INSERT INTO clientes(nombre,correo,password,telefono,username,tipo_doc,numero_doc,departamento,municipio,comuna,direccion,verificado)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,false) RETURNING id,nombre,correo`,
      [nombre, correo, hash, telefono||null, username||null, tipoDoc||null, numeroDoc||null, departamento||null, municipio||null, comuna||null, direccion||null]
    );

    // Generar y guardar token
    const token = genToken();
    await pool.query(
      'INSERT INTO tokens_verificacion(correo,token,tipo) VALUES($1,$2,$3)',
      [correo, token, 'registro']
    );

    // Enviar correo
    await enviarTokenRegistro(correo, nombre, token);

    res.status(201).json({ mensaje: 'Registro exitoso. Revisa tu correo para confirmar tu cuenta.', correo });
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ error: 'Este correo electrónico ya se encuentra registrado.' });
    res.status(500).json({ error: e.message });
  }
});

// ── VERIFICAR TOKEN DE REGISTRO ────────────────────────────────────────────
router.post('/cliente/verificar', async (req, res) => {
  const { correo, token } = req.body;
  try {
    const { rows } = await pool.query(
      `SELECT * FROM tokens_verificacion 
       WHERE lower(correo)=lower($1) AND token=$2 AND tipo='registro' AND usado=false AND expires_at > NOW()`,
      [correo, token]
    );
    if (!rows[0]) return res.status(400).json({ error: 'Código inválido o expirado.' });

    // Marcar verificado
    await pool.query('UPDATE clientes SET verificado=true WHERE lower(correo)=lower($1)', [correo]);
    await pool.query('UPDATE tokens_verificacion SET usado=true WHERE id=$1', [rows[0].id]);

    // Devolver JWT
    const cli = await pool.query('SELECT * FROM clientes WHERE lower(correo)=lower($1)', [correo]);
    const c = cli.rows[0];
    const jwtToken = sign({ id: c.id, correo: c.correo, rol: 'Cliente' });
    res.json({ token: jwtToken, cliente: { id: c.id, nombre: c.nombre, correo: c.correo } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── CLIENTE LOGIN (correo O username O nombre) ─────────────────────────────
router.post('/cliente/login', async (req, res) => {
  const { correo, password } = req.body; // correo puede ser correo, username o nombre
  try {
    const { rows } = await pool.query(
      'SELECT * FROM clientes WHERE lower(correo)=lower($1) OR lower(username)=lower($1) OR nombre ILIKE $1',
      [correo]
    );
    const c = rows[0];
    const ok = await bcrypt.compare(String(password || ''), c ? c.password : HASH_SENUELO);
    if (!c || !ok) return res.status(401).json({ error: ERROR_CREDENCIALES });
    const token = sign({ id: c.id, correo: c.correo, rol: 'Cliente' });
    // Perfil completo (mismas columnas/alias que GET /clientes/mi-perfil),
    // + username, que ya se usaba para iniciar sesión pero no forma parte
    // de CLIENTE_COLS (la web no lo muestra en "Mi perfil", pero el login
    // ya lo devolvía y algún cliente móvil puede depender de él).
    const { rows: perfil } = await pool.query(
      `SELECT ${CLIENTE_COLS}, username FROM clientes WHERE id=$1`, [c.id]
    );
    res.json({ token, cliente: perfil[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── SOLICITAR RECUPERACIÓN ─────────────────────────────────────────────────
// Respuesta SIEMPRE genérica (mismo texto, mismo 200) exista o no una cuenta
// con ese correo: si dijéramos "no existe una cuenta con ese correo", un
// atacante podría enumerar qué correos están registrados. El código solo se
// genera y envía cuando la cuenta existe de verdad, pero eso no se revela.
router.post('/cliente/recuperar', async (req, res) => {
  const { correo } = req.body;
  const RESPUESTA_GENERICA = { mensaje: 'Si existe una cuenta con ese correo, te enviamos un código para restablecer la contraseña.' };
  try {
    const correoLimpio = textoLimpio(correo).toLowerCase();
    if (!correoLimpio) return res.status(400).json({ error: 'El correo electrónico es obligatorio.' });

    const { rows } = await pool.query('SELECT id,nombre FROM clientes WHERE lower(correo)=lower($1)', [correoLimpio]);
    if (rows[0]) {
      const token = genToken();
      await pool.query(
        'INSERT INTO tokens_verificacion(correo,token,tipo) VALUES($1,$2,$3)',
        [correoLimpio, token, 'recuperacion']
      );
      await enviarTokenRecuperacion(correoLimpio, rows[0].nombre, token);
    }
    res.json(RESPUESTA_GENERICA);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── VERIFICAR TOKEN RECUPERACIÓN + NUEVA CONTRASEÑA ───────────────────────
router.post('/cliente/reset-password', async (req, res) => {
  const { correo, token, nuevaPassword } = req.body;
  try {
    if (!passwordValida(nuevaPassword)) return res.status(400).json({ error: errorPassword(nuevaPassword) });

    const { rows } = await pool.query(
      `SELECT * FROM tokens_verificacion
       WHERE lower(correo)=lower($1) AND token=$2 AND tipo='recuperacion' AND usado=false AND expires_at > NOW()`,
      [correo, token]
    );
    if (!rows[0]) return res.status(400).json({ error: 'Código inválido o expirado.' });

    const hash = await bcrypt.hash(nuevaPassword, 10);
    await pool.query('UPDATE clientes SET password=$1 WHERE lower(correo)=lower($2)', [hash, correo]);
    await pool.query('UPDATE tokens_verificacion SET usado=true WHERE id=$1', [rows[0].id]);

    res.json({ mensaje: 'Contraseña actualizada correctamente.' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/auth/me ───────────────────────────────────────────────────────
router.get('/me', auth, async (req, res) => {
  try {
    if (req.user.rol === 'Cliente') {
      const { rows } = await pool.query(`SELECT ${CLIENTE_COLS}, username FROM clientes WHERE id=$1`, [req.user.id]);
      return res.json(rows[0]);
    }
    const { rows } = await pool.query('SELECT id,nombre,username,rol,sede,local_id,es_superadmin FROM usuarios WHERE id=$1', [req.user.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Usuario no encontrado' });
    // Siempre los permisos ACTUALES del rol, nunca los del momento del
    // login: AuthContext llama a /auth/me cada vez que carga la app y
    // refresca con esto el usuario en memoria y en localStorage. Es lo que
    // hace que editar un rol se refleje sin volver a iniciar sesión.
    const permisos = await permisosDeRol(rows[0].rol);
    res.json({ ...rows[0], permisos });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;