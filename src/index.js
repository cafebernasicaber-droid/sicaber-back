require('dotenv').config();
const express = require('express');
const cors    = require('cors');

const app = express();

// Orígenes fijos de desarrollo local y de los frontends desplegados, más
// los patrones que cubren localhost (cualquier puerto), los túneles de VS
// Code Ports/Codespaces (dominio "https://<id>-<puerto>.app.github.dev",
// donde el <id> cambia al reiniciar el túnel) y los dominios de Vercel.
const CORS_ORIGENES_ESTATICOS = [
  'http://localhost:3000',
  'http://localhost:5000',
  'https://sicaber-front.onrender.com',
];

// Orígenes adicionales definidos por entorno, separados por comas. Permite
// autorizar un dominio nuevo desde el panel de Render sin volver a
// desplegar el código. Ejemplo:
//   CORS_ORIGENES_EXTRA=https://sicaber.vercel.app,https://midominio.com
const CORS_ORIGENES_EXTRA = (process.env.CORS_ORIGENES_EXTRA || '')
  .split(',')
  .map(o => o.trim())
  .filter(Boolean);

const CORS_REGEX_LOCALHOST = /^http:\/\/localhost:\d+$/;
const CORS_REGEX_TUNNEL = /^https:\/\/[a-z0-9-]+\.app\.github\.dev$/;
// Vercel genera un dominio distinto por cada despliegue de vista previa
// (por rama, por pull request), no solo el de producción. Sin este patrón
// solo funcionaría la URL principal y cualquier preview quedaría bloqueada.
const CORS_REGEX_VERCEL = /^https:\/\/[a-z0-9-]+\.vercel\.app$/;

app.use(cors({
  // `origin` es una función y no un array para poder registrar los
  // rechazos: con el array, la librería `cors` decide internamente y no
  // queda rastro de qué dominio fue bloqueado ni por qué.
  origin(origin, callback) {
    // Peticiones sin header Origin (curl/Postman, llamadas server-to-server,
    // o el propio navegador en same-origin) no traen nada que validar.
    if (!origin) return callback(null, true);

    const permitido =
      CORS_ORIGENES_ESTATICOS.includes(origin) ||
      CORS_ORIGENES_EXTRA.includes(origin) ||
      CORS_REGEX_LOCALHOST.test(origin) ||
      CORS_REGEX_TUNNEL.test(origin) ||
      CORS_REGEX_VERCEL.test(origin);

    // Solo se registran los RECHAZOS: el log de cada petición aceptada
    // llenaba los registros de Render con decenas de líneas idénticas sin
    // aportar nada. Un rechazo sí hay que poder verlo para diagnosticar.
    if (permitido) return callback(null, true);
    console.warn(`CORS: origen rechazado → "${origin}"`);
    return callback(new Error(`Origen no permitido por CORS: ${origin}`));
  },
  credentials: true
}));
// Límite por defecto de express.json() es 100kb — muy poco para un pedido
// que incluye el comprobante de pago como imagen en base64 (puede pesar
// varios MB una vez codificada). Sin este límite más alto, cualquier
// pedido con comprobante adjunto era rechazado por body-parser ANTES de
// llegar a la ruta, y el manejador global de errores lo convertía en un
// 500 genérico — parecía un bug de base de datos, pero el request nunca
// llegaba a ejecutarse.
app.use(express.json({ limit: '15mb' }));

// Rutas
app.use('/api/auth', require('./routes/auth'));
app.use('/api',      require('./routes/index'));

// Health check
app.get('/api/health', (_, res) => res.json({ ok: true, message: 'SICABER API corriendo ✅' }));

// Manejador global de errores: cualquier excepción que llegue hasta aquí
// responde con el código de estado real del error si lo trae (ej. 413 de
// "payload too large", 400 de JSON mal formado) en vez de forzar siempre
// 500 — antes esto disfrazaba errores claros (como el límite de tamaño de
// body) como si fueran fallas internas del servidor/base de datos.
app.use((err, req, res, next) => {
  const status = err.status || err.statusCode || 500;
  console.error('💥 Error no manejado en', req.method, req.originalUrl, '→', status, err.message);
  if (res.headersSent) return next(err);
  res.status(status).json({ error: err.message || 'Error interno del servidor' });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`🚀 API corriendo en http://localhost:${PORT}`));

// Red de seguridad: si una ruta sin try/catch lanza un error async no
// capturado, esto evita que Node mate el proceso completo (lo cual tumbaba
// la API entera y hacía fallar incluso rutas que no tenían nada que ver).
process.on('unhandledRejection', (reason) => {
  console.error('⚠️  Promesa rechazada sin manejar:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('⚠️  Excepción no capturada:', err);
});