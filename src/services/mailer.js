// ─────────────────────────────────────────────────────────────────────────
//  Envío de correo (códigos de verificación de 6 dígitos)
// ─────────────────────────────────────────────────────────────────────────
// CAUSA RAÍZ del bug de "el registro se queda cargando para siempre en
// producción" (funcionaba local, fallaba desplegado):
//
//   1. `nodemailer.createTransport({ service: 'gmail' })` resuelve a
//      smtp.gmail.com:465 y NO define ningún timeout. Los timeouts por
//      defecto de nodemailer son los del socket del sistema operativo: si
//      el proveedor de hosting DESCARTA en silencio el paquete (que es lo
//      que hacen Render, Railway, Fly y casi todo PaaS con los puertos SMTP
//      salientes 25/465/587 — no responden "conexión rechazada", se lo
//      tragan), el socket queda esperando MINUTOS. Local funciona porque el
//      puerto 465 sale sin problema desde una casa/oficina.
//      → `await enviarTokenRegistro(...)` nunca resolvía → la petición HTTP
//        nunca respondía → el spinner del frontend giraba indefinidamente.
//
//   2. Cuando por fin fallaba, el error crudo de SMTP se devolvía tal cual
//      al cliente (`res.status(500).json({ error: e.message })`), lo que
//      además de ser inútil para el usuario ("Invalid login: 535-5.7.8
//      Username and Password not accepted") filtra detalles del servidor
//      de correo.
//
// Correcciones de este archivo:
//   • Timeouts EXPLÍCITOS en el transporte (conexión, saludo y socket) y,
//     encima, un timeout duro propio con Promise.race — así NINGÚN envío
//     puede tardar más de MAIL_TIMEOUT_MS, pase lo que pase por debajo.
//   • Host/puerto configurables por entorno y, si no se configuran a mano,
//     REINTENTO AUTOMÁTICO en el puerto alterno (465 ⇄ 587): en muchos
//     hostings uno de los dos está bloqueado y el otro no, y esto lo
//     resuelve solo sin tener que adivinar cuál.
//   • Las funciones de envío NO LANZAN: devuelven { ok, codigo, detalle }
//     con un código de error CLASIFICADO, para que la ruta decida qué
//     responderle al usuario en su idioma y sin filtrar nada del SMTP.
const nodemailer = require('nodemailer');

// Timeout duro de todo el envío. Por debajo de este número están los
// timeouts del propio transporte (ver crearTransporte); este es la red de
// seguridad final que garantiza que la promesa SIEMPRE se resuelve.
const MAIL_TIMEOUT_MS = Number(process.env.MAIL_TIMEOUT_MS || 12000);

// Puertos SMTP estándar. 465 = TLS implícito ("secure"), 587 = STARTTLS.
const PUERTO_TLS = 465;
const PUERTO_STARTTLS = 587;

const MAIL_HOST = process.env.MAIL_HOST || 'smtp.gmail.com';
// Si el despliegue fija MAIL_PORT a mano, se respeta y NO se prueba el
// alterno (quien lo configuró sabe cuál está abierto). Si no viene, se
// empieza por 465 y, ante un fallo de CONEXIÓN (no de credenciales), se
// reintenta en 587.
const MAIL_PORT_CONFIGURADO = process.env.MAIL_PORT ? Number(process.env.MAIL_PORT) : null;

// Errores que significan "no pude ni llegar al servidor SMTP" — son los
// únicos que justifican reintentar en el otro puerto. Un fallo de
// credenciales (EAUTH) daría exactamente el mismo error en cualquier
// puerto, así que reintentar solo gastaría otros 12 segundos del usuario.
const ERRORES_DE_CONEXION = new Set([
  'ETIMEDOUT', 'ESOCKET', 'ECONNECTION', 'ECONNREFUSED', 'ECONNRESET',
  'EHOSTUNREACH', 'ENETUNREACH', 'EDNS', 'ENOTFOUND', 'EAGAIN',
]);

const crearTransporte = (puerto) => nodemailer.createTransport({
  host: MAIL_HOST,
  port: puerto,
  secure: puerto === PUERTO_TLS, // 465 → TLS directo; 587 → STARTTLS
  auth: {
    user: process.env.MAIL_USER,
    pass: process.env.MAIL_PASS,
  },
  // Los tres timeouts que nodemailer deja abiertos por defecto y que son
  // LA causa del "cargando infinito" en producción:
  connectionTimeout: Number(process.env.MAIL_CONNECTION_TIMEOUT_MS || 8000),
  greetingTimeout:   Number(process.env.MAIL_GREETING_TIMEOUT_MS   || 8000),
  socketTimeout:     Number(process.env.MAIL_SOCKET_TIMEOUT_MS     || 10000),
  // Sin pool: son correos sueltos y esporádicos (un código de verificación
  // cada tanto). Un pool mantendría conexiones abiertas que el hosting
  // corta por inactividad, reintroduciendo cuelgues difíciles de depurar.
  pool: false,
});

// Los transportes se crean una sola vez por puerto y se reutilizan.
const transportes = new Map();
const transportePara = (puerto) => {
  if (!transportes.has(puerto)) transportes.set(puerto, crearTransporte(puerto));
  return transportes.get(puerto);
};

// Traduce cualquier fallo de nodemailer a un código propio, estable y
// seguro de mostrar. NUNCA se devuelve el mensaje crudo al cliente: se
// registra en el log del servidor (para quien opera) y al usuario le llega
// una frase entendible (la arma la ruta a partir de este código).
const clasificarError = (e) => {
  const code = e?.code || e?.responseCode || '';
  if (code === 'MAIL_TIMEOUT') return 'correo_timeout';
  if (code === 'EAUTH' || e?.responseCode === 535) return 'correo_credenciales';
  if (ERRORES_DE_CONEXION.has(code)) return 'correo_sin_conexion';
  if (e?.responseCode >= 500) return 'correo_rechazado';
  return 'correo_error';
};

// Timeout duro: si el transporte no resolvió en MAIL_TIMEOUT_MS, se corta
// la espera. El socket subyacente puede seguir vivo un rato más, pero a
// quien está esperando la respuesta HTTP ya no lo afecta.
const conTimeout = (promesa, ms) => new Promise((resolve, reject) => {
  const t = setTimeout(() => {
    const err = new Error(`El envío de correo superó ${ms} ms`);
    err.code = 'MAIL_TIMEOUT';
    reject(err);
  }, ms);
  promesa.then(
    (v) => { clearTimeout(t); resolve(v); },
    (e) => { clearTimeout(t); reject(e); }
  );
});

// Envío real, con reintento en el puerto alterno cuando el primero no
// logró ni conectarse. Devuelve SIEMPRE un objeto — nunca lanza.
const enviar = async (mensaje) => {
  if (!process.env.MAIL_USER || !process.env.MAIL_PASS) {
    // Caso muy común al desplegar: las variables quedaron solo en el .env
    // local y nadie las cargó en el panel del hosting. Antes esto reventaba
    // con un error de autenticación confuso; ahora se detecta antes de
    // abrir un socket y se dice exactamente qué falta.
    console.error('✉️  No se puede enviar correo: faltan MAIL_USER / MAIL_PASS en el entorno.');
    return { ok: false, codigo: 'correo_no_configurado' };
  }

  const puertos = MAIL_PORT_CONFIGURADO
    ? [MAIL_PORT_CONFIGURADO]
    : [PUERTO_TLS, PUERTO_STARTTLS];

  let ultimoCodigo = 'correo_error';
  for (let i = 0; i < puertos.length; i++) {
    const puerto = puertos[i];
    try {
      const info = await conTimeout(transportePara(puerto).sendMail(mensaje), MAIL_TIMEOUT_MS);
      return { ok: true, puerto, messageId: info?.messageId || null };
    } catch (e) {
      ultimoCodigo = clasificarError(e);
      console.error(`✉️  Falló el envío por ${MAIL_HOST}:${puerto} → ${ultimoCodigo} (${e?.code || e?.message})`);
      const puedeReintentar =
        i < puertos.length - 1 &&
        (ultimoCodigo === 'correo_sin_conexion' || ultimoCodigo === 'correo_timeout');
      if (!puedeReintentar) break;
      console.warn(`✉️  Reintentando por el puerto ${puertos[i + 1]} (el ${puerto} parece bloqueado en este servidor).`);
    }
  }
  return { ok: false, codigo: ultimoCodigo };
};

// ── Plantillas ───────────────────────────────────────────────────────────
const wrapEmail = (contenido) => `
  <div style="background:#F3EFE9;padding:40px 16px;font-family:'Segoe UI',Arial,sans-serif">
    <div style="max-width:480px;margin:auto;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(92,61,46,0.12)">
      <div style="background:linear-gradient(135deg,#5C3D2E,#8B5E3C);padding:28px 32px;text-align:center">
        <span style="font-size:26px;letter-spacing:1px;color:#fff;font-weight:700">☕ SICABER</span>
      </div>
      <div style="padding:36px 32px">
        ${contenido}
      </div>
      <div style="background:#FAF7F3;padding:18px 32px;text-align:center;border-top:1px solid #EFE7DD">
        <p style="margin:0;color:#B0A392;font-size:11.5px">Este es un correo automático, por favor no lo respondas.</p>
      </div>
    </div>
  </div>
`;

// El texto de expiración se arma con los minutos REALES del código (ver
// services/codigosVerificacion.js) en vez de estar escrito a mano: antes
// decía "15 minutos" fijo y habría mentido apenas alguien cambiara la
// vigencia en la base de datos.
const tokenBlock = (token, minutos) => `
  <div style="text-align:center;margin:28px 0 8px">
    <table role="presentation" align="center" style="border-collapse:separate;margin:auto">
      <tr>
        ${String(token).split('').map(d => `
          <td style="padding:0 4px">
            <div style="width:42px;height:52px;background:#FFF8F0;border:2px solid #D4A96A;border-radius:10px;font-size:26px;font-weight:800;color:#5C3D2E;font-family:'Courier New',monospace;line-height:52px;text-align:center">
              ${d}
            </div>
          </td>
        `).join('')}
      </tr>
    </table>
  </div>
  <p style="text-align:center;color:#B08A5A;font-size:11.5px;font-weight:600;letter-spacing:.5px;margin:12px 0 0">EXPIRA EN ${minutos} MINUTOS</p>
`;

const remitente = () => `"SICABER ☕" <${process.env.MAIL_USER}>`;

const enviarTokenRegistro = (correo, nombre, token, minutos = 15) => enviar({
  from: remitente(),
  to: correo,
  subject: '✅ Confirma tu registro en SICABER',
  // Alternativa en texto plano: algunos clientes de correo (y varios
  // filtros antispam) penalizan los mensajes que solo traen HTML.
  text: `Hola ${nombre}. Tu código de confirmación de SICABER es ${token}. Expira en ${minutos} minutos.`,
  html: wrapEmail(`
    <h2 style="color:#5C3D2E;margin:0 0 6px;font-size:21px">¡Hola, ${nombre}! 👋</h2>
    <p style="color:#6B5A4E;font-size:14.5px;line-height:1.5;margin:0 0 4px">
      Gracias por registrarte en <strong>SICABER</strong>. Usa este código para confirmar tu cuenta:
    </p>
    ${tokenBlock(token, minutos)}
    <p style="color:#A69A8C;font-size:12.5px;margin:28px 0 0;line-height:1.5">
      Si no te registraste en SICABER, puedes ignorar este correo con tranquilidad.
    </p>
  `),
});

const enviarTokenRecuperacion = (correo, nombre, token, minutos = 15) => enviar({
  from: remitente(),
  to: correo,
  subject: '🔐 Recupera tu contraseña en SICABER',
  text: `Hola ${nombre}. Tu código para restablecer la contraseña de SICABER es ${token}. Expira en ${minutos} minutos.`,
  html: wrapEmail(`
    <h2 style="color:#5C3D2E;margin:0 0 6px;font-size:21px">Recuperar contraseña 🔐</h2>
    <p style="color:#6B5A4E;font-size:14.5px;line-height:1.5;margin:0 0 4px">
      Hola <strong>${nombre}</strong>, recibimos una solicitud para restablecer tu contraseña. Usa este código:
    </p>
    ${tokenBlock(token, minutos)}
    <p style="color:#A69A8C;font-size:12.5px;margin:28px 0 0;line-height:1.5">
      Si tú no solicitaste este cambio, ignora este correo; tu contraseña seguirá siendo la misma.
    </p>
  `),
});

// Diagnóstico para PRODUCCIÓN: verifica la conexión y el login contra el
// servidor SMTP sin mandarle un correo a nadie. Lo expone
// GET /api/health/correo (solo Administrador) — así, cuando "no llega el
// código", se puede saber en 2 segundos si el problema es el puerto
// bloqueado, la contraseña de aplicación vencida o las variables sin
// cargar, en vez de adivinar leyendo logs.
const diagnosticarCorreo = async () => {
  if (!process.env.MAIL_USER || !process.env.MAIL_PASS) {
    return { ok: false, codigo: 'correo_no_configurado', host: MAIL_HOST, puertoUsado: null };
  }
  const puertos = MAIL_PORT_CONFIGURADO ? [MAIL_PORT_CONFIGURADO] : [PUERTO_TLS, PUERTO_STARTTLS];
  let ultimoCodigo = 'correo_error';
  for (const puerto of puertos) {
    try {
      await conTimeout(transportePara(puerto).verify(), MAIL_TIMEOUT_MS);
      return { ok: true, codigo: null, host: MAIL_HOST, puertoUsado: puerto };
    } catch (e) {
      ultimoCodigo = clasificarError(e);
      if (ultimoCodigo === 'correo_credenciales') break; // reintentar no cambia nada
    }
  }
  return { ok: false, codigo: ultimoCodigo, host: MAIL_HOST, puertoUsado: null };
};

// Mensajes de cara al usuario para cada código de error. Deliberadamente
// NO mencionan SMTP, puertos ni credenciales: eso va al log del servidor.
const MENSAJE_ERROR_CORREO = {
  correo_no_configurado: 'El servicio de correo no está configurado en el servidor. Avisa al administrador.',
  correo_credenciales:   'El servicio de correo rechazó las credenciales del servidor. Avisa al administrador.',
  correo_sin_conexion:   'No pudimos conectarnos al servicio de correo en este momento. Intenta de nuevo en unos minutos.',
  correo_timeout:        'El servicio de correo está tardando demasiado. Intenta de nuevo en unos minutos.',
  correo_rechazado:      'El servicio de correo rechazó el envío. Verifica que la dirección sea correcta.',
  correo_error:          'No pudimos enviar el correo en este momento. Intenta de nuevo en unos minutos.',
};
const mensajeErrorCorreo = (codigo) => MENSAJE_ERROR_CORREO[codigo] || MENSAJE_ERROR_CORREO.correo_error;

module.exports = {
  enviarTokenRegistro,
  enviarTokenRecuperacion,
  diagnosticarCorreo,
  mensajeErrorCorreo,
};
