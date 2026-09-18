const router  = require('express').Router();
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const { OAuth2Client } = require('google-auth-library');
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
const { enviarTokenRegistro, enviarTokenRecuperacion, mensajeErrorCorreo } = require('../services/mailer');
// Ciclo de vida completo del código de 6 dígitos (generar con crypto,
// invalidar los anteriores, vencimiento explícito, límite de intentos y
// de reenvíos). Ver services/codigosVerificacion.js.
const codigos = require('../services/codigosVerificacion');

const sign = (payload) => jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '8h' });

// Mismo Client ID configurado en Google Cloud Console (usado también por el
// frontend en @react-oauth/google). El Client Secret NO hace falta acá: solo
// se usa al verificar un ID token con verifyIdToken(), no un authorization
// code, así que GOOGLE_CLIENT_ID es la única variable que este flujo lee.
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

// Respuesta de error interna UNIFORME. Antes cada catch hacía
// `res.status(500).json({ error: e.message })`, lo que devolvía al
// navegador el texto crudo de Postgres o del servidor SMTP ("relation
// «tokens_verificacion» does not exist", "Invalid login: 535-5.7.8 ...").
// Eso no le sirve a nadie que use la app y sí le sirve a quien la esté
// atacando. El detalle real queda en el log del servidor, donde debe estar.
const errorServidor = (res, e, contexto) => {
  console.error(`💥 ${contexto}:`, e);
  return res.status(500).json({ error: 'Ocurrió un error en el servidor. Intenta de nuevo en unos minutos.' });
};

// Envía el código y traduce el resultado a algo que el frontend pueda
// mostrar. NUNCA lanza: un fallo de correo no debe tumbar la petición que
// lo disparó (era justo lo que dejaba el registro "cargando" para siempre).
const enviarCodigo = async (tipo, correo, nombre, codigo, minutos) => {
  const enviar = tipo === 'registro' ? enviarTokenRegistro : enviarTokenRecuperacion;
  const resultado = await enviar(correo, nombre, codigo, minutos);
  if (resultado.ok) return { enviado: true, aviso: null };
  return { enviado: false, aviso: mensajeErrorCorreo(resultado.codigo), codigoError: resultado.codigo };
};

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
    // Cuenta desactivada (a mano, o en cascada al desactivar su rol — ver
    // PATCH /roles/:id/estado): antes esto no se revisaba en absoluto acá,
    // así que "desactivar" un usuario no le impedía seguir iniciando
    // sesión con total normalidad. Va DESPUÉS de validar la contraseña
    // (nunca antes): así no se revela si una cuenta existe/está inactiva
    // a quien todavía no probó la contraseña correcta.
    if (u.estado !== 'Activo') {
      return res.status(403).json({ error: 'Tu cuenta está desactivada. Contacta a un administrador.' });
    }
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
  } catch (e) { return errorServidor(res, e, 'POST /auth/login'); }
});

// ── CLIENTE REGISTRO — envía token al correo ───────────────────────────────
router.post('/cliente/registro', async (req, res) => {
  const {
    nombre: nombre_, correo: correo_, username: username_,
    password, telefono, tipoDoc, numeroDoc,
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
    const existeCorreo = await pool.query('SELECT id, verificado FROM clientes WHERE lower(correo)=lower($1)', [correo]);
    if (existeCorreo.rows[0]) {
      // Callejón sin salida que existía antes: si el correo del primer
      // intento se enviaba mal (o nunca llegaba), la cuenta quedaba creada
      // SIN verificar y cualquier intento de volver a registrarse chocaba
      // con este mismo "ya está registrado", sin ninguna forma de pedir
      // otro código. Ahora se distingue el caso y se le dice al frontend
      // (requiereVerificacion) que ofrezca "reenviar código" en vez de
      // mandar al usuario a un login que tampoco va a poder completar.
      if (!existeCorreo.rows[0].verificado) {
        return res.status(400).json({
          error: 'Ese correo ya tiene una cuenta pendiente de confirmar. Te podemos reenviar el código de verificación.',
          requiereVerificacion: true,
          correo,
        });
      }
      return res.status(400).json({ error: 'Este correo electrónico ya se encuentra registrado.' });
    }
    if (username) {
      const existeUser = await pool.query('SELECT id FROM clientes WHERE lower(username)=lower($1)', [username]);
      if (existeUser.rows[0]) return res.status(400).json({ error: 'Ese nombre de usuario ya está en uso.' });
    }

    // Guardar cliente sin verificar
    const hash = await bcrypt.hash(password, 10);
    const { rows } = await pool.query(
      `INSERT INTO clientes(nombre,correo,password,telefono,username,tipo_doc,numero_doc,verificado)
       VALUES($1,$2,$3,$4,$5,$6,$7,false) RETURNING id,nombre,correo`,
      [nombre, correo, hash, telefono||null, username||null, tipoDoc||null, numeroDoc||null]
    );

    // Generar y guardar el código (invalidando cualquier anterior de este
    // mismo correo — ver services/codigosVerificacion.js).
    const emitido = await codigos.emitirCodigo(correo, 'registro');

    // El envío del correo va DESPUÉS de que la cuenta ya existe y el código
    // ya está guardado, y su resultado NO decide el éxito del registro: la
    // cuenta se creó de verdad, y si el correo no salió, el usuario tiene
    // el botón de "reenviar código" (POST /cliente/reenviar-codigo). Antes
    // un fallo de SMTP hacía fallar todo el registro con un 500 crudo —
    // dejando la cuenta creada igual, pero al usuario convencido de que no.
    const correoEnvio = await enviarCodigo('registro', correo, nombre, emitido.codigo, emitido.minutos);

    res.status(201).json({
      mensaje: correoEnvio.enviado
        ? 'Registro exitoso. Revisa tu correo para confirmar tu cuenta.'
        : 'Tu cuenta quedó creada, pero no pudimos enviarte el código en este momento. Usa la opción de reenviar el código.',
      correo,
      // Contrato explícito para el frontend: si es false, la pantalla debe
      // mostrar el aviso y el botón de reenvío en vez del "revisa tu correo".
      correoEnviado: correoEnvio.enviado,
      avisoCorreo: correoEnvio.aviso,
      expiraEnMinutos: emitido.minutos,
    });
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ error: 'Este correo electrónico ya se encuentra registrado.' });
    return errorServidor(res, e, 'POST /auth/cliente/registro');
  }
});

// ── REENVIAR CÓDIGO DE VERIFICACIÓN ────────────────────────────────────────
// No existía: si el primer correo no llegaba (spam, dedazo en la dirección,
// SMTP caído en el despliegue), la cuenta quedaba creada sin verificar y sin
// ninguna manera de conseguir otro código.
//
// Sirve para los dos flujos, según "tipo":
//   • 'registro'     (por defecto) → confirmar una cuenta recién creada
//   • 'recuperacion'               → reenviar el código de restablecer clave
//
// Emitir un código nuevo INVALIDA el anterior (regla del módulo de códigos),
// así que "reenviar" nunca deja dos códigos vivos a la vez.
router.post('/cliente/reenviar-codigo', async (req, res) => {
  const tipo = req.body?.tipo === 'recuperacion' ? 'recuperacion' : 'registro';
  // Respuesta genérica por el mismo motivo que /cliente/recuperar: si
  // dijéramos "ese correo no existe", esta ruta se volvería un enumerador
  // de cuentas registradas. El código solo se genera cuando la cuenta
  // existe de verdad y está en el estado que corresponde.
  const RESPUESTA_GENERICA = {
    mensaje: 'Si ese correo tiene una cuenta pendiente, te enviamos un código nuevo.',
    correoEnviado: true,
  };
  try {
    const correo = textoLimpio(req.body?.correo).toLowerCase();
    if (!correo) return res.status(400).json({ error: 'El correo electrónico es obligatorio.' });

    const { rows } = await pool.query(
      'SELECT id, nombre, verificado FROM clientes WHERE lower(correo)=lower($1)', [correo]
    );
    const cliente = rows[0];

    // Cuenta ya confirmada + tipo 'registro': no hay nada que reenviar, y
    // decirlo no filtra nada que el propio login no revele ya.
    if (cliente && cliente.verificado && tipo === 'registro') {
      return res.status(400).json({
        error: 'Esa cuenta ya está confirmada. Puedes iniciar sesión normalmente.',
        yaVerificado: true,
      });
    }

    if (!cliente) return res.json(RESPUESTA_GENERICA);

    // Límite de frecuencia: sin esto, el botón de "reenviar" se puede
    // pulsar en bucle y convertir la cuenta de correo del sistema en un
    // emisor de spam (que Gmail termina bloqueando).
    const faltan = await codigos.segundosParaReenviar(correo, tipo);
    if (faltan > 0) {
      return res.status(429).json({
        error: `Ya te enviamos un código hace poco. Espera ${faltan} segundo${faltan === 1 ? '' : 's'} antes de pedir otro.`,
        segundosRestantes: faltan,
      });
    }

    const emitido = await codigos.emitirCodigo(correo, tipo);
    const correoEnvio = await enviarCodigo(tipo, correo, cliente.nombre, emitido.codigo, emitido.minutos);
    if (!correoEnvio.enviado) {
      // 502: el fallo es del servicio de correo, no de lo que mandó el
      // usuario. Con un mensaje claro y accionable, no el error de SMTP.
      return res.status(502).json({
        error: correoEnvio.aviso,
        correoEnviado: false,
        puedeReintentar: true,
      });
    }
    res.json({
      mensaje: 'Te enviamos un código nuevo. Revisa tu correo.',
      correoEnviado: true,
      expiraEnMinutos: emitido.minutos,
    });
  } catch (e) { return errorServidor(res, e, 'POST /auth/cliente/reenviar-codigo'); }
});

// ── VERIFICAR TOKEN DE REGISTRO ────────────────────────────────────────────
router.post('/cliente/verificar', async (req, res) => {
  const { correo: correo_, token } = req.body;
  try {
    const correo = textoLimpio(correo_).toLowerCase();
    if (!correo) return res.status(400).json({ error: 'El correo electrónico es obligatorio.' });
    if (!textoLimpio(token)) return res.status(400).json({ error: 'Escribe el código de 6 dígitos que te enviamos.' });

    // La cuenta tiene que existir antes de gastar un intento del código.
    const { rows: filaCliente } = await pool.query(
      'SELECT * FROM clientes WHERE lower(correo)=lower($1)', [correo]
    );
    const c = filaCliente[0];
    if (!c) return res.status(400).json({ error: 'No existe una cuenta con ese correo.' });

    // Confirmar dos veces el mismo correo ya no es un error: la segunda vez
    // devuelve la sesión igual que la primera. Antes daba "código inválido
    // o expirado" (porque el código ya estaba usado), un mensaje que hacía
    // pensar que algo había fallado cuando la cuenta estaba perfecta.
    if (c.verificado) {
      const jwtToken = sign({ id: c.id, correo: c.correo, rol: 'Cliente' });
      return res.json({
        token: jwtToken,
        cliente: { id: c.id, nombre: c.nombre, correo: c.correo },
        yaVerificado: true,
      });
    }

    // Validación completa (existencia, vencimiento, intentos y comparación
    // en tiempo constante) — ver services/codigosVerificacion.js.
    const resultado = await codigos.validarCodigo(correo, 'registro', token);
    if (!resultado.ok) {
      return res.status(400).json({
        error: codigos.mensajeMotivo(resultado.motivo, resultado.intentosRestantes),
        motivo: resultado.motivo,
        // Le dice al frontend, sin ambigüedad, cuándo mostrar el botón de
        // "reenviar código" en vez de dejar al usuario reintentando a ciegas.
        puedeReenviar: ['expirado', 'bloqueado', 'no_solicitado'].includes(resultado.motivo),
        ...(Number.isInteger(resultado.intentosRestantes) ? { intentosRestantes: resultado.intentosRestantes } : {}),
      });
    }

    await pool.query('UPDATE clientes SET verificado=true WHERE id=$1', [c.id]);

    const jwtToken = sign({ id: c.id, correo: c.correo, rol: 'Cliente' });
    res.json({ token: jwtToken, cliente: { id: c.id, nombre: c.nombre, correo: c.correo } });
  } catch (e) { return errorServidor(res, e, 'POST /auth/cliente/verificar'); }
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
    // Mismo chequeo que el login de usuarios/empleados — clientes.estado
    // ya se podía poner en 'Inactivo' desde PATCH /clientes/:id/estado,
    // pero no bloqueaba el login en absoluto.
    if (c.estado !== 'Activo') {
      return res.status(403).json({ error: 'Tu cuenta está desactivada. Contacta a un administrador.' });
    }
    const token = sign({ id: c.id, correo: c.correo, rol: 'Cliente' });
    // Perfil completo (mismas columnas/alias que GET /clientes/mi-perfil),
    // + username, que ya se usaba para iniciar sesión pero no forma parte
    // de CLIENTE_COLS (la web no lo muestra en "Mi perfil", pero el login
    // ya lo devolvía y algún cliente móvil puede depender de él).
    const { rows: perfil } = await pool.query(
      `SELECT ${CLIENTE_COLS}, username FROM clientes WHERE id=$1`, [c.id]
    );
    res.json({ token, cliente: perfil[0] });
  } catch (e) { return errorServidor(res, e, 'POST /auth/cliente/login'); }
});

// ── CLIENTE LOGIN/REGISTRO CON GOOGLE ──────────────────────────────────────
// El frontend manda el "credential" (ID token JWT) que devuelve el botón de
// @react-oauth/google. Acá se verifica CONTRA GOOGLE (nunca se confía en lo
// que declara el propio token sin validarlo) y, según si el correo ya existe
// en `clientes`, se hace login o se crea la cuenta en el mismo paso — el
// usuario nunca ve una pantalla de "registro" aparte cuando entra con Google.
router.post('/cliente/google', async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'Falta el token de Google.' });
  try {
    // verifyIdToken revisa la firma, el emisor y que el "audience" sea
    // nuestro Client ID. Si el token viene alterado o es de otra app, esto
    // lanza y cae al catch — nunca se llega a leer el payload sin validar.
    const ticket = await googleClient.verifyIdToken({
      idToken: token,
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();

    // email_verified=false pasa con cuentas de Google Workspace mal
    // configuradas o correos no confirmados dentro de Google mismo. No
    // podemos confiar en el correo como identidad si Google tampoco confía.
    if (!payload.email_verified) {
      return res.status(400).json({ error: 'Tu cuenta de Google no tiene el correo verificado.' });
    }
    const correo = payload.email.toLowerCase();
    const nombre = payload.name || correo.split('@')[0];

    let { rows } = await pool.query('SELECT * FROM clientes WHERE lower(correo)=lower($1)', [correo]);
    let c = rows[0];

    if (!c) {
      // Cuenta nueva: password aleatoria (nadie la va a usar — este cliente
      // siempre entra por Google) para no violar la columna NOT NULL que
      // usa el registro normal. verificado=true de una: Google ya confirmó
      // ese correo, así que no tiene sentido mandarle un código de 6 dígitos.
      const passwordAleatoria = await bcrypt.hash(require('crypto').randomBytes(32).toString('hex'), 10);
      const insert = await pool.query(
        `INSERT INTO clientes(nombre,correo,password,verificado)
         VALUES($1,$2,$3,true) RETURNING id`,
        [nombre, correo, passwordAleatoria]
      );
      c = insert.rows[0];
    } else if (c.estado !== 'Activo') {
      // Misma regla que el login normal: una cuenta desactivada no debe
      // poder volver a entrar solo porque usó Google en vez de contraseña.
      return res.status(403).json({ error: 'Tu cuenta está desactivada. Contacta a un administrador.' });
    } else if (!c.verificado) {
      // Cuenta creada antes por registro normal pero nunca confirmó el
      // código por correo: si ahora entra con Google a esa misma dirección,
      // Google ya está confirmando que el correo es suyo, así que la
      // verificamos acá y le ahorramos el paso del código de 6 dígitos.
      await pool.query('UPDATE clientes SET verificado=true WHERE id=$1', [c.id]);
    }

    const jwtToken = sign({ id: c.id, correo, rol: 'Cliente' });
    // Mismo perfil completo que devuelve /cliente/login, para que el
    // frontend reuse tal cual el mismo manejo de sesión.
    const { rows: perfil } = await pool.query(
      `SELECT ${CLIENTE_COLS}, username FROM clientes WHERE id=$1`, [c.id]
    );
    res.json({ token: jwtToken, cliente: perfil[0] });
  } catch (e) {
    // verifyIdToken lanza si el token es inválido, expiró, o no es de
    // nuestro Client ID — todos esos casos son "credencial mala", no un
    // error 500 del servidor.
    if (e.message?.includes('Token used too late') || e.message?.includes('Wrong recipient') || e.message?.includes('Invalid token signature')) {
      return res.status(401).json({ error: 'No se pudo verificar tu cuenta de Google. Intenta de nuevo.' });
    }
    return errorServidor(res, e, 'POST /auth/cliente/google');
  }
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
      // Mismo límite de frecuencia que el reenvío, pero SIN cambiar la
      // respuesta: avisar "espera 40 segundos" acá delataría que la cuenta
      // existe, justo lo que esta ruta evita a propósito. Si todavía está
      // en el período de espera, simplemente no se manda otro correo.
      const faltan = await codigos.segundosParaReenviar(correoLimpio, 'recuperacion');
      if (faltan === 0) {
        const emitido = await codigos.emitirCodigo(correoLimpio, 'recuperacion');
        // El resultado del envío tampoco cambia la respuesta (mismo motivo),
        // pero sí queda registrado en el log para poder diagnosticarlo.
        const envio = await enviarCodigo('recuperacion', correoLimpio, rows[0].nombre, emitido.codigo, emitido.minutos);
        if (!envio.enviado) {
          console.error(`✉️  No se pudo enviar el código de recuperación (${envio.codigoError}).`);
        }
      }
    }
    res.json(RESPUESTA_GENERICA);
  } catch (e) { return errorServidor(res, e, 'POST /auth/cliente/recuperar'); }
});

// ── VERIFICAR TOKEN RECUPERACIÓN + NUEVA CONTRASEÑA ───────────────────────
router.post('/cliente/reset-password', async (req, res) => {
  const { correo: correo_, token, nuevaPassword } = req.body;
  try {
    const correo = textoLimpio(correo_).toLowerCase();
    if (!correo) return res.status(400).json({ error: 'El correo electrónico es obligatorio.' });
    if (!passwordValida(nuevaPassword)) return res.status(400).json({ error: errorPassword(nuevaPassword) });

    // Mismo validador que el registro: vencimiento, intentos y comparación
    // en tiempo constante, con motivos diferenciados.
    const resultado = await codigos.validarCodigo(correo, 'recuperacion', token);
    if (!resultado.ok) {
      return res.status(400).json({
        error: codigos.mensajeMotivo(resultado.motivo, resultado.intentosRestantes),
        motivo: resultado.motivo,
        puedeReenviar: ['expirado', 'bloqueado', 'no_solicitado'].includes(resultado.motivo),
        ...(Number.isInteger(resultado.intentosRestantes) ? { intentosRestantes: resultado.intentosRestantes } : {}),
      });
    }

    const hash = await bcrypt.hash(nuevaPassword, 10);
    const { rowCount } = await pool.query(
      'UPDATE clientes SET password=$1 WHERE lower(correo)=lower($2)', [hash, correo]
    );
    // El código era válido pero la cuenta ya no existe (se eliminó entre la
    // solicitud y el restablecimiento): sin este chequeo, la respuesta decía
    // "contraseña actualizada" sin haber actualizado nada.
    if (rowCount === 0) return res.status(400).json({ error: 'No existe una cuenta con ese correo.' });

    res.json({ mensaje: 'Contraseña actualizada correctamente.' });
  } catch (e) { return errorServidor(res, e, 'POST /auth/cliente/reset-password'); }
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
  } catch (e) { return errorServidor(res, e, 'GET /auth/me'); }
});

module.exports = router;