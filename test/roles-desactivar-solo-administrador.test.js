// ─────────────────────────────────────────────────────────────────────────
//  Confirma que "Administrador" es la ÚNICA excepción en
//  PATCH /roles/:id/estado — Cliente, Cajero, Bartender (y cualquier rol
//  personalizado) se desactivan con normalidad, con su cascada de
//  siempre. Lee el código fuente: la única comparación es
//  `rol.nombre.trim().toLowerCase() === 'administrador'` — nada más se
//  compara ahí, así que este test es la confirmación EJECUTADA de eso,
//  usando los nombres reales del sistema.
// ─────────────────────────────────────────────────────────────────────────
// Corre contra la base DEDICADA de test (sicaber_test, se recrea en cada
// `npm test`) — nunca contra la base real: desactivar "Cajero" en la base
// real cascadearía sobre cualquier cajero real ya asignado, y reactivar
// el rol después NO los reactiva (a propósito). Acá es seguro porque la
// base se descarta al terminar.
//
// Ejecutar: npm test
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const BASE = process.env.TEST_BASE_URL || 'http://localhost:4000/api';
const ADMIN_USER = process.env.TEST_ADMIN_USER || 'Admin_Sicaber';
const ADMIN_PASS = process.env.TEST_ADMIN_PASS || 'admin2024#';

let tokenAdmin;
// Rastro de qué se creó en este test, para no tocar una fila real si por
// algún motivo ya existiera (mismo patrón que roles-desactivar-cascada).
const rolesCreadosAqui = []; // [{id, nombre}]
const usuariosCreados = [];
const sufijo = Date.now();

const api = async (path, { method = 'GET', token, body } = {}) => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
};

const obtenerOCrearRol = async (nombre, permisos) => {
  const roles = await api('/roles', { token: tokenAdmin });
  const existente = roles.data.find((r) => r.nombre.toLowerCase() === nombre.toLowerCase());
  if (existente) return { rol: existente, creadoAqui: false };
  const creado = await api('/roles', {
    method: 'POST', token: tokenAdmin,
    body: { nombre, descripcion: `Rol de prueba (${nombre})`, permisos, color: '#222222' },
  });
  assert.equal(creado.status, 201, JSON.stringify(creado.data));
  rolesCreadosAqui.push({ id: creado.data.id, nombre });
  return { rol: creado.data, creadoAqui: true };
};

before(async () => {
  const login = await api('/auth/login', { method: 'POST', body: { username: ADMIN_USER, password: ADMIN_PASS } });
  assert.equal(login.status, 200, JSON.stringify(login.data));
  tokenAdmin = login.data.token;
});

after(async () => {
  for (const id of usuariosCreados) { try { await api(`/usuarios/${id}`, { method: 'DELETE', token: tokenAdmin }); } catch {} }
  for (const { id } of rolesCreadosAqui) { try { await api(`/roles/${id}`, { method: 'DELETE', token: tokenAdmin }); } catch {} }
});

// Un caso por rol real del sistema: crea el rol si hace falta, un usuario
// con ese rol, lo desactiva, y confirma 200 + cascada real.
for (const [nombre, permisos] of [
  ['Cliente', ['ver_productos']],
  ['Cajero', ['ver_pedidos', 'ver_ventas']],
  ['Bartender', ['ver_pedidos']],
]) {
  test(`Desactivar el rol "${nombre}" funciona con normalidad (200) y cascada real`, async () => {
    const { rol } = await obtenerOCrearRol(nombre, permisos);
    // Si el rol ya existía Inactivo (estado real previo, fuera de este
    // test), se reactiva primero para poder probar la transición
    // Activo -> Inactivo que es la que de verdad pidió el usuario.
    let rolActivo = rol;
    if (rol.estado !== 'Activo') {
      const reactivar = await api(`/roles/${rol.id}/estado`, { method: 'PATCH', token: tokenAdmin });
      assert.equal(reactivar.status, 200, JSON.stringify(reactivar.data));
      rolActivo = reactivar.data;
    }
    assert.equal(rolActivo.estado, 'Activo');

    const usuario = await api('/usuarios', {
      method: 'POST', token: tokenAdmin,
      body: { nombre: `Usuario ${nombre} ${sufijo}`, username: `usr_${nombre.toLowerCase()}_${sufijo}`, password: 'Clave123456#', rolId: rolActivo.id, sede: 'Local 1' },
    });
    assert.equal(usuario.status, 201, JSON.stringify(usuario.data));
    usuariosCreados.push(usuario.data.id);

    const r = await api(`/roles/${rolActivo.id}/estado`, { method: 'PATCH', token: tokenAdmin });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.estado, 'Inactivo', `el rol "${nombre}" debe poder desactivarse sin restricción`);
    // >= 1, no exactamente 1: la suite comparte una misma base de test
    // entre archivos (ver test/README.md) — otro archivo puede haber
    // dejado activo a un usuario real más con este mismo rol (ej.
    // "Cajero" vía POST /empleados en otro test). Lo que importa es que
    // NUESTRO usuario de prueba quede incluido, no el conteo total.
    assert.ok(r.data.usuariosDesactivados >= 1, `debe desactivar al menos 1 usuario (nuestro), vino ${r.data.usuariosDesactivados}`);

    const u = await api(`/usuarios/${usuario.data.id}`, { token: tokenAdmin });
    assert.equal(u.data.estado, 'Inactivo', `el usuario con rol "${nombre}" debe quedar Inactivo por la cascada`);
  });
}

test('Solo "Administrador" devuelve 409 — ningún otro rol del sistema ni personalizado tiene esa restricción', async () => {
  const { rol: admin, creadoAqui } = await obtenerOCrearRol('Administrador', ['ver_dashboard']);
  // Precondición: si la protección funciona de verdad, este rol NUNCA
  // puede haber quedado Inactivo por ningún camino — siempre Activo.
  assert.equal(admin.estado, 'Activo', 'el rol Administrador debe estar Activo (nunca debió poder desactivarse)');

  const r = await api(`/roles/${admin.id}/estado`, { method: 'PATCH', token: tokenAdmin });
  assert.equal(r.status, 409, JSON.stringify(r.data));
  assert.match(r.data.error, /Administrador/);

  const rolesDespues = await api('/roles', { token: tokenAdmin });
  const adminDespues = rolesDespues.data.find((x) => x.nombre.toLowerCase() === 'administrador');
  assert.equal(adminDespues.estado, 'Activo', 'el rol Administrador nunca debe terminar Inactivo');

  if (creadoAqui) { try { await api(`/roles/${admin.id}`, { method: 'DELETE', token: tokenAdmin }); } catch {} }
});

test('Un rol personalizado cualquiera (no del sistema) también se desactiva sin restricción', async () => {
  const nombre = `RolPersonalizado${sufijo}`;
  const { rol } = await obtenerOCrearRol(nombre, ['ver_insumos']);
  const r = await api(`/roles/${rol.id}/estado`, { method: 'PATCH', token: tokenAdmin });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.estado, 'Inactivo');
});
