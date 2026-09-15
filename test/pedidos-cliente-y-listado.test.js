// ─────────────────────────────────────────────────────────────────────────
//  Tests de integración:
//   1) Un pedido totalmente devuelto deja de aparecer en GET /pedidos
//      (el listado operativo), sin desaparecer de /pedidos/:id ni de
//      GET /devoluciones.
//   2) La dirección de domicilio se guarda igual sin importar quién cree
//      el pedido (Admin/Cajero vs. cliente/landing).
//   3) POST /pedidos valida que cliente_id exista de verdad, y exige un
//      nombre cuando no hay cliente_id (nunca un pedido anónimo).
// ─────────────────────────────────────────────────────────────────────────
// Ejecutar: npm test
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const BASE = process.env.TEST_BASE_URL || 'http://localhost:4000/api';
const ADMIN_USER = process.env.TEST_ADMIN_USER || 'Admin_Sicaber';
const ADMIN_PASS = process.env.TEST_ADMIN_PASS || 'admin2024#';
const DIRECCION_CUBIERTA = 'Calle 57B # 7-71, Medellín'; // Comuna 8 — ver test-geocoding.js

let tokenAdmin, tokenCajero;
let localA;
let clienteId;
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

  const sufijo = Date.now();
  const correoCliente = `cliente.test.listado.${sufijo}@example.com`;
  const registro = await api('/auth/cliente/registro', {
    method: 'POST',
    body: { nombre: `Cliente Test Listado ${sufijo}`, correo: correoCliente, password: 'Clave12345678#' },
  });
  assert.equal(registro.status, 201, JSON.stringify(registro.data));
  const loginCliente = await api('/auth/cliente/login', { method: 'POST', body: { correo: correoCliente, password: 'Clave12345678#' } });
  assert.equal(loginCliente.status, 200, JSON.stringify(loginCliente.data));
  clienteId = loginCliente.data.cliente.id;

  const empleado = await api('/empleados', {
    method: 'POST', token: tokenAdmin,
    body: { nombre: `Cajero test listado ${sufijo}`, cargo: 'Cajero', local_id: localA, username: `cajero_listado_${sufijo}`, password: 'Clave12345678#' },
  });
  assert.equal(empleado.status, 201, JSON.stringify(empleado.data));
  const loginCajero = await api('/auth/login', { method: 'POST', body: { username: `cajero_listado_${sufijo}`, password: 'Clave12345678#' } });
  assert.equal(loginCajero.status, 200, JSON.stringify(loginCajero.data));
  tokenCajero = loginCajero.data.token;
});

after(async () => {
  for (const id of pedidosCreados) {
    try { await api(`/pedidos/${id}`, { method: 'DELETE', token: tokenAdmin }); } catch {}
  }
});

// ── 1) Pedidos entregados (y/o totalmente devueltos) salen del listado
//      operativo ──────────────────────────────────────────────────────
// Requisito de la Ronda 29 ("Pedidos entregados → Ventas"): un pedido ya
// 'entregado' deja de listarse como "activo" en GET /pedidos —
// independientemente de si además tiene una devolución total— pero sigue
// consultable por completo en /pedidos/:id y en /devoluciones. Antes de
// esa ronda, SOLO la devolución total lo sacaba del listado (un pedido
// entregado sin devolución seguía apareciendo ahí, mezclado con lo que de
// verdad falta atender).
test('GET /pedidos: al marcarse "entregado" el pedido sale del listado, con o sin devolución total después — pero sigue en /pedidos/:id y en /devoluciones', async () => {
  const creado = await api('/pedidos', {
    method: 'POST',
    body: {
      cliente: `Cliente listado ${Date.now()}`, alias: `alias-listado-${Date.now()}`, tipo: 'local', local_id: localA, origen: 'admin',
      pago: 'nequi', comprobante_img: `data:text/plain;base64,listado-${Date.now()}`, total: 5000,
      items: [{ id: 'prod-listado', nombre: 'Producto', precio: 5000, cantidad: 1 }],
    },
  });
  assert.equal(creado.status, 201, JSON.stringify(creado.data));
  const id = creado.data.id;
  pedidosCreados.push(id);

  await api(`/pedidos/${id}/comprobante/aprobar`, { method: 'PATCH', token: tokenAdmin });

  const antesDeEntregar = await api('/pedidos', { token: tokenAdmin });
  assert.ok(antesDeEntregar.data.some((p) => p.id === id), 'antes de marcarse entregado, el pedido SÍ aparece en el listado');

  await api(`/pedidos/${id}/estado`, { method: 'PATCH', token: tokenAdmin, body: { estado: 'entregado' } });

  const despuesDeEntregar = await api('/pedidos', { token: tokenAdmin });
  assert.ok(!despuesDeEntregar.data.some((p) => p.id === id), 'ya entregado, el pedido NO debe aparecer en el listado operativo (ver Ronda 29)');

  const dev = await api('/devoluciones', {
    method: 'POST', token: tokenAdmin,
    body: { pedido_id: id, motivo: 'Evidencia devolución total para listado', items: [{ item_index: 0, cantidad: 1 }] },
  });
  assert.equal(dev.status, 201, JSON.stringify(dev.data));
  const aprobar = await api(`/devoluciones/${dev.data.id}/estado`, { method: 'PATCH', token: tokenAdmin, body: { estado: 'aprobada' } });
  assert.equal(aprobar.status, 200, JSON.stringify(aprobar.data));
  assert.equal(aprobar.data.pedido.estado_devolucion, 'total');

  const despues = await api('/pedidos', { token: tokenAdmin });
  assert.ok(!despues.data.some((p) => p.id === id), 'después de la devolución TOTAL, sigue sin aparecer en el listado operativo');

  const factura = await api(`/pedidos/${id}`, { token: tokenAdmin });
  assert.equal(factura.status, 200, 'el pedido sigue consultable directo por id');
  assert.equal(factura.data.estado_devolucion, 'total');

  const devoluciones = await api('/devoluciones', { token: tokenAdmin });
  assert.ok(devoluciones.data.some((d) => d.pedido_id === id), 'la devolución sigue visible en GET /devoluciones, que es la fuente de verdad');
});

test('GET /pedidos: una devolución PARCIAL tampoco lo regresa al listado (ya está entregado) — pero sigue "vendido" en /ventas', async () => {
  const creado = await api('/pedidos', {
    method: 'POST',
    body: {
      cliente: `Cliente listado parcial ${Date.now()}`, alias: `alias-listado-parcial-${Date.now()}`, tipo: 'local', local_id: localA, origen: 'admin',
      pago: 'nequi', comprobante_img: `data:text/plain;base64,listado-parcial-${Date.now()}`, total: 10000,
      items: [{ id: 'prod-a', nombre: 'A', precio: 5000, cantidad: 2 }],
    },
  });
  assert.equal(creado.status, 201, JSON.stringify(creado.data));
  const id = creado.data.id;
  pedidosCreados.push(id);
  await api(`/pedidos/${id}/comprobante/aprobar`, { method: 'PATCH', token: tokenAdmin });
  await api(`/pedidos/${id}/estado`, { method: 'PATCH', token: tokenAdmin, body: { estado: 'entregado' } });

  const dev = await api('/devoluciones', {
    method: 'POST', token: tokenAdmin,
    body: { pedido_id: id, motivo: 'Solo una de las dos unidades', items: [{ item_index: 0, cantidad: 1 }] },
  });
  assert.equal(dev.status, 201, JSON.stringify(dev.data));
  const aprobar = await api(`/devoluciones/${dev.data.id}/estado`, { method: 'PATCH', token: tokenAdmin, body: { estado: 'aprobada' } });
  assert.equal(aprobar.data.pedido.estado_devolucion, 'parcial');

  const listado = await api('/pedidos', { token: tokenAdmin });
  assert.ok(!listado.data.some((p) => p.id === id), 'ya entregado, no vuelve a aparecer en el listado operativo aunque la devolución sea solo parcial');

  const ventas = await api('/ventas', { token: tokenAdmin });
  const venta = ventas.data.find((v) => v.pedido_id === id || v.id_pedido === id);
  assert.ok(venta, 'la venta sigue existiendo/consultable — una devolución parcial no la elimina');
  assert.equal(venta.estado, 'vendido', 'una devolución parcial no cambia el estado de la venta a "devuelto"');
});

// ── 2) Dirección de domicilio: mismo campo, sin importar quién crea el pedido ──
test('POST /pedidos: Admin puede crear un pedido a domicilio con dirección, igual que el cliente en la landing', async () => {
  const r = await api('/pedidos', {
    method: 'POST', token: tokenAdmin,
    body: {
      cliente: 'Cliente domicilio por Admin', alias: `alias-domicilio-admin-${Date.now()}`, tipo: 'domicilio', direccion_alternativa: DIRECCION_CUBIERTA,
      total: 8000, items: [], origen: 'admin', pago: 'efectivo',
    },
  });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  pedidosCreados.push(r.data.id);
  assert.equal(r.data.tipo, 'domicilio');
  assert.equal(r.data.direccion_alternativa, DIRECCION_CUBIERTA);
});

test('POST /pedidos: Cajero puede crear un pedido a domicilio con dirección (mismo campo, mismo resultado)', async () => {
  const r = await api('/pedidos', {
    method: 'POST', token: tokenCajero,
    body: {
      cliente: 'Cliente domicilio por Cajero', alias: `alias-domicilio-cajero-${Date.now()}`, tipo: 'domicilio', direccion_alternativa: DIRECCION_CUBIERTA,
      total: 8500, items: [], origen: 'admin', pago: 'efectivo',
    },
  });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  pedidosCreados.push(r.data.id);
  assert.equal(r.data.tipo, 'domicilio');
  assert.equal(r.data.direccion_alternativa, DIRECCION_CUBIERTA);
});

// ── 3) cliente_id validado / identificador obligatorio ──────────────────
test('POST /pedidos: rechaza un cliente_id que no existe', async () => {
  const r = await api('/pedidos', {
    method: 'POST',
    body: { cliente_id: 999999999, tipo: 'local', local_id: localA, total: 4000, items: [], origen: 'admin', pago: 'nequi' },
  });
  assert.equal(r.status, 400, JSON.stringify(r.data));
  assert.match(r.data.error, /cliente.*no existe/i);
});

test('POST /pedidos: acepta un cliente_id que SÍ existe (cliente registrado)', async () => {
  const r = await api('/pedidos', {
    method: 'POST',
    body: { cliente_id: clienteId, tipo: 'local', local_id: localA, total: 4000, items: [], origen: 'admin', pago: 'nequi' },
  });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  pedidosCreados.push(r.data.id);
  assert.equal(r.data.cliente_id, clienteId);
});

test('POST /pedidos: sin cliente_id Y sin nombre (cliente) — pedido totalmente anónimo — se rechaza', async () => {
  const r = await api('/pedidos', {
    method: 'POST',
    body: { tipo: 'local', local_id: localA, total: 4000, items: [], origen: 'admin', pago: 'nequi' },
  });
  assert.equal(r.status, 400, JSON.stringify(r.data));
  assert.match(r.data.error, /anónimo|nombre/i);
});

test('POST /pedidos: sin cliente_id, CON nombre pero SIN alias — se rechaza (el alias también es obligatorio en ese caso)', async () => {
  const r = await api('/pedidos', {
    method: 'POST',
    body: { cliente: 'Mesa 5', tipo: 'local', local_id: localA, total: 4000, items: [], origen: 'admin', pago: 'nequi' },
  });
  assert.equal(r.status, 400, JSON.stringify(r.data));
  assert.match(r.data.error, /alias/i);
});

test('POST /pedidos: sin cliente_id, CON nombre Y alias, se acepta', async () => {
  const r = await api('/pedidos', {
    method: 'POST',
    body: { cliente: 'Mesa 5', alias: `Mesa 5 - ${Date.now()}`, tipo: 'local', local_id: localA, total: 4000, items: [], origen: 'admin', pago: 'nequi' },
  });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  pedidosCreados.push(r.data.id);
  assert.equal(r.data.cliente, 'Mesa 5');
  assert.ok(r.data.alias);
});

test('POST /pedidos: un cliente_id válido NO necesita alias (ya tiene identificador propio)', async () => {
  const r = await api('/pedidos', {
    method: 'POST',
    body: { cliente_id: clienteId, tipo: 'local', local_id: localA, total: 4000, items: [], origen: 'admin', pago: 'nequi' },
  });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  pedidosCreados.push(r.data.id);
  assert.equal(r.data.alias, null);
});

test('POST /pedidos: rechaza un alias YA EN USO por otro pedido activo (mismo nombre, dos mesas)', async () => {
  const sufijo = Date.now();
  const primero = await api('/pedidos', {
    method: 'POST',
    body: { cliente: 'Juan', alias: `Juan - mesa 3 - ${sufijo}`, tipo: 'local', local_id: localA, total: 4000, items: [], origen: 'admin', pago: 'nequi' },
  });
  assert.equal(primero.status, 201, JSON.stringify(primero.data));
  pedidosCreados.push(primero.data.id);

  // Mismo alias exacto (mismo texto, distinto casing/espacios) mientras
  // el primero sigue activo (no entregado ni cancelado) → 409.
  const segundo = await api('/pedidos', {
    method: 'POST',
    body: { cliente: 'Juan', alias: `  JUAN - MESA 3 - ${sufijo}  `, tipo: 'local', local_id: localA, total: 4000, items: [], origen: 'admin', pago: 'nequi' },
  });
  assert.equal(segundo.status, 409, JSON.stringify(segundo.data));
  assert.match(segundo.data.error, /alias/i);

  // Un alias DISTINTO para el mismo nombre "Juan" sí se acepta.
  const tercero = await api('/pedidos', {
    method: 'POST',
    body: { cliente: 'Juan', alias: `Juan - ventana - ${sufijo}`, tipo: 'local', local_id: localA, total: 4000, items: [], origen: 'admin', pago: 'nequi' },
  });
  assert.equal(tercero.status, 201, JSON.stringify(tercero.data));
  pedidosCreados.push(tercero.data.id);
});

test('POST /pedidos: un alias vuelve a estar libre una vez el pedido que lo usaba queda entregado', async () => {
  const alias = `Ana - domicilio - ${Date.now()}`;
  const primero = await api('/pedidos', {
    method: 'POST',
    body: {
      cliente: 'Ana', alias, tipo: 'local', local_id: localA, origen: 'admin',
      pago: 'nequi', comprobante_img: `data:text/plain;base64,alias-libre-${Date.now()}`, total: 3000, items: [],
    },
  });
  assert.equal(primero.status, 201, JSON.stringify(primero.data));
  pedidosCreados.push(primero.data.id);

  await api(`/pedidos/${primero.data.id}/comprobante/aprobar`, { method: 'PATCH', token: tokenAdmin });
  await api(`/pedidos/${primero.data.id}/estado`, { method: 'PATCH', token: tokenAdmin, body: { estado: 'entregado' } });

  const segundo = await api('/pedidos', {
    method: 'POST',
    body: { cliente: 'Otra Ana', alias, tipo: 'local', local_id: localA, total: 3500, items: [], origen: 'admin', pago: 'nequi' },
  });
  assert.equal(segundo.status, 201, JSON.stringify(segundo.data));
  pedidosCreados.push(segundo.data.id);
});
