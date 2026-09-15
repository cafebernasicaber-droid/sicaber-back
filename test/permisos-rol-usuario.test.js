// ─────────────────────────────────────────────────────────────────────────
//  Verificación (no implementación): crear un rol con permisos puntuales
//  y asignarlo a un usuario nuevo alcanza para que GET /auth/me devuelva
//  exactamente esos permisos, sin ningún paso manual adicional.
// ─────────────────────────────────────────────────────────────────────────
// El sistema (permisosDeRol / requierePermiso, src/middleware/permisos.js)
// ya estaba construido — este test solo lo confirma con datos reales:
//   • roles.permisos (JSONB) se lee por NOMBRE de rol, sin caché — así que
//     un cambio al rol se ve en el siguiente GET /auth/me sin re-login.
//   • usuarios.rol guarda el nombre del rol como texto — POST /usuarios
//     acepta "rolId" (o "rol") y lo resuelve a ese nombre real.
//
// Ejecutar: npm test
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const BASE = process.env.TEST_BASE_URL || 'http://localhost:4000/api';
const ADMIN_USER = process.env.TEST_ADMIN_USER || 'Admin_Sicaber';
const ADMIN_PASS = process.env.TEST_ADMIN_PASS || 'admin2024#';

let tokenAdmin;
let rolId, usuarioId;
const sufijo = Date.now();
const USERNAME = `usr_prueba_perm_${sufijo}`;
const PASSWORD = 'Clave123456#';

const api = async (path, { method = 'GET', token, body } = {}) => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
};

before(async () => {
  const login = await api('/auth/login', { method: 'POST', body: { username: ADMIN_USER, password: ADMIN_PASS } });
  assert.equal(login.status, 200, JSON.stringify(login.data));
  tokenAdmin = login.data.token;
});

after(async () => {
  if (usuarioId) { try { await api(`/usuarios/${usuarioId}`, { method: 'DELETE', token: tokenAdmin }); } catch {} }
  if (rolId) { try { await api(`/roles/${rolId}`, { method: 'DELETE', token: tokenAdmin }); } catch {} }
});

test('rol con permisos puntuales + usuario asignado: GET /auth/me devuelve exactamente esos permisos', async () => {
  const permisosOriginales = ['ver_insumos', 'crear_compras', 'ver_ventas'];

  const rol = await api('/roles', {
    method: 'POST', token: tokenAdmin,
    body: { nombre: `RolPruebaPermisos${sufijo}`, descripcion: 'Rol de prueba', permisos: permisosOriginales, color: '#123456' },
  });
  assert.equal(rol.status, 201, JSON.stringify(rol.data));
  rolId = rol.data.id;
  assert.deepEqual(rol.data.permisos, permisosOriginales);

  const usuario = await api('/usuarios', {
    method: 'POST', token: tokenAdmin,
    body: { nombre: 'Usuario Prueba Permisos', username: USERNAME, password: PASSWORD, rolId, sede: 'Local 1' },
  });
  assert.equal(usuario.status, 201, JSON.stringify(usuario.data));
  usuarioId = usuario.data.id;
  assert.equal(usuario.data.rol, `RolPruebaPermisos${sufijo}`, 'el usuario queda con el NOMBRE del rol asignado');

  const login = await api('/auth/login', { method: 'POST', body: { username: USERNAME, password: PASSWORD } });
  assert.equal(login.status, 200, JSON.stringify(login.data));
  // El propio login YA trae los permisos correctos (sin pasos extra).
  assert.deepEqual(login.data.usuario.permisos, permisosOriginales);
  const tokenUsuario = login.data.token;

  const me = await api('/auth/me', { token: tokenUsuario });
  assert.equal(me.status, 200, JSON.stringify(me.data));
  assert.deepEqual(me.data.permisos, permisosOriginales, 'GET /auth/me debe traer EXACTAMENTE los permisos del rol asignado, ni más ni menos');

  // Cambiar los permisos del rol después del login: el MISMO token, sin
  // volver a loguear, debe reflejar el cambio en el siguiente /auth/me —
  // permisosDeRol() no usa caché.
  const permisosActualizados = ['ver_insumos', 'ver_ventas', 'editar_productos'];
  const rolActualizado = await api(`/roles/${rolId}`, {
    method: 'PUT', token: tokenAdmin,
    body: { nombre: `RolPruebaPermisos${sufijo}`, descripcion: 'Rol de prueba', permisos: permisosActualizados, color: '#123456' },
  });
  assert.equal(rolActualizado.status, 200, JSON.stringify(rolActualizado.data));

  const meActualizado = await api('/auth/me', { token: tokenUsuario });
  assert.equal(meActualizado.status, 200, JSON.stringify(meActualizado.data));
  assert.deepEqual(meActualizado.data.permisos, permisosActualizados, 'el cambio de permisos del rol se refleja de inmediato, sin re-login');
});
