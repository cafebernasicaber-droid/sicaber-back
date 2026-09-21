// ─────────────────────────────────────────────────────────────────────────
//  Sustituto de la verificación de Google, SOLO para pruebas automáticas
// ─────────────────────────────────────────────────────────────────────────
// POR QUÉ EXISTE:
//   POST /auth/cliente/google verifica el ID token CONTRA LOS SERVIDORES DE
//   GOOGLE (google-auth-library → verifyIdToken, que comprueba la firma con
//   las claves públicas de Google). Eso es exactamente lo que debe hacer en
//   producción, y también lo que hace imposible probar el flujo de registro
//   de punta a punta desde una suite automática: no hay forma de fabricar un
//   ID token que Google firme.
//
//   Este archivo reemplaza ÚNICAMENTE esa llamada de red, dejando intacto
//   TODO el resto de la ruta (la lógica de correo nuevo vs. existente, la
//   emisión del token temporal, el estado de la cuenta, las consultas a la
//   base). Así la prueba ejercita el código real del backend, no una copia.
//
// POR QUÉ NO ES UN RIESGO EN PRODUCCIÓN:
//   No se carga nunca solo. Solo entra en juego si alguien arranca Node con
//   `--require scripts/stub-google-pruebas.js` de forma explícita — cosa que
//   hace un único archivo de test, en su propio servidor, en su propio
//   puerto. Ni src/index.js ni npm start ni scripts/run-tests.js lo
//   mencionan: el servidor normal (incluido el de la suite) sigue verificando
//   contra Google de verdad.
//
// FORMATO DEL TOKEN FALSO:
//   "prueba-google:<correo>:<nombre>:<emailVerificado 1|0>"
'use strict';

const { OAuth2Client } = require('google-auth-library');

const PREFIJO = 'prueba-google:';

const verificacionReal = OAuth2Client.prototype.verifyIdToken;

OAuth2Client.prototype.verifyIdToken = async function verifyIdTokenConStub(opciones) {
  const idToken = opciones?.idToken || '';
  // Cualquier token que NO tenga el prefijo de prueba sigue el camino real:
  // así el propio test puede comprobar que un token inválido se rechaza.
  if (typeof idToken !== 'string' || !idToken.startsWith(PREFIJO)) {
    return verificacionReal.call(this, opciones);
  }
  const [, correo, nombre, verificado] = idToken.split(':');
  const payload = {
    email: correo,
    name: nombre || undefined,
    email_verified: verificado !== '0',
    sub: `prueba-${correo}`,
    aud: process.env.GOOGLE_CLIENT_ID,
  };
  return { getPayload: () => payload };
};

console.log('🧪 google-auth-library: verificación sustituida SOLO para pruebas (tokens "prueba-google:...").');
