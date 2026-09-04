// ─────────────────────────────────────────────────────────────
//  src/middleware/permisos.js   (ARCHIVO NUEVO)
//
//  Este archivo no existía. Su ausencia es la causa raíz de que
//  `user.permisos` llegue SIEMPRE vacío al frontend (ver el comentario
//  largo en AuthContext.hasPermiso): /auth/login y /auth/me devolvían el
//  usuario sin su lista de permisos, así que el sidebar dinámico,
//  PrivateRoute y HomeRedirect —que ya estaban escritos y correctos— no
//  tenían con qué decidir nada. El único rol que funcionaba era
//  Administrador, y solo gracias al atajo `esAdmin` del frontend.
//
//  Acá se centraliza TODO lo que tiene que ver con leer permisos:
//    · permisosDeRol(nombre)  → array de permisos vigentes de ese rol
//    · clavePermiso(mod, acc) → 'accion_modulo' (misma convención que el
//                               frontend: rolesService.MODULOS_PERMISOS)
//    · requierePermiso(mod, acc) → middleware Express para proteger rutas
//
//  IMPORTANTE sobre requierePermiso: se exporta listo para usar, pero NO
//  se aplica todavía a ningún endpoint. Eso es la "Tarea 1" que quedó en
//  pausa esperando tu OK — aplicarlo módulo por módulo es una decisión
//  aparte, y meterlo de golpe en 40 rutas es la forma más rápida de dejar
//  a alguien encerrado fuera de su propio panel. Lo que sí se activa ya es
//  la LECTURA de permisos (login/me), que es lo que necesita la vista por
//  rol y no puede romper nada: hoy ese campo simplemente no viaja.
// ─────────────────────────────────────────────────────────────
const pool = require('../config/db');

// El Administrador nunca se valida contra la tabla: pasa siempre. Es la
// misma regla que ya aplica el frontend (AuthContext.hasPermiso), y evita
// el peor escenario posible — que el admin se auto-bloquee del panel por
// un permiso mal escrito y ya no pueda entrar a arreglarlo.
const ROL_ADMIN = 'administrador';

const esAdministrador = (rol) => String(rol || '').trim().toLowerCase() === ROL_ADMIN;

// Misma convención de nombres que el frontend (rolesService.js):
//   clavePermiso('usuarios', 'eliminar') → 'eliminar_usuarios'
// Si esto se desincroniza, el rol "tiene" permisos que nadie reconoce.
const clavePermiso = (modulo, accion = 'ver') => `${accion}_${modulo}`;

// roles.permisos es JSONB, así que el driver normalmente ya devuelve un
// array. Pero según de dónde venga la fila (consulta directa, JOIN, o una
// fila vieja guardada como texto) puede llegar como string — el mismo caso
// que RolesPage.jsx y VerRolPage.jsx ya manejan con su getPermisos().
const normalizarPermisos = (valor) => {
  if (Array.isArray(valor)) return valor.filter(p => typeof p === 'string');
  if (typeof valor === 'string') {
    try {
      const parsed = JSON.parse(valor);
      return Array.isArray(parsed) ? parsed.filter(p => typeof p === 'string') : [];
    } catch { return []; }
  }
  return [];
};

// usuarios.rol guarda el NOMBRE del rol como texto plano, no una FK a
// roles.id (ver la nota de contarUsuariosConRol en routes/index.js). Por
// eso la búsqueda es por nombre y case-insensitive: el UNIQUE de Postgres
// sí distingue mayúsculas, así que "Cajero" y "cajero" pueden coexistir.
//
// Se consulta en cada petición a propósito, sin caché: si un admin le
// cambia los permisos a un rol, el cambio debe verse en el siguiente
// /auth/me sin obligar a todos esos usuarios a volver a iniciar sesión.
const permisosDeRol = async (nombreRol) => {
  if (!nombreRol) return [];
  const { rows } = await pool.query(
    'SELECT permisos FROM roles WHERE lower(btrim(nombre)) = lower(btrim($1)) LIMIT 1',
    [nombreRol]
  );
  if (!rows[0]) return []; // rol borrado o renombrado: sin permisos, no "todos"
  return normalizarPermisos(rows[0].permisos);
};

// Middleware. Se usa DESPUÉS de `auth` en la cadena, así que req.user ya
// viene decodificado del JWT:
//     rolRouter.post('/', auth, requierePermiso('roles', 'crear'), handler)
//
// Responde 403 con un mensaje legible — api.js del frontend emite el
// evento 'sicaber:forbidden' en cada 403 y PermisoDeniedToast lo muestra
// tal cual, así que este texto es el que va a leer el usuario.
const requierePermiso = (modulo, accion = 'ver') => async (req, res, next) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'Token requerido' });
    if (esAdministrador(req.user.rol)) return next();

    const permisos = await permisosDeRol(req.user.rol);
    if (permisos.includes(clavePermiso(modulo, accion))) return next();

    return res.status(403).json({
      error: `Tu rol (${req.user.rol}) no tiene permiso para ${accion} en ${modulo}.`,
    });
  } catch (e) {
    // Ante un fallo de base de datos NO se deja pasar: un error leyendo
    // permisos no puede convertirse en "permiso concedido".
    return res.status(500).json({ error: e.message });
  }
};

module.exports = { permisosDeRol, clavePermiso, requierePermiso, esAdministrador, normalizarPermisos };
