// ─────────────────────────────────────────────────────────────────────────
//  Tests de integración (Ronda 32):
//   1) "Efectivo" (pago contraentrega, sin comprobante) ya es válido para
//      tipo='local' (recoger), no solo domicilio — nace en 'pendiente',
//      sin exigir comprobante ni verificación.
//   2) Nequi/Llave Bancolombia SIGUEN exigiendo comprobante + verificación
//      manual, en los dos tipos de entrega (no se tocó ese flujo).
//   3) El Bartender no puede, vía API, avanzar un pedido más allá de
//      'en_camino' ("Listo para recoger") — ni marcarlo entregado ni
//      cancelarlo — aunque la pantalla no le muestre esos botones.
// ─────────────────────────────────────────────────────────────────────────
// Ejecutar: npm test
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const BASE = process.env.TEST_BASE_URL || 'http://localhost:4000/api';
const ADMIN_USER = process.env.TEST_ADMIN_USER || 'Admin_Sicaber';
const ADMIN_PASS = process.env.TEST_ADMIN_PASS || 'admin2024#';

let tokenAdmin, tokenBartender, tokenCajero;
let localA;
const pedidosCreados = [];
const empleadosCreados = [];

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

  const sufijo = Date.now();
  const bartender = await api('/empleados', {
    method: 'POST', token: tokenAdmin,
    body: { nombre: `Bartender test transiciones ${sufijo}`, cargo: 'Bartender', local_id: localA, username: `bartender_trans_${sufijo}`, password: 'Clave12345678#' },
  });
  assert.equal(bartender.status, 201, JSON.stringify(bartender.data));
  empleadosCreados.push(bartender.data.id);
  const loginBartender = await api('/auth/login', { method: 'POST', body: { username: `bartender_trans_${sufijo}`, password: 'Clave12345678#' } });
  assert.equal(loginBartender.status, 200, JSON.stringify(loginBartender.data));
  tokenBartender = loginBartender.data.token;

  const cajero = await api('/empleados', {
    method: 'POST', token: tokenAdmin,
    body: { nombre: `Cajero test transiciones ${sufijo}`, cargo: 'Cajero', local_id: localA, username: `cajero_trans_${sufijo}`, password: 'Clave12345678#' },
  });
  assert.equal(cajero.status, 201, JSON.stringify(cajero.data));
  empleadosCreados.push(cajero.data.id);
  const loginCajero = await api('/auth/login', { method: 'POST', body: { username: `cajero_trans_${sufijo}`, password: 'Clave12345678#' } });
  assert.equal(loginCajero.status, 200, JSON.stringify(loginCajero.data));
  tokenCajero = loginCajero.data.token;
});

after(async () => {
  for (const id of pedidosCreados) {
    try { await api(`/pedidos/${id}`, { method: 'DELETE', token: tokenAdmin }); } catch {}
  }
  for (const id of empleadosCreados) {
    try { await api(`/empleados/${id}`, { method: 'DELETE', token: tokenAdmin }); } catch {}
  }
});

const crearPedidoLocal = async (sufijo, pago, extra = {}) => {
  const r = await api('/pedidos', {
    method: 'POST', token: tokenAdmin,
    body: {
      cliente: `Cliente contraentrega ${sufijo}`, alias: `alias-contraentrega-${sufijo}`,
      tipo: 'local', local_id: localA, origen: 'admin', pago, total: 9000,
      items: [{ id: `prod-ce-${sufijo}`, nombre: 'Café', precio: 9000, cantidad: 1 }],
      ...extra,
    },
  });
  if (r.status === 201) pedidosCreados.push(r.data.id);
  return r;
};

test('POST /pedidos tipo=local + pago=efectivo (contraentrega): se crea SIN comprobante, directo a "pendiente"', async () => {
  const r = await crearPedidoLocal(Date.now() + '-efectivo', 'efectivo');
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.estado, 'pendiente');
  assert.equal(r.data.comprobante_img, null);
  assert.equal(r.data.pago, 'efectivo');
});

test('POST /pedidos tipo=local + pago=nequi SIN comprobante: sigue exigiendo verificación (pendiente_verificacion) — no se tocó ese flujo', async () => {
  const r = await crearPedidoLocal(Date.now() + '-nequi', 'nequi');
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.estado, 'pendiente_verificacion');
});

test('PATCH /pedidos/:id/comprobante/aprobar sobre un pedido de recoger con nequi sin comprobante: mensaje en lenguaje de negocio, sin rutas internas', async () => {
  const creado = await crearPedidoLocal(Date.now() + '-nequi-aprobar', 'nequi');
  assert.equal(creado.status, 201, JSON.stringify(creado.data));
  const r = await api(`/pedidos/${creado.data.id}/comprobante/aprobar`, { method: 'PATCH', token: tokenAdmin });
  assert.equal(r.status, 400, JSON.stringify(r.data));
  assert.doesNotMatch(r.data.error, /PUT \/pedidos|PATCH \/pedidos/, `no debe exponer rutas internas: ${r.data.error}`);
  assert.match(r.data.error, /comprobante de pago/i);
});

test('Bartender: SÍ puede avanzar pendiente→en_proceso→en_camino ("Listo para recoger")', async () => {
  const creado = await crearPedidoLocal(Date.now() + '-bartender-ok', 'efectivo');
  assert.equal(creado.status, 201, JSON.stringify(creado.data));
  const id = creado.data.id;

  const aProceso = await api(`/pedidos/${id}/estado`, { method: 'PATCH', token: tokenBartender, body: { estado: 'en_proceso' } });
  assert.equal(aProceso.status, 200, JSON.stringify(aProceso.data));

  const aCamino = await api(`/pedidos/${id}/estado`, { method: 'PATCH', token: tokenBartender, body: { estado: 'en_camino' } });
  assert.equal(aCamino.status, 200, JSON.stringify(aCamino.data));
  assert.equal(aCamino.data.estado, 'en_camino');
});

test('Bartender: NO puede marcar un pedido como "entregado" — 403, aunque llame la API directo', async () => {
  const creado = await crearPedidoLocal(Date.now() + '-bartender-entregado', 'efectivo');
  assert.equal(creado.status, 201, JSON.stringify(creado.data));
  const id = creado.data.id;
  await api(`/pedidos/${id}/estado`, { method: 'PATCH', token: tokenBartender, body: { estado: 'en_proceso' } });
  await api(`/pedidos/${id}/estado`, { method: 'PATCH', token: tokenBartender, body: { estado: 'en_camino' } });

  const r = await api(`/pedidos/${id}/estado`, { method: 'PATCH', token: tokenBartender, body: { estado: 'entregado' } });
  assert.equal(r.status, 403, JSON.stringify(r.data));
  assert.match(r.data.error, /Bartender/);

  // Confirma que sigue en 'en_camino' — el intento no lo movió.
  const factura = await api(`/pedidos/${id}`, { token: tokenAdmin });
  assert.equal(factura.data.estado, 'en_camino');
});

test('Bartender: NO puede cancelar un pedido — 403', async () => {
  const creado = await crearPedidoLocal(Date.now() + '-bartender-cancelar', 'efectivo');
  assert.equal(creado.status, 201, JSON.stringify(creado.data));
  const r = await api(`/pedidos/${creado.data.id}/estado`, { method: 'PATCH', token: tokenBartender, body: { estado: 'cancelado' } });
  assert.equal(r.status, 403, JSON.stringify(r.data));
});

test('Cajero/Administrador: SÍ pueden marcar "entregado" — el límite es solo para Bartender', async () => {
  const creado = await crearPedidoLocal(Date.now() + '-cajero-entregado', 'efectivo');
  assert.equal(creado.status, 201, JSON.stringify(creado.data));
  const id = creado.data.id;
  await api(`/pedidos/${id}/estado`, { method: 'PATCH', token: tokenCajero, body: { estado: 'en_proceso' } });
  await api(`/pedidos/${id}/estado`, { method: 'PATCH', token: tokenCajero, body: { estado: 'en_camino' } });
  const r = await api(`/pedidos/${id}/estado`, { method: 'PATCH', token: tokenCajero, body: { estado: 'entregado' } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.estado, 'entregado');
});
