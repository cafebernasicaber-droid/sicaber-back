const jwt = require('jsonwebtoken');

const auth = (req, res, next) => {
  const header = req.headers['authorization'];
  if (!header) return res.status(401).json({ error: 'Token requerido' });
  const token = header.split(' ')[1];
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Token inválido' });
  }
};

// Variante de `auth` para rutas que sirven TANTO a un cliente/visitante sin
// sesión (ej. el checkout de la landing) COMO a un usuario interno
// autenticado (Cajero/Administrador) — el mismo endpoint necesita saber
// QUIÉN llama, si alguien llama, sin poder exigir un token (ver POST
// /pedidos: requisito de unificar la creación de pedido para Admin y
// Cajero sin dejar de aceptar pedidos de cliente). Si viene un Authorization
// válido, decodifica igual que `auth` (req.user queda disponible); si no
// viene, o el token es inválido/expiró, NO rechaza la petición — sigue
// como pedido público, con req.user sin definir.
const authOpcional = (req, res, next) => {
  const header = req.headers['authorization'];
  if (header) {
    const token = header.split(' ')[1];
    try { req.user = jwt.verify(token, process.env.JWT_SECRET); }
    catch { /* token ausente/ inválido: se sigue como público, no como error */ }
  }
  next();
};

const soloAdmin = (req, res, next) => {
  if (req.user?.rol !== 'Administrador') return res.status(403).json({ error: 'Solo administradores' });
  next();
};

// Generaliza soloAdmin a una lista de roles permitidos (ej. aprobar/
// rechazar comprobantes y confirmar pagos: Cajero + Administrador, sin
// Bartender). Se usa DESPUÉS de auth en la cadena de middlewares, así que
// req.user ya viene decodificado del token.
const permitirRoles = (...roles) => (req, res, next) => {
  if (!roles.includes(req.user?.rol)) {
    return res.status(403).json({ error: `Solo ${roles.join(' o ')} puede realizar esta acción.` });
  }
  next();
};

module.exports = { auth, authOpcional, soloAdmin, permitirRoles };
