// ─────────────────────────────────────────────────────────────────────────
//  Tests de integración: estado_pago separado del estado del pedido, sin
//  "pagar después" para pedidos de cliente, y permisos por rol en las
//  rutas que MUTAN un pedido (Cliente = solo lectura)
// ─────────────────────────────────────────────────────────────────────────
// Bugs reales que esto cubre:
//   • "Pago rechazado" solo existía como la combinación implícita
//     estado='cancelado' + comprobante_motivo_rechazo lleno — indistinguible
//     de cualquier OTRA cancelación para quien consume la API. Ahora hay un
//     campo propio, "estado_pago", separado de "estado".
//   • PATCH /pedidos/:id/estado, PUT /pedidos/:id y DELETE /pedidos/:id no
//     tenían NINGÚN chequeo de rol — un Cliente autenticado podía cambiar
//     el estado de un pedido sin local asignado (aunque no fuera suyo),
//     editar total/items de CUALQUIER pedido, o borrar cualquier pedido.
//
// Ejecutar: npm test
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const BASE = process.env.TEST_BASE_URL || 'http://localhost:4000/api';
const ADMIN_USER = process.env.TEST_ADMIN_USER || 'Admin_Sicaber';
const ADMIN_PASS = process.env.TEST_ADMIN_PASS || 'admin2024#';

let tokenAdmin, tokenCliente, tokenCajero;
let localA;
const pedidosCreados = [];

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

  // Cliente real: registro + login. /cliente/login no exige "verificado"
  // (mismo criterio que ya usa la app real: verificar el correo no bloquea
  // el login, solo lo marca), así que no hace falta leer el correo de
  // verificación para conseguir un token real de rol 'Cliente'.
  const sufijo = Date.now();
  const correoCliente = `cliente.test.permisos.${sufijo}@example.com`;
  const registro = await api('/auth/cliente/registro', {
    method: 'POST',
    body: { nombre: `Cliente Test Permisos ${sufijo}`, correo: correoCliente, password: 'Clave12345678#' },
  });
  assert.equal(registro.status, 201, JSON.stringify(registro.data));
  const loginCliente = await api('/auth/cliente/login', { method: 'POST', body: { correo: correoCliente, password: 'Clave12345678#' } });
  assert.equal(loginCliente.status, 200, JSON.stringify(loginCliente.data));
  tokenCliente = loginCliente.data.token;

  // Cajero real, asignado a localA — para confirmar que DELETE queda
  // reservado a Administrador y no a "cualquier staff".
  const empleado = await api('/empleados', {
    method: 'POST', token: tokenAdmin,
    body: {
      nombre: `Cajero test pedidos permisos ${sufijo}`, cargo: 'Cajero',
      local_id: localA, username: `cajero_ped_test_${sufijo}`, password: 'Clave12345678#',
    },
  });
  assert.equal(empleado.status, 201, JSON.stringify(empleado.data));
  const loginCajero = await api('/auth/login', { method: 'POST', body: { username: `cajero_ped_test_${sufijo}`, password: 'Clave12345678#' } });
  assert.equal(loginCajero.status, 200, JSON.stringify(loginCajero.data));
  tokenCajero = loginCajero.data.token;
});

after(async () => {
  for (const id of pedidosCreados) {
    try { await api(`/pedidos/${id}`, { method: 'DELETE', token: tokenAdmin }); } catch {}
  }
});

test('POST /pedidos de origen cliente (landing) SIN método de pago: 400, no existe "pagar después"', async () => {
  const r = await api('/pedidos', {
    method: 'POST',
    body: { cliente: 'Cliente sin pago', tipo: 'local', local_id: localA, total: 5000, items: [], origen: 'landing' },
  });
  assert.equal(r.status, 400, JSON.stringify(r.data));
  assert.match(r.data.error, /método de pago/i);
});

test('POST /pedidos: "tipo" queda como campo explícito (recoger en local vs domicilio), y estado_pago viaja separado de estado', async () => {
  // Nequi/Llave Bancolombia SÍ son válidos para recoger en el local (a
  // diferencia de efectivo, ver test dedicado en pedidos-metodo-pago —
  // efectivo ya no aplica a tipo='local').
  const r = await api('/pedidos', {
    method: 'POST',
    body: {
      cliente: 'Cliente con pago', alias: `alias-con-pago-${Date.now()}`, tipo: 'local', local_id: localA, total: 5000, items: [],
      origen: 'landing', pago: 'nequi',
    },
  });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  pedidosCreados.push(r.data.id);
  assert.equal(r.data.tipo, 'local');
  assert.ok('estado' in r.data);
  assert.ok('estado_pago' in r.data);
  assert.notEqual(r.data.estado_pago, undefined);
  // Nequi es un pago con comprobante: nace en 'pendiente_verificacion'
  // hasta que el cajero lo revise — nunca 'rechazado' sin que alguien lo
  // rechace, ni mezclado con el estado del pedido.
  assert.equal(r.data.estado_pago, 'pendiente_verificacion');
  assert.equal(r.data.estado, 'pendiente_verificacion');
});

test('estado_pago distingue un comprobante RECHAZADO de una cancelación cualquiera', async () => {
  // Caso 1: pedido pagado por transferencia, con comprobante, rechazado.
  const conComprobante = await api('/pedidos', {
    method: 'POST',
    body: {
      cliente: 'Cliente transferencia', alias: `alias-transferencia-${Date.now()}`, tipo: 'local', local_id: localA, total: 8000, items: [],
      origen: 'landing', pago: 'transferencia', comprobante_img: `data:text/plain;base64,rechazo-${Date.now()}`,
    },
  });
  assert.equal(conComprobante.status, 201, JSON.stringify(conComprobante.data));
  pedidosCreados.push(conComprobante.data.id);
  assert.equal(conComprobante.data.estado, 'pendiente_verificacion');
  assert.equal(conComprobante.data.estado_pago, 'pendiente_verificacion');

  const rechazo = await api(`/pedidos/${conComprobante.data.id}/comprobante/rechazar`, {
    method: 'PATCH', token: tokenAdmin, body: { motivo: 'El comprobante no coincide con el monto del pedido.' },
  });
  assert.equal(rechazo.status, 200, JSON.stringify(rechazo.data));
  assert.equal(rechazo.data.estado, 'cancelado', 'el pedido SÍ queda cancelado (comportamiento real, sin cambios)');
  assert.equal(rechazo.data.estado_pago, 'rechazado', 'pero estado_pago lo distingue como un pago rechazado, no una cancelación cualquiera');

  // Caso 2: un pedido en efectivo, cancelado por cualquier otra razón — NO
  // debe caer en 'rechazado' solo porque el pedido terminó 'cancelado'.
  const efectivo = await api('/pedidos', {
    method: 'POST',
    body: { cliente: 'Cliente cancela por otra razón', alias: `alias-cancela-${Date.now()}`, tipo: 'local', local_id: localA, total: 3000, items: [], origen: 'landing', pago: 'nequi' },
  });
  assert.equal(efectivo.status, 201, JSON.stringify(efectivo.data));
  pedidosCreados.push(efectivo.data.id);
  const cancelado = await api(`/pedidos/${efectivo.data.id}/estado`, {
    method: 'PATCH', token: tokenAdmin, body: { estado: 'cancelado' },
  });
  assert.equal(cancelado.status, 200, JSON.stringify(cancelado.data));
  assert.equal(cancelado.data.estado, 'cancelado');
  assert.notEqual(cancelado.data.estado_pago, 'rechazado', 'una cancelación sin comprobante rechazado no debe leerse como "pago rechazado"');
});

test('Cliente: 403 al intentar cambiar el estado de un pedido (solo lectura)', async () => {
  const ped = await api('/pedidos', {
    method: 'POST',
    body: { cliente: 'Cliente prueba estado', alias: `alias-prueba-estado-${Date.now()}`, tipo: 'local', local_id: localA, total: 4000, items: [], origen: 'landing', pago: 'nequi' },
  });
  assert.equal(ped.status, 201, JSON.stringify(ped.data));
  pedidosCreados.push(ped.data.id);

  const r = await api(`/pedidos/${ped.data.id}/estado`, {
    method: 'PATCH', token: tokenCliente, body: { estado: 'en_proceso' },
  });
  assert.equal(r.status, 403, JSON.stringify(r.data));
});

test('Cliente: 403 al intentar editar un pedido con PUT (solo lectura)', async () => {
  const ped = await api('/pedidos', {
    method: 'POST',
    body: { cliente: 'Cliente prueba put', alias: `alias-prueba-put-${Date.now()}`, tipo: 'local', local_id: localA, total: 4000, items: [], origen: 'landing', pago: 'nequi' },
  });
  assert.equal(ped.status, 201, JSON.stringify(ped.data));
  pedidosCreados.push(ped.data.id);

  const r = await api(`/pedidos/${ped.data.id}`, {
    method: 'PUT', token: tokenCliente, body: { total: 1 },
  });
  assert.equal(r.status, 403, JSON.stringify(r.data));
});

test('DELETE /pedidos/:id queda reservado a Administrador — ni Cliente ni Cajero pueden borrar', async () => {
  const ped = await api('/pedidos', {
    method: 'POST',
    body: { cliente: 'Cliente prueba delete', alias: `alias-prueba-delete-${Date.now()}`, tipo: 'local', local_id: localA, total: 4000, items: [], origen: 'landing', pago: 'nequi' },
  });
  assert.equal(ped.status, 201, JSON.stringify(ped.data));

  const rCliente = await api(`/pedidos/${ped.data.id}`, { method: 'DELETE', token: tokenCliente });
  assert.equal(rCliente.status, 403, JSON.stringify(rCliente.data));

  const rCajero = await api(`/pedidos/${ped.data.id}`, { method: 'DELETE', token: tokenCajero });
  assert.equal(rCajero.status, 403, JSON.stringify(rCajero.data));

  const rAdmin = await api(`/pedidos/${ped.data.id}`, { method: 'DELETE', token: tokenAdmin });
  assert.equal(rAdmin.status, 200, JSON.stringify(rAdmin.data));
});
