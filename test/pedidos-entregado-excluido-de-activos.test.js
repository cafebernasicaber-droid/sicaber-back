// ─────────────────────────────────────────────────────────────────────────
//  Test de integración: un pedido 'entregado' deja de listarse como
//  "activo" en GET /pedidos y queda consultable desde GET /ventas (Ronda 29)
// ─────────────────────────────────────────────────────────────────────────
// Bug real: GET /pedidos (listado operativo de Cajero/Admin: "qué hay que
// atender") solo excluía un pedido cuando estado_devolucion==='total' — un
// pedido normal ya 'entregado' (sin ninguna devolución) seguía apareciendo
// ahí, mezclado con lo que de verdad falta atender. Ya tenía su fila en
// `ventas` desde que se marcó entregado (ver registrarVentaDePedido), así
// que el listado de Ventas siempre lo mostró correctamente — lo que
// faltaba era SACARLO del listado de pedidos activos.
// GET /pedidos/:id (factura) y GET /pedidos/mis-pedidos (historial propio
// del cliente) son rutas aparte y deliberadamente NO cambian: un pedido
// entregado debe seguir siendo consultable ahí.
// Ejecutar: npm test
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const BASE = process.env.TEST_BASE_URL || 'http://localhost:4000/api';
const ADMIN_USER = process.env.TEST_ADMIN_USER || 'Admin_Sicaber';
const ADMIN_PASS = process.env.TEST_ADMIN_PASS || 'admin2024#';

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

// tipo 'local' + nequi (con comprobante ya aprobado) — mismo criterio que
// pedidos-factura-devolucion.test.js: efectivo no aplica a tipo='local'
// (solo a domicilio), así que se evita esa dependencia acá.
const crearPedido = async (sufijo, estadoInicial) => {
  const creado = await api('/pedidos', {
    method: 'POST',
    body: {
      cliente: `Cliente ventas test ${sufijo}`, alias: `alias-ventas-${sufijo}`, tipo: 'local', local_id: localA, origen: 'admin',
      pago: 'nequi', comprobante_img: `data:text/plain;base64,ventas-${sufijo}`, total: 9000,
      items: [{ id: `prod-ventas-${sufijo}`, nombre: 'Café', precio: 9000, cantidad: 1 }],
    },
  });
  assert.equal(creado.status, 201, JSON.stringify(creado.data));
  pedidosCreados.push(creado.data.id);
  const aprobar = await api(`/pedidos/${creado.data.id}/comprobante/aprobar`, { method: 'PATCH', token: tokenAdmin });
  assert.equal(aprobar.status, 200, JSON.stringify(aprobar.data));
  if (estadoInicial) {
    const r = await api(`/pedidos/${creado.data.id}/estado`, { method: 'PATCH', token: tokenAdmin, body: { estado: estadoInicial } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
  }
  return creado.data.id;
};

test('un pedido "en_proceso" (activo, aún no entregado) SÍ aparece en GET /pedidos', async () => {
  const id = await crearPedido(Date.now() + '-activo', 'en_proceso');
  const listado = await api('/pedidos', { token: tokenAdmin });
  assert.equal(listado.status, 200, JSON.stringify(listado.data));
  assert.ok(listado.data.some((p) => p.id === id), 'un pedido activo debe listarse en /pedidos');
});

test('al marcar un pedido "entregado": desaparece de GET /pedidos (activos) pero sigue en GET /pedidos/:id', async () => {
  const id = await crearPedido(Date.now() + '-entregado', null);

  const entregar = await api(`/pedidos/${id}/estado`, { method: 'PATCH', token: tokenAdmin, body: { estado: 'entregado' } });
  assert.equal(entregar.status, 200, JSON.stringify(entregar.data));

  const listado = await api('/pedidos', { token: tokenAdmin });
  assert.equal(listado.status, 200, JSON.stringify(listado.data));
  assert.ok(!listado.data.some((p) => p.id === id), 'un pedido ya entregado NO debe listarse como "activo" en /pedidos');

  const factura = await api(`/pedidos/${id}`, { token: tokenAdmin });
  assert.equal(factura.status, 200, JSON.stringify(factura.data));
  assert.equal(factura.data.estado, 'entregado', 'la factura/detalle por id debe seguir mostrando el pedido entregado');
});

test('un pedido "entregado" queda consultable en GET /ventas', async () => {
  const id = await crearPedido(Date.now() + '-en-ventas', 'entregado');

  const ventas = await api('/ventas', { token: tokenAdmin });
  assert.equal(ventas.status, 200, JSON.stringify(ventas.data));
  const venta = ventas.data.find((v) => v.pedido_id === id || v.id_pedido === id);
  assert.ok(venta, 'debe existir una venta consultable para el pedido recién entregado');
  assert.equal(venta.estado, 'vendido');
  assert.equal(Number(venta.total), 9000);
});
