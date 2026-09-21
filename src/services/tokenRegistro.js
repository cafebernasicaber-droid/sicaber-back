// ─────────────────────────────────────────────────────────────────────────
//  Token TEMPORAL para completar un registro iniciado con Google
// ─────────────────────────────────────────────────────────────────────────
// QUÉ ESTABA MAL ANTES (problema real, no teórico):
//
//   POST /auth/cliente/google, cuando el correo NO existía, creaba el
//   cliente EN ESE MISMO INSTANTE con una contraseña aleatoria que nadie
//   conoce y sin teléfono ni documento. Consecuencias reales:
//     • Si el usuario abandonaba ahí, quedaba una cuenta incompleta en la
//       base (sin teléfono, sin documento, con una contraseña imposible).
//     • Esa cuenta bloqueaba el registro normal por correo duplicado, y su
//       dueño no podía iniciar sesión con contraseña (no la tiene) —
//       solo podía volver a entrar con Google.
//     • "Recuperar contraseña" era el único camino para desbloquearla.
//
//   La corrección es no tocar la base hasta que el registro esté COMPLETO.
//   Mientras tanto, la identidad que Google ya verificó (correo + nombre)
//   viaja en un token temporal FIRMADO por el servidor, así el paso de
//   "completar registro" no tiene que volver a confiar en lo que mande el
//   navegador: el correo sale del token, no del body.
//
// POR QUÉ UN JWT Y NO UNA FILA EN LA BASE:
//   Es exactamente el caso para el que sirve un token firmado y de vida
//   corta: dato pequeño, de un solo paso, que NO debe dejar rastro si el
//   usuario abandona. Guardarlo en `tokens_verificacion` (la tabla de los
//   códigos de 6 dígitos) obligaría a crear filas huérfanas que después
//   habría que limpiar — justo la basura que este flujo viene a evitar. Y
//   no reutiliza el JWT de sesión: este token tiene PROPÓSITO propio y no
//   sirve para autenticarse (ver más abajo).
//
// POR QUÉ EL "PROPÓSITO" ES OBLIGATORIO:
//   Sin él, un token emitido acá sería un JWT válido firmado con el mismo
//   JWT_SECRET que las sesiones, y podría presentarse en el header
//   Authorization de cualquier ruta protegida. El middleware `auth` solo
//   verifica la firma. Marcarlo con `proposito` y exigirlo al validarlo
//   hace que este token SOLO sirva para completar el registro: no trae
//   `id` ni `rol`, así que tampoco pasaría el chequeo de cuenta activa de
//   `auth` — pero la marca lo deja explícito y verificable, en vez de
//   depender de ese efecto colateral.

const jwt = require('jsonwebtoken');

// Marca que identifica para qué sirve (y para qué NO sirve) este token.
const PROPOSITO_REGISTRO_GOOGLE = 'registro_google';

// 20 minutos: de sobra para llenar un formulario de 4 campos, y lo
// bastante corto para que un token filtrado no sirva mañana. Configurable
// por entorno sin tocar el código.
const MINUTOS_VIGENCIA = Number(process.env.REGISTRO_GOOGLE_TOKEN_MINUTOS || 20);

/**
 * Emite el token temporal con la identidad que Google ya verificó.
 * @param {{correo: string, nombre: string}} datos
 * @returns {{token: string, expiraEnMinutos: number, expiraEn: string}}
 */
const emitirTokenRegistroGoogle = ({ correo, nombre }) => {
  const token = jwt.sign(
    {
      proposito: PROPOSITO_REGISTRO_GOOGLE,
      correo: String(correo || '').toLowerCase(),
      nombre: String(nombre || ''),
      // Origen explícito: deja registrado que esta identidad la confirmó
      // Google (y no un código enviado por correo), por si mañana hace
      // falta distinguirlo.
      proveedor: 'google',
    },
    process.env.JWT_SECRET,
    { expiresIn: `${MINUTOS_VIGENCIA}m` }
  );
  return {
    token,
    expiraEnMinutos: MINUTOS_VIGENCIA,
    expiraEn: new Date(Date.now() + MINUTOS_VIGENCIA * 60_000).toISOString(),
  };
};

/**
 * Valida el token temporal. Nunca lanza: devuelve un motivo diferenciado
 * para que la ruta pueda dar un mensaje útil (y el frontend sepa si toca
 * volver a pasar por Google o solo corregir el formulario).
 *
 * Motivos: 'faltante' | 'invalido' | 'expirado' | 'proposito_incorrecto'
 * | 'sin_correo'
 *
 * @returns {{ok: true, correo: string, nombre: string} | {ok: false, motivo: string}}
 */
const validarTokenRegistroGoogle = (token) => {
  if (!token || typeof token !== 'string' || !token.trim()) {
    return { ok: false, motivo: 'faltante' };
  }
  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET);
  } catch (e) {
    // jsonwebtoken distingue el vencimiento del resto de fallos de firma —
    // se traslada esa diferencia, porque para el usuario no es lo mismo
    // "se te venció el formulario" que "ese token no es válido".
    return { ok: false, motivo: e.name === 'TokenExpiredError' ? 'expirado' : 'invalido' };
  }
  // El propósito se revisa SIEMPRE: un token de sesión (que también está
  // firmado con JWT_SECRET y también verifica) no puede servir para crear
  // una cuenta con el correo que se le antoje a quien lo presente.
  if (payload?.proposito !== PROPOSITO_REGISTRO_GOOGLE) {
    return { ok: false, motivo: 'proposito_incorrecto' };
  }
  const correo = String(payload.correo || '').trim().toLowerCase();
  if (!correo) return { ok: false, motivo: 'sin_correo' };
  return { ok: true, correo, nombre: String(payload.nombre || '').trim() };
};

// Mensaje de cara al usuario para cada motivo. Se centraliza acá para que
// la ruta no arme texto a mano (mismo criterio que
// codigos.mensajeMotivo en services/codigosVerificacion.js).
const mensajeMotivoTokenRegistro = (motivo) => {
  switch (motivo) {
    case 'faltante':
      return 'Falta el token del registro. Vuelve a iniciar el registro con Google.';
    case 'expirado':
      return 'El tiempo para completar tu registro se agotó. Vuelve a entrar con Google para empezar de nuevo.';
    case 'proposito_incorrecto':
      return 'Ese token no sirve para completar un registro. Vuelve a iniciar el registro con Google.';
    default:
      return 'El token del registro no es válido. Vuelve a iniciar el registro con Google.';
  }
};

module.exports = {
  PROPOSITO_REGISTRO_GOOGLE,
  MINUTOS_VIGENCIA,
  emitirTokenRegistroGoogle,
  validarTokenRegistroGoogle,
  mensajeMotivoTokenRegistro,
};
