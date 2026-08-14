require('dotenv').config();
const express = require('express');
const cors    = require('cors');

const app = express();

// Orígenes fijos de desarrollo local + los dos patrones que cubren
// localhost (cualquier puerto) y los túneles de VS Code Ports/Codespaces
// (dominio "https://<id-aleatorio>-<puerto>.app.github.dev", donde el
// <id-aleatorio> cambia cada vez que se reinicia el túnel).
const CORS_ORIGENES_ESTATICOS = ['http://localhost:3000', 'http://localhost:5000', 'https://sicaber-front.onrender.com'];
const CORS_REGEX_LOCALHOST = /^http:\/\/localhost:\d+$/;
const CORS_REGEX_TUNNEL = /^https:\/\/[a-z0-9-]+\.app\.github\.dev$/;

app.use(cors({
  // Antes `origin` era un array estático: la librería `cors` compara el
  // Origin recibido contra esa lista/esos regex internamente, pero eso
  // pasaba "a ciegas" — no había forma de ver en la terminal cuál era el
  // Origin exacto que mandaba el túnel ni si el regex lo estaba cubriendo.
  // Con una función se ejecuta código propio en cada petición, así que se
  // puede loguear el origin recibido y el resultado antes de decidir.
  origin(origin, callback) {
    // Peticiones sin header Origin (curl/Postman, llamadas server-to-server,
    // o el propio navegador en same-origin) no traen nada que validar — se
    // dejan pasar igual que con el array de antes.
    if (!origin) {
      console.log('🌐 CORS: petición sin header Origin (permitida)');
      return callback(null, true);
    }

    const permitido =
      CORS_ORIGENES_ESTATICOS.includes(origin) ||
      CORS_REGEX_LOCALHOST.test(origin) ||
      CORS_REGEX_TUNNEL.test(origin);

    // 🔍 DEBUG TEMPORAL: imprime cada Origin que llega y si fue aceptado o
    // rechazado, para confirmar en la terminal del backend el dominio EXACTO
    // que manda el túnel y si CORS_REGEX_TUNNEL lo cubre. Bórralo una vez
    // confirmes que el origen correcto está pasando.
    console.log(`🌐 CORS origin recibido: "${origin}" → ${permitido ? 'ACEPTADO ✅' : 'RECHAZADO ❌'}`);

    if (permitido) return callback(null, true);
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