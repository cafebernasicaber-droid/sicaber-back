// ─────────────────────────────────────────────────────────────────────────
//  Test de integración: método de pago para "Recoger en el local" (Ronda 30)
// ─────────────────────────────────────────────────────────────────────────
// Campo nuevo `metodo_pago_local` (texto libre) — el método que el cliente
// dice que va a usar AL RECOGER en persona, distinto del "pago" existente
// (que sigue su propio flujo de comprobante/verificación sin cambios).
// Solo tiene sentido para tipo='local' (recoger); en domicilio se rechaza
// si se manda, y se limpia solo si el pedido cambia a domicilio por PUT.
// Ejecutar: npm test
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const BASE = process.env.TEST_BASE_URL || 'http://localhost:4000/api';
const ADMIN_USER = process.env.TEST_ADMIN_USER || 'Admin_Sicaber';
const ADMIN_PASS = process.env.TEST_ADMIN_PASS || 'admin2024#';
const DIRECCION_CUBIERTA = 'Calle 57B # 7-71, Medellín'; // Comuna 8 — ver test-geocoding.js

let tokenAdmin;
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
});

after(async () => {
  for (const id of pedidosCreados) {
    try { await api(`/pedidos/${id}`, { method: 'DELETE', token: tokenAdmin }); } catch {}
  }
});

test('POST /pedidos tipo=local con metodo_pago_local: se guarda tal cual', async () => {
  const sufijo = Date.now();
  const r = await api('/pedidos', {
    method: 'POST', token: tokenAdmin,
    body: {
      cliente: `Cliente recoge ${sufijo}`, alias: `alias-recoge-${sufijo}`, tipo: 'local', local_id: localA, origen: 'admin',
      metodo_pago_local: 'Efectivo al recoger', total: 9000,
      items: [{ id: `prod-recoge-${sufijo}`, nombre: 'Café', precio: 9000, cantidad: 1 }],
    },
  });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  pedidosCreados.push(r.data.id);
  assert.equal(r.data.metodo_pago_local, 'Efectivo al recoger');
});

test('POST /pedidos tipo=local SIN metodo_pago_local: opcional, no lo exige', async () => {
  const sufijo = Date.now() + '-sin';
  const r = await api('/pedidos', {
    method: 'POST', token: tokenAdmin,
    body: {
      cliente: `Cliente recoge sin metodo ${sufijo}`, alias: `alias-recoge-sin-${sufijo}`, tipo: 'local', local_id: localA, origen: 'admin',
      total: 9000, items: [{ id: `prod-recoge-sin-${sufijo}`, nombre: 'Café', precio: 9000, cantidad: 1 }],
    },
  });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  pedidosCreados.push(r.data.id);
  assert.equal(r.data.metodo_pago_local, null);
});

test('POST /pedidos tipo=domicilio con metodo_pago_local: 400 — ese campo no aplica a domicilio', async () => {
  const sufijo = Date.now() + '-domicilio';
  const r = await api('/pedidos', {
    method: 'POST', token: tokenAdmin,
    body: {
      cliente: `Cliente domicilio metodo local ${sufijo}`, alias: `alias-domicilio-metodo-${sufijo}`, tipo: 'domicilio',
      direccion_alternativa: DIRECCION_CUBIERTA, metodo_pago_local: 'Efectivo', total: 8000, items: [], origen: 'admin',
    },
  });
  assert.equal(r.status, 400, JSON.stringify(r.data));
  assert.match(r.data.error, /solo aplica a pedidos de tipo "local"/);
});

test('POST /pedidos: metodo_pago_local respeta el tope de longitud (100 caracteres)', async () => {
  const sufijo = Date.now() + '-largo';
  const r = await api('/pedidos', {
    method: 'POST', token: tokenAdmin,
    body: {
      cliente: `Cliente texto largo ${sufijo}`, alias: `alias-texto-largo-${sufijo}`, tipo: 'local', local_id: localA, origen: 'admin',
      metodo_pago_local: 'x'.repeat(101), total: 9000, items: [],
    },
  });
  assert.equal(r.status, 400, JSON.stringify(r.data));
  assert.match(r.data.error, /no puede superar los 100 caracteres/);
});

test('PUT /pedidos/:id tipo=local: agrega metodo_pago_local a un pedido que no lo tenía', async () => {
  const sufijo = Date.now() + '-put';
  const creado = await api('/pedidos', {
    method: 'POST', token: tokenAdmin,
    body: {
      cliente: `Cliente PUT metodo ${sufijo}`, alias: `alias-put-metodo-${sufijo}`, tipo: 'local', local_id: localA, origen: 'admin',
      total: 9000, items: [],
    },
  });
  assert.equal(creado.status, 201, JSON.stringify(creado.data));
  const id = creado.data.id;
  pedidosCreados.push(id);
  assert.equal(creado.data.metodo_pago_local, null);

  const editado = await api(`/pedidos/${id}`, {
    method: 'PUT', token: tokenAdmin, body: { metodo_pago_local: 'Nequi al recoger' },
  });
  assert.equal(editado.status, 200, JSON.stringify(editado.data));
  assert.equal(editado.data.metodo_pago_local, 'Nequi al recoger');
});

test('PUT /pedidos/:id tipo=domicilio: rechaza mandar metodo_pago_local', async () => {
  const sufijo = Date.now() + '-put-domicilio';
  const creado = await api('/pedidos', {
    method: 'POST', token: tokenAdmin,
    body: {
      cliente: `Cliente PUT domicilio ${sufijo}`, alias: `alias-put-domicilio-${sufijo}`, tipo: 'domicilio',
      direccion_alternativa: DIRECCION_CUBIERTA, total: 8000, items: [], origen: 'admin',
    },
  });
  assert.equal(creado.status, 201, JSON.stringify(creado.data));
  pedidosCreados.push(creado.data.id);

  const editado = await api(`/pedidos/${creado.data.id}`, {
    method: 'PUT', token: tokenAdmin, body: { metodo_pago_local: 'Efectivo' },
  });
  assert.equal(editado.status, 400, JSON.stringify(editado.data));
  assert.match(editado.data.error, /solo aplica a pedidos de tipo "local"/);
});

test('PUT /pedidos/:id: cambiar tipo de local→domicilio limpia metodo_pago_local automáticamente', async () => {
  const sufijo = Date.now() + '-switch';
  const creado = await api('/pedidos', {
    method: 'POST', token: tokenAdmin,
    body: {
      cliente: `Cliente switch tipo ${sufijo}`, alias: `alias-switch-${sufijo}`, tipo: 'local', local_id: localA, origen: 'admin',
      metodo_pago_local: 'Efectivo al recoger', total: 9000, items: [],
    },
  });
  assert.equal(creado.status, 201, JSON.stringify(creado.data));
  const id = creado.data.id;
  pedidosCreados.push(id);
  assert.equal(creado.data.metodo_pago_local, 'Efectivo al recoger');

  const editado = await api(`/pedidos/${id}`, {
    method: 'PUT', token: tokenAdmin,
    body: { tipo: 'domicilio', direccion_alternativa: DIRECCION_CUBIERTA },
  });
  assert.equal(editado.status, 200, JSON.stringify(editado.data));
  assert.equal(editado.data.tipo, 'domicilio');
  assert.equal(editado.data.metodo_pago_local, null, 'al pasar a domicilio, el método de pago para recoger en el local debe limpiarse solo');
});
