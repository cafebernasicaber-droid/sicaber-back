const jwt = require('jsonwebtoken');
const pool = require('../config/db');

// Re-verifica que la cuenta del token SIGA activa, consultando la tabla
// real (usuarios o clientes según el rol del payload) en CADA petición.
// Causa raíz que esto corrige: un JWT ya emitido (vigente hasta 8h) seguía
// sirviendo aunque la cuenta se desactivara DESPUÉS de emitirlo — ni el
// login, ni este middleware, revisaban `estado` nunca; "desactivar" un
// usuario/cliente (a mano, o en cascada al desactivar su rol — ver PATCH
// /roles/:id/estado) no le cortaba el acceso de verdad hasta que el
// token expirara solo. Devuelve null si la cuenta sigue activa (nada que
// bloquear), o el mensaje de error si ya no lo está / no existe más.
const cuentaDesactivada = async (payload) => {
  const tabla = payload?.rol === 'Cliente' ? 'clientes' : 'usuarios';
  const { rows } = await pool.query(`SELECT estado FROM ${tabla} WHERE id=$1`, [payload.id]);
  if (!rows[0] || rows[0].estado !== 'Activo') {
    return 'Tu cuenta está desactivada. Contacta a un administrador.';
  }
  return null;
};

const auth = async (req, res, next) => {
  const header = req.headers['authorization'];
  if (!header) return res.status(401).json({ error: 'Token requerido' });
  const token = header.split(' ')[1];
  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'Token inválido' });
  }
  try {
    const errorCuenta = await cuentaDesactivada(payload);
    if (errorCuenta) return res.status(403).json({ error: errorCuenta });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
  req.user = payload;
  next();
};

// Variante de `auth` para rutas que sirven TANTO a un cliente/visitante sin
// sesión (ej. el checkout de la landing) COMO a un usuario interno
// autenticado (Cajero/Administrador) — el mismo endpoint necesita saber
// QUIÉN llama, si alguien llama, sin poder exigir un token (ver POST
// /pedidos: requisito de unificar la creación de pedido para Admin y
// Cajero sin dejar de aceptar pedidos de cliente). Si viene un Authorization
// válido, decodifica igual que `auth` (req.user queda disponible); si no
// viene, el token es inválido/expiró, O la cuenta ya está desactivada, NO
// rechaza la petición — sigue como pedido público, con req.user sin
// definir (mismo criterio que ya aplicaba a un token roto: degradar a
// anónimo, nunca bloquear, porque esta ruta nunca bloquea).
const authOpcional = async (req, res, next) => {
  const header = req.headers['authorization'];
  if (header) {
    const token = header.split(' ')[1];
    try {
      const payload = jwt.verify(token, process.env.JWT_SECRET);
      const errorCuenta = await cuentaDesactivada(payload).catch(() => null);
      if (!errorCuenta) req.user = payload;
    } catch { /* token ausente/inválido: se sigue como público, no como error */ }
  }
  next();
};

// Mismo criterio de normalización que ya usaba esAdministrador() en
// middleware/permisos.js (trim + minúsculas) — CAUSA RAÍZ del bug real
// reportado en /locales (y potencialmente cualquier otra ruta detrás de
// permitirRoles): la comparación de abajo era un `.includes()` exacto,
// sensible a mayúsculas y sin recortar espacios. Un usuario cuyo
// `usuarios.rol` quedó guardado como "administrador", " Administrador"
// (espacio colado) o cualquier variante de capitalización — algo que esta
// misma API nunca impidió al crear/editar un usuario, "rol" es un
// VARCHAR libre, no un enum — es un Administrador real para cualquier
// persona que lo mire, pero `permitirRoles('Administrador')` lo rechazaba
// con "Solo Administrador puede realizar esta acción" porque la cadena no
// coincidía carácter por carácter. permisos.js ya resolvía exactamente
// este mismo problema para OTRO propósito (esAdministrador); acá faltaba
// el mismo tratamiento.
const normalizarRol = (rol) => String(rol || '').trim().toLowerCase();

const soloAdmin = (req, res, next) => {
  if (normalizarRol(req.user?.rol) !== 'administrador') return res.status(403).json({ error: 'Solo administradores' });
  next();
};

// Generaliza soloAdmin a una lista de roles permitidos (ej. aprobar/
// rechazar comprobantes y confirmar pagos: Cajero + Administrador, sin
// Bartender). Se usa DESPUÉS de auth en la cadena de middlewares, así que
// req.user ya viene decodificado del token.
const permitirRoles = (...roles) => {
  const rolesNormalizados = roles.map(normalizarRol);
  return (req, res, next) => {
    if (!rolesNormalizados.includes(normalizarRol(req.user?.rol))) {
      return res.status(403).json({ error: `Solo ${roles.join(' o ')} puede realizar esta acción.` });
    }
    next();
  };
};

module.exports = { auth, authOpcional, soloAdmin, permitirRoles };
