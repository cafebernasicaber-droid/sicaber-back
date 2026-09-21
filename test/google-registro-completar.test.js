// ─────────────────────────────────────────────────────────────────────────
//  Tests de integración: completar cuenta mediante Google (requisito 1)
// ─────────────────────────────────────────────────────────────────────────
// Qué se prueba, de punta a punta y contra la base real:
//   • Correo NUEVO → NO se crea ningún cliente; se devuelve un token
//     TEMPORAL de registro (con propósito y vencimiento).
//   • Abandonar el formulario NO deja ninguna cuenta incompleta.
//   • POST /auth/cliente/google/completar crea la cuenta COMPLETA
//     (verificado=true, estado Activo, teléfono y documento guardados) y
//     devuelve el mismo formato de sesión que el login.
//   • Después se puede iniciar sesión con correo + contraseña.
//   • Correo YA EXISTENTE → login normal, sin token de registro.
//   • El token temporal no sirve para otra cosa (propósito) ni dos veces.
//
// CÓMO SE PRUEBA LA PARTE DE GOOGLE:
//   La ruta verifica el ID token contra los servidores de Google, y no hay
//   forma de fabricar uno firmado por Google. Este archivo levanta SU PROPIO
//   servidor (mismo código, misma base, otro puerto) con
//   `--require scripts/stub-google-pruebas.js`, que reemplaza ÚNICAMENTE esa
//   llamada de red. Todo lo demás —las ramas de la ruta, la emisión del
//   token, las consultas a la base— es el código real. El servidor normal de
//   la suite no se toca y sigue verificando contra Google de verdad.
//
// Ejecutar: npm test
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');

const BASE_SUITE = process.env.TEST_BASE_URL || 'http://localhost:4000/api';
const ADMIN_USER = process.env.TEST_ADMIN_USER || 'Admin_Sicaber';
const ADMIN_PASS = process.env.TEST_ADMIN_PASS || 'admin2024#';
// Puerto propio, distinto al de la suite, para el servidor con Google
// sustituido. Configurable por si 4097 estuviera ocupado.
const PUERTO_GOOGLE = process.env.TEST_GOOGLE_PORT || '4097';
const BASE = `http://localhost:${PUERTO_GOOGLE}/api`;

const PASSWORD_VALIDA = 'Sicaber2026#';

let servidorGoogle;
let tokenAdmin;
const correosCreados = [];

const api = async (ruta, { method = 'GET', token, body, base = BASE } = {}) => {
  const res = await fetch(`${base}${ruta}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
};

// Token falso que entiende el sustituto — ver scripts/stub-google-pruebas.js.
const tokenGoogle = (correo, nombre = 'Cliente Google', verificado = true) =>
  `prueba-google:${correo}:${nombre}:${verificado ? '1' : '0'}`;

const correoUnico = (etiqueta) =>
  `google.${etiqueta}.${Date.now()}.${Math.floor(Math.random() * 1e6)}@pruebas-sicaber.test`;

// Busca un cliente por correo usando la API de administración — es la forma
// de comprobar, desde afuera, si la cuenta EXISTE o no en la base.
const clientePorCorreo = async (correo) => {
  const listado = await api('/clientes', { token: tokenAdmin, base: BASE_SUITE });
  if (!Array.isArray(listado.data)) return null;
  return listado.data.find((c) => String(c.correo || '').toLowerCase() === correo.toLowerCase()) || null;
};

const esperarArranque = (hijo) => new Promise((resolver, rechazar) => {
  let listo = false;
  const temporizador = setTimeout(() => {
    if (!listo) rechazar(new Error('El servidor con Google sustituido no arrancó en 60s.'));
  }, 60000);
  hijo.stdout.on('data', (buf) => {
    if (!listo && buf.toString().includes('Migraciones verificadas')) {
      listo = true; clearTimeout(temporizador); resolver();
    }
  });
  hijo.on('exit', (code) => {
    if (!listo) { clearTimeout(temporizador); rechazar(new Error(`El servidor de Google terminó solo (código ${code}).`)); }
  });
});

before(async () => {
  const login = await api('/auth/login', {
    method: 'POST', base: BASE_SUITE, body: { username: ADMIN_USER, password: ADMIN_PASS },
  });
  assert.equal(login.status, 200, JSON.stringify(login.data));
  tokenAdmin = login.data.token;

  const raiz = path.join(__dirname, '..');
  servidorGoogle = spawn(
    process.execPath,
    ['--require', path.join(raiz, 'scripts', 'stub-google-pruebas.js'), path.join(raiz, 'src', 'index.js')],
    { env: { ...process.env, PORT: PUERTO_GOOGLE }, stdio: ['ignore', 'pipe', 'pipe'] }
  );
  servidorGoogle.stderr.on('data', (b) => process.stderr.write(b));
  await esperarArranque(servidorGoogle);
});

after(async () => {
  // Las cuentas creadas por estos tests se borran de verdad (no quedan
  // "Inactivas"): son clientes recién creados, sin pedidos asociados.
  for (const correo of correosCreados) {
    try {
      const cliente = await clientePorCorreo(correo);
      if (cliente) await api(`/clientes/${cliente.id}`, { method: 'DELETE', token: tokenAdmin, base: BASE_SUITE });
    } catch { /* la limpieza nunca debe hacer fallar la suite */ }
  }
  if (servidorGoogle && !servidorGoogle.killed) servidorGoogle.kill();
});

test('Google + correo NUEVO: no crea el cliente y devuelve un token temporal de registro', async () => {
  const correo = correoUnico('nuevo');
  correosCreados.push(correo);

  const r = await api('/auth/cliente/google', {
    method: 'POST', body: { token: tokenGoogle(correo, 'Ana Prueba') },
  });

  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.registroPendiente, true, 'debe avisar que falta completar el registro');
  assert.ok(r.data.tokenRegistro, 'debe venir el token temporal');
  assert.equal(r.data.token, undefined, 'NO debe emitir sesión todavía');
  assert.equal(r.data.cliente, undefined, 'NO debe devolver un cliente todavía');
  assert.equal(r.data.correo, correo, 'el correo de Google viaja al formulario');
  assert.equal(r.data.nombre, 'Ana Prueba', 'el nombre de Google viaja al formulario');
  assert.ok(Number(r.data.expiraEnMinutos) > 0, 'el token temporal debe tener vencimiento');

  // El token es un JWT con propósito propio: se comprueba leyendo su
  // contenido (no hace falta la clave para leer el payload).
  const payload = JSON.parse(Buffer.from(r.data.tokenRegistro.split('.')[1], 'base64').toString());
  assert.equal(payload.proposito, 'registro_google', 'el token debe declarar su propósito');
  assert.equal(payload.correo, correo, 'el token debe llevar el correo de Google');
  assert.ok(payload.nombre, 'el token debe llevar el nombre de Google');
  assert.ok(Number(payload.exp) > Math.floor(Date.now() / 1000), 'el token debe tener fecha de vencimiento futura');

  // LO MÁS IMPORTANTE: la base NO se tocó.
  assert.equal(await clientePorCorreo(correo), null, 'no debe existir ningún cliente con ese correo todavía');
});

test('Abandonar el formulario NO deja ninguna cuenta incompleta en la base', async () => {
  const correo = correoUnico('abandono');
  correosCreados.push(correo);

  const inicio = await api('/auth/cliente/google', { method: 'POST', body: { token: tokenGoogle(correo) } });
  assert.equal(inicio.status, 200, JSON.stringify(inicio.data));
  assert.ok(inicio.data.tokenRegistro);

  // El usuario cierra la pestaña: no se llama a /completar. Nada más pasa.
  assert.equal(await clientePorCorreo(correo), null, 'la base no debe tener rastro del registro abandonado');

  // Y el correo sigue libre para registrarse por la vía normal.
  const registroNormal = await api('/auth/cliente/registro', {
    method: 'POST',
    body: { nombre: 'Registro Normal', correo, password: PASSWORD_VALIDA, telefono: '3001234567', tipoDoc: 'CC', numeroDoc: '1234567890' },
  });
  assert.equal(registroNormal.status, 201, `el correo debe quedar libre: ${JSON.stringify(registroNormal.data)}`);
});

test('Completar registro: crea la cuenta completa, verificada y activa, y devuelve sesión', async () => {
  const correo = correoUnico('completar');
  correosCreados.push(correo);

  const inicio = await api('/auth/cliente/google', {
    method: 'POST', body: { token: tokenGoogle(correo, 'Carlos Prueba') },
  });
  assert.equal(inicio.status, 200, JSON.stringify(inicio.data));

  const completar = await api('/auth/cliente/google/completar', {
    method: 'POST',
    body: {
      tokenRegistro: inicio.data.tokenRegistro,
      password: PASSWORD_VALIDA,
      tipoDoc: 'CC',
      numeroDoc: '1098765432',
      telefono: '3019876543',
    },
  });

  assert.equal(completar.status, 201, JSON.stringify(completar.data));
  // Mismo formato que el login: { token, cliente }.
  assert.ok(completar.data.token, 'debe devolver el token de sesión');
  assert.ok(completar.data.cliente, 'debe devolver el cliente');
  assert.equal(completar.data.cliente.correo, correo);
  assert.equal(completar.data.cliente.nombre, 'Carlos Prueba', 'el nombre viene de Google, no del body');
  assert.equal(completar.data.cliente.telefono, '3019876543');
  assert.equal(completar.data.cliente.tipoDoc, 'CC');
  assert.equal(completar.data.cliente.numeroDoc, '1098765432');
  assert.equal(completar.data.cliente.estado, 'Activo');

  // La sesión devuelta sirve de verdad.
  const yo = await api('/auth/me', { token: completar.data.token });
  assert.equal(yo.status, 200, JSON.stringify(yo.data));
  assert.equal(yo.data.correo, correo);

  // Y la cuenta quedó PERSISTIDA (se ve desde la API de administración).
  const guardado = await clientePorCorreo(correo);
  assert.ok(guardado, 'el cliente debe existir en la base después de completar');
  assert.equal(guardado.telefono, '3019876543');
});

test('Después de completar el registro se puede iniciar sesión con correo y contraseña', async () => {
  const correo = correoUnico('login-posterior');
  correosCreados.push(correo);

  const inicio = await api('/auth/cliente/google', { method: 'POST', body: { token: tokenGoogle(correo) } });
  const completar = await api('/auth/cliente/google/completar', {
    method: 'POST',
    body: { tokenRegistro: inicio.data.tokenRegistro, password: PASSWORD_VALIDA, tipoDoc: 'CC', numeroDoc: '1122334455', telefono: '3005558888' },
  });
  assert.equal(completar.status, 201, JSON.stringify(completar.data));

  const login = await api('/auth/cliente/login', {
    method: 'POST', base: BASE_SUITE, body: { correo, password: PASSWORD_VALIDA },
  });
  assert.equal(login.status, 200, `debe poder entrar con contraseña: ${JSON.stringify(login.data)}`);
  assert.ok(login.data.token);
  assert.equal(login.data.cliente.correo, correo);

  // Una contraseña equivocada sigue fallando (la clave se guardó hasheada,
  // no en texto plano ni "cualquier cosa sirve").
  const malo = await api('/auth/cliente/login', {
    method: 'POST', base: BASE_SUITE, body: { correo, password: 'OtraClave2026#' },
  });
  assert.equal(malo.status, 401, JSON.stringify(malo.data));
});

test('Google + correo YA EXISTENTE: inicia sesión directo, sin pedir completar registro', async () => {
  const correo = correoUnico('existente');
  correosCreados.push(correo);

  // Se crea primero completando el registro con Google.
  const inicio = await api('/auth/cliente/google', { method: 'POST', body: { token: tokenGoogle(correo, 'Ya Existe') } });
  await api('/auth/cliente/google/completar', {
    method: 'POST',
    body: { tokenRegistro: inicio.data.tokenRegistro, password: PASSWORD_VALIDA, tipoDoc: 'CC', numeroDoc: '1011121314', telefono: '3007776655' },
  });

  // Segunda entrada con Google sobre el MISMO correo: login normal.
  const segunda = await api('/auth/cliente/google', { method: 'POST', body: { token: tokenGoogle(correo, 'Ya Existe') } });
  assert.equal(segunda.status, 200, JSON.stringify(segunda.data));
  assert.ok(segunda.data.token, 'debe devolver sesión');
  assert.ok(segunda.data.cliente, 'debe devolver el cliente');
  assert.equal(segunda.data.cliente.correo, correo);
  assert.ok(!segunda.data.registroPendiente, 'no debe pedir completar el registro otra vez');
  assert.equal(segunda.data.tokenRegistro, undefined);
});

test('Completar registro: rechaza token faltante, inválido o con propósito equivocado', async () => {
  const sinToken = await api('/auth/cliente/google/completar', {
    method: 'POST', body: { password: PASSWORD_VALIDA, tipoDoc: 'CC', numeroDoc: '123', telefono: '3001112233' },
  });
  assert.equal(sinToken.status, 400, JSON.stringify(sinToken.data));
  assert.equal(sinToken.data.motivo, 'faltante');

  const basura = await api('/auth/cliente/google/completar', {
    method: 'POST', body: { tokenRegistro: 'esto.no.es-un-jwt', password: PASSWORD_VALIDA, tipoDoc: 'CC', numeroDoc: '123', telefono: '3001112233' },
  });
  assert.equal(basura.status, 400, JSON.stringify(basura.data));
  assert.equal(basura.data.motivo, 'invalido');

  // Un token de SESIÓN válido (firmado con la misma clave) no debe servir
  // para crear una cuenta: el propósito se revisa siempre.
  const correo = correoUnico('proposito');
  correosCreados.push(correo);
  const inicio = await api('/auth/cliente/google', { method: 'POST', body: { token: tokenGoogle(correo) } });
  const completar = await api('/auth/cliente/google/completar', {
    method: 'POST',
    body: { tokenRegistro: inicio.data.tokenRegistro, password: PASSWORD_VALIDA, tipoDoc: 'CC', numeroDoc: '1516171819', telefono: '3004443322' },
  });
  assert.equal(completar.status, 201, JSON.stringify(completar.data));

  const conTokenDeSesion = await api('/auth/cliente/google/completar', {
    method: 'POST',
    body: { tokenRegistro: completar.data.token, password: PASSWORD_VALIDA, tipoDoc: 'CC', numeroDoc: '999', telefono: '3001112233' },
  });
  assert.equal(conTokenDeSesion.status, 400, JSON.stringify(conTokenDeSesion.data));
  assert.equal(conTokenDeSesion.data.motivo, 'proposito_incorrecto');
});

test('Completar registro: aplica la política de contraseña y valida documento y teléfono', async () => {
  const correo = correoUnico('validaciones');
  correosCreados.push(correo);
  const inicio = await api('/auth/cliente/google', { method: 'POST', body: { token: tokenGoogle(correo) } });
  const tokenRegistro = inicio.data.tokenRegistro;

  const base = { tokenRegistro, tipoDoc: 'CC', numeroDoc: '1234567890', telefono: '3001234567' };

  const claveDebil = await api('/auth/cliente/google/completar', { method: 'POST', body: { ...base, password: 'corta1' } });
  assert.equal(claveDebil.status, 400, JSON.stringify(claveDebil.data));
  assert.match(claveDebil.data.error, /contraseña/i);

  const sinTelefono = await api('/auth/cliente/google/completar', {
    method: 'POST', body: { ...base, telefono: '   ', password: PASSWORD_VALIDA },
  });
  assert.equal(sinTelefono.status, 400, JSON.stringify(sinTelefono.data));

  const docConLetras = await api('/auth/cliente/google/completar', {
    method: 'POST', body: { ...base, numeroDoc: 'ABC123', password: PASSWORD_VALIDA },
  });
  assert.equal(docConLetras.status, 400, JSON.stringify(docConLetras.data));

  const telefonoMalo = await api('/auth/cliente/google/completar', {
    method: 'POST', body: { ...base, telefono: '12', password: PASSWORD_VALIDA },
  });
  assert.equal(telefonoMalo.status, 400, JSON.stringify(telefonoMalo.data));

  // Ninguno de esos intentos fallidos pudo dejar una cuenta a medias.
  assert.equal(await clientePorCorreo(correo), null, 'un intento rechazado no debe crear nada');

  // Con todo correcto, sí entra.
  const ok = await api('/auth/cliente/google/completar', { method: 'POST', body: { ...base, password: PASSWORD_VALIDA } });
  assert.equal(ok.status, 201, JSON.stringify(ok.data));
});

test('El token temporal no sirve dos veces (la cuenta ya existe)', async () => {
  const correo = correoUnico('reuso');
  correosCreados.push(correo);
  const inicio = await api('/auth/cliente/google', { method: 'POST', body: { token: tokenGoogle(correo) } });
  const cuerpo = {
    tokenRegistro: inicio.data.tokenRegistro,
    password: PASSWORD_VALIDA, tipoDoc: 'CC', numeroDoc: '2021222324', telefono: '3002221100',
  };

  const primera = await api('/auth/cliente/google/completar', { method: 'POST', body: cuerpo });
  assert.equal(primera.status, 201, JSON.stringify(primera.data));

  const segunda = await api('/auth/cliente/google/completar', { method: 'POST', body: cuerpo });
  assert.equal(segunda.status, 409, JSON.stringify(segunda.data));
  assert.equal(segunda.data.motivo, 'correo_ya_registrado');
});

test('La recuperación de contraseña sigue funcionando (no se rompió con este cambio)', async () => {
  const correo = correoUnico('recuperacion');
  correosCreados.push(correo);
  const inicio = await api('/auth/cliente/google', { method: 'POST', body: { token: tokenGoogle(correo) } });
  await api('/auth/cliente/google/completar', {
    method: 'POST',
    body: { tokenRegistro: inicio.data.tokenRegistro, password: PASSWORD_VALIDA, tipoDoc: 'CC', numeroDoc: '2526272829', telefono: '3003334455' },
  });

  // Respuesta genérica y 200, exista o no la cuenta (es a propósito: no
  // debe servir para enumerar correos registrados).
  const solicitud = await api('/auth/cliente/recuperar', { method: 'POST', base: BASE_SUITE, body: { correo } });
  assert.equal(solicitud.status, 200, JSON.stringify(solicitud.data));
  assert.ok(solicitud.data.mensaje);

  // Un código inventado se rechaza (la ruta sigue viva y validando).
  const reset = await api('/auth/cliente/reset-password', {
    method: 'POST', base: BASE_SUITE, body: { correo, token: '000000', nuevaPassword: 'OtraClave2026#' },
  });
  assert.equal(reset.status, 400, JSON.stringify(reset.data));
});
