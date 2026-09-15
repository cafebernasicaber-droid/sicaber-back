// ─────────────────────────────────────────────────────────────────────────
//  Tests de integración: desactivar un rol desactiva en cascada a los
//  usuarios que lo tengan asignado — sin tocar su historial, sin
//  reactivarlos solos si el rol se reactiva, y sin poder desactivar nunca
//  el rol "Administrador".
// ─────────────────────────────────────────────────────────────────────────
// Ejecutar: npm test
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const BASE = process.env.TEST_BASE_URL || 'http://localhost:4000/api';
const ADMIN_USER = process.env.TEST_ADMIN_USER || 'Admin_Sicaber';
const ADMIN_PASS = process.env.TEST_ADMIN_PASS || 'admin2024#';

let tokenAdmin;
let localA;
let rolId;
const usuarioIds = [];
const pedidosCreados = [];
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

before(async () => {
  const login = await api('/auth/login', { method: 'POST', body: { username: ADMIN_USER, password: ADMIN_PASS } });
  assert.equal(login.status, 200, JSON.stringify(login.data));
  tokenAdmin = login.data.token;

  const listado = await api('/locales/todos', { token: tokenAdmin });
  const activos = listado.data.filter((l) => l.estado === 'Activo');
  assert.ok(activos.length >= 1, 'se necesita al menos 1 local Activo');
  localA = activos[0].id;

  const rol = await api('/roles', {
    method: 'POST', token: tokenAdmin,
    body: { nombre: `RolCascada${sufijo}`, descripcion: 'Rol de prueba cascada', permisos: ['ver_pedidos', 'ver_ventas'], color: '#654321' },
  });
  assert.equal(rol.status, 201, JSON.stringify(rol.data));
  rolId = rol.data.id;
  assert.equal(rol.data.estado, 'Activo', 'un rol nuevo nace Activo');

  for (let i = 0; i < 3; i++) {
    const u = await api('/usuarios', {
      method: 'POST', token: tokenAdmin,
      body: { nombre: `Usuario Cascada ${i} ${sufijo}`, username: `usr_cascada_${i}_${sufijo}`, password: 'Clave123456#', rolId, sede: 'Local 1' },
    });
    assert.equal(u.status, 201, JSON.stringify(u.data));
    usuarioIds.push(u.data.id);
  }
});

after(async () => {
  for (const id of pedidosCreados) { try { await api(`/pedidos/${id}`, { method: 'DELETE', token: tokenAdmin }); } catch {} }
  for (const id of usuarioIds) { try { await api(`/usuarios/${id}`, { method: 'DELETE', token: tokenAdmin }); } catch {} }
  if (rolId) { try { await api(`/roles/${rolId}`, { method: 'DELETE', token: tokenAdmin }); } catch {} }
});

test('PATCH /roles/:id/estado: desactivar el rol desactiva en cascada a sus 3 usuarios, sin tocar su historial', async () => {
  // Historial real de uno de los usuarios: un pedido que "atendió".
  const pedido = await api('/pedidos', {
    method: 'POST', token: tokenAdmin,
    body: {
      cliente: `Cliente historial cascada ${sufijo}`, alias: `alias-historial-cascada-${sufijo}`, tipo: 'local', local_id: localA, origen: 'admin',
      pago: 'nequi', total: 5000, items: [], atendido_por: usuarioIds[0],
    },
  });
  assert.equal(pedido.status, 201, JSON.stringify(pedido.data));
  pedidosCreados.push(pedido.data.id);
  assert.equal(pedido.data.atendido_por, usuarioIds[0]);

  for (const id of usuarioIds) {
    const u = await api(`/usuarios/${id}`, { token: tokenAdmin });
    assert.equal(u.data.estado, 'Activo', `usuario ${id} debe empezar Activo`);
  }

  const desactivar = await api(`/roles/${rolId}/estado`, { method: 'PATCH', token: tokenAdmin });
  assert.equal(desactivar.status, 200, JSON.stringify(desactivar.data));
  assert.equal(desactivar.data.estado, 'Inactivo');
  assert.equal(desactivar.data.usuariosDesactivados, 3, 'debe reportar exactamente los 3 usuarios desactivados');

  for (const id of usuarioIds) {
    const u = await api(`/usuarios/${id}`, { token: tokenAdmin });
    assert.equal(u.data.estado, 'Inactivo', `usuario ${id} debe quedar Inactivo tras desactivar el rol`);
  }

  // El historial NO se toca: el pedido sigue existiendo, con el mismo
  // atendido_por, mismo total, mismo cliente — nada se borró ni se alteró.
  const pedidoDespues = await api(`/pedidos/${pedido.data.id}`, { token: tokenAdmin });
  assert.equal(pedidoDespues.status, 200);
  assert.equal(pedidoDespues.data.atendido_por, usuarioIds[0], 'atendido_por no debe cambiar ni borrarse');
  assert.equal(pedidoDespues.data.total, 5000);
  assert.equal(pedidoDespues.data.cliente, `Cliente historial cascada ${sufijo}`);
});

test('Reactivar el rol NO reactiva a los usuarios automáticamente', async () => {
  const reactivar = await api(`/roles/${rolId}/estado`, { method: 'PATCH', token: tokenAdmin });
  assert.equal(reactivar.status, 200, JSON.stringify(reactivar.data));
  assert.equal(reactivar.data.estado, 'Activo');
  assert.equal(reactivar.data.usuariosDesactivados, 0, 'reactivar el rol no desactiva (ni reactiva) a nadie');

  for (const id of usuarioIds) {
    const u = await api(`/usuarios/${id}`, { token: tokenAdmin });
    assert.equal(u.data.estado, 'Inactivo', `usuario ${id} debe seguir Inactivo — la reactivación es manual, uno por uno`);
  }
});

test('El rol "Administrador" no se puede desactivar bajo ninguna circunstancia', async () => {
  // El rol "Administrador" (fila de la tabla `roles`, para documentar sus
  // permisos en el panel) es opcional en el sistema — el bypass real de
  // permisos ocurre por el NOMBRE del rol del usuario (usuarios.rol), no
  // por esta fila — así que una base recién creada puede no tenerla
  // todavía. Se crea aquí si hace falta, y solo se borra al final si fue
  // este test quien la creó (nunca se toca una fila real ya existente).
  let admin;
  let rolAdminCreadoAqui = false;
  const roles = await api('/roles', { token: tokenAdmin });
  admin = roles.data.find((r) => r.nombre === 'Administrador');
  if (!admin) {
    const creado = await api('/roles', {
      method: 'POST', token: tokenAdmin,
      body: { nombre: 'Administrador', descripcion: 'Rol Administrador (creado por el test)', permisos: ['ver_dashboard'], color: '#E53935' },
    });
    assert.equal(creado.status, 201, JSON.stringify(creado.data));
    admin = creado.data;
    rolAdminCreadoAqui = true;
  }
  assert.equal(admin.estado, 'Activo', 'el rol Administrador debe estar Activo hoy (precondición del test)');

  try {
    const r = await api(`/roles/${admin.id}/estado`, { method: 'PATCH', token: tokenAdmin });
    assert.equal(r.status, 409, JSON.stringify(r.data));
    assert.match(r.data.error, /Administrador/);

    const rolesDespues = await api('/roles', { token: tokenAdmin });
    const adminDespues = rolesDespues.data.find((r) => r.nombre === 'Administrador');
    assert.equal(adminDespues.estado, 'Activo', 'el rol Administrador debe seguir Activo — el bloqueo debe ser real, no solo el mensaje');
  } finally {
    if (rolAdminCreadoAqui) { try { await api(`/roles/${admin.id}`, { method: 'DELETE', token: tokenAdmin }); } catch {} }
  }
});
