// ─────────────────────────────────────────────────────────────────────────
//  Tests de integración: factura del pedido (GET /pedidos/:id) y estado
//  "devuelto" al aprobar una devolución — sin romper el estado principal
//  del pedido/la venta cuando la devolución es PARCIAL.
// ─────────────────────────────────────────────────────────────────────────
// Bug real que esto cubre: al aprobar CUALQUIER devolución (aunque fuera
// de un solo producto entre varios — tipo='parcial'), el backend marcaba
// la VENTA COMPLETA del pedido como 'devuelto', y el pedido/factura no
// tenía ningún campo que dijera qué se había devuelto. Ahora:
//   • GET /pedidos/:id (la factura) trae "estado_devolucion" separado de
//     "estado" y "estado_pago", más "cantidadDevuelta"/"devuelto" por
//     cada línea de "productos".
//   • La venta solo pasa a 'devuelto' cuando lo devuelto cubre el pedido
//     COMPLETO (sumando todas las devoluciones aprobadas de ese pedido).
//
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

// Crea un pedido con 2 líneas y lo marca 'entregado' (genera la venta
// real). Usa tipo='local' + nequi (con comprobante ya aprobado) en vez de
// efectivo: efectivo ya no aplica a tipo='local' (ver
// pedidos-metodo-pago.test.js) y domicilio exigiría geocodificar una
// dirección real — nada de eso es lo que este archivo prueba (factura y
// devoluciones), así que se evita esa dependencia externa acá.
const crearPedidoEntregado = async (sufijo) => {
  const creado = await api('/pedidos', {
    method: 'POST',
    body: {
      cliente: `Cliente factura ${sufijo}`, alias: `alias-factura-${sufijo}`, tipo: 'local', local_id: localA, origen: 'admin',
      pago: 'nequi', comprobante_img: `data:text/plain;base64,factura-${sufijo}`,
      total: 13000,
      items: [
        { id: `prod-a-${sufijo}`, nombre: 'Café', precio: 5000, cantidad: 2 },
        { id: `prod-b-${sufijo}`, nombre: 'Jugo', precio: 3000, cantidad: 1 },
      ],
    },
  });
  assert.equal(creado.status, 201, JSON.stringify(creado.data));
  pedidosCreados.push(creado.data.id);
  const aprobar = await api(`/pedidos/${creado.data.id}/comprobante/aprobar`, { method: 'PATCH', token: tokenAdmin });
  assert.equal(aprobar.status, 200, JSON.stringify(aprobar.data));
  const entregado = await api(`/pedidos/${creado.data.id}/estado`, {
    method: 'PATCH', token: tokenAdmin, body: { estado: 'entregado' },
  });
  assert.equal(entregado.status, 200, JSON.stringify(entregado.data));
  return creado.data.id;
};

const ventaDelPedido = async (pedidoId) => {
  const ventas = await api('/ventas', { token: tokenAdmin });
  return ventas.data.find((v) => v.pedido_id === pedidoId || v.id_pedido === pedidoId);
};

test('GET /pedidos/:id (factura): trae productos con precio/cantidad, total, y estado_pago/estado_devolucion separados de estado', async () => {
  const id = await crearPedidoEntregado(Date.now());
  const factura = await api(`/pedidos/${id}`, { token: tokenAdmin });
  assert.equal(factura.status, 200, JSON.stringify(factura.data));
  assert.equal(factura.data.total, 13000);
  assert.ok(Array.isArray(factura.data.productos));
  assert.equal(factura.data.productos.length, 2);
  assert.equal(factura.data.productos[0].precio, 5000);
  assert.equal(factura.data.productos[0].cantidad, 2);
  assert.equal(factura.data.estado, 'entregado');
  assert.ok('estado_pago' in factura.data);
  assert.equal(factura.data.estado_devolucion, 'ninguna', 'sin ninguna devolución todavía');
  assert.equal(factura.data.productos[0].devuelto, false);
});

test('Devolución PARCIAL aprobada: el pedido/factura marca SOLO la línea devuelta, la venta sigue "vendido"', async () => {
  const id = await crearPedidoEntregado(Date.now() + '-parcial');

  // Devuelve 1 de las 2 unidades de "Café" (item_index 0) — parcial.
  const dev = await api('/devoluciones', {
    method: 'POST', token: tokenAdmin,
    body: { pedido_id: id, motivo: 'Cliente pidió una de más por error', items: [{ item_index: 0, cantidad: 1 }] },
  });
  assert.equal(dev.status, 201, JSON.stringify(dev.data));
  // OJO: "devoluciones.tipo" (preexistente) se calcula por CANTIDAD de
  // ítems solicitados en la devolución (>1 ítem = 'parcial'), no por si la
  // cantidad cubre o no lo comprado — es un campo distinto, más simple,
  // que ya existía antes de esta ronda. El campo que SÍ refleja cobertura
  // real es "estado_devolucion" (nuevo), que se prueba abajo.

  const aprobar = await api(`/devoluciones/${dev.data.id}/estado`, {
    method: 'PATCH', token: tokenAdmin, body: { estado: 'aprobada' },
  });
  assert.equal(aprobar.status, 200, JSON.stringify(aprobar.data));
  // La respuesta de aprobar ya trae el pedido actualizado adjunto.
  assert.equal(aprobar.data.pedido.estado_devolucion, 'parcial');
  assert.equal(aprobar.data.pedido.estado, 'entregado', 'el estado del PEDIDO no se toca por una devolución');

  const factura = await api(`/pedidos/${id}`, { token: tokenAdmin });
  assert.equal(factura.data.estado_devolucion, 'parcial');
  assert.equal(factura.data.productos[0].cantidadDevuelta, 1);
  assert.equal(factura.data.productos[0].devuelto, true);
  assert.equal(factura.data.productos[1].cantidadDevuelta, 0);
  assert.equal(factura.data.productos[1].devuelto, false, 'el segundo producto NO se devolvió, no debe marcarse');

  const venta = await ventaDelPedido(id);
  assert.ok(venta, 'debe existir una venta para este pedido');
  assert.equal(venta.estado, 'vendido', 'una devolución PARCIAL no debe marcar la venta completa como devuelta');
});

test('Devolución TOTAL aprobada (cubre las 2 líneas): estado_devolucion="total" y la venta completa pasa a "devuelto"', async () => {
  const id = await crearPedidoEntregado(Date.now() + '-total');

  const dev = await api('/devoluciones', {
    method: 'POST', token: tokenAdmin,
    body: {
      pedido_id: id, motivo: 'El cliente devolvió todo el pedido completo',
      items: [{ item_index: 0, cantidad: 2 }, { item_index: 1, cantidad: 1 }],
    },
  });
  assert.equal(dev.status, 201, JSON.stringify(dev.data));

  const aprobar = await api(`/devoluciones/${dev.data.id}/estado`, {
    method: 'PATCH', token: tokenAdmin, body: { estado: 'aprobada' },
  });
  assert.equal(aprobar.status, 200, JSON.stringify(aprobar.data));
  assert.equal(aprobar.data.pedido.estado_devolucion, 'total');

  const factura = await api(`/pedidos/${id}`, { token: tokenAdmin });
  assert.equal(factura.data.estado_devolucion, 'total');
  assert.equal(factura.data.productos[0].devuelto, true);
  assert.equal(factura.data.productos[1].devuelto, true);

  const venta = await ventaDelPedido(id);
  assert.equal(venta.estado, 'devuelto', 'una devolución TOTAL sí debe marcar la venta completa como devuelta');
});

test('Rechazar una devolución no dispara "devuelto" en ningún lado', async () => {
  const id = await crearPedidoEntregado(Date.now() + '-rechazo');

  const dev = await api('/devoluciones', {
    method: 'POST', token: tokenAdmin,
    body: { pedido_id: id, motivo: 'Solicitud de devolución que será rechazada', items: [{ item_index: 0, cantidad: 1 }] },
  });
  assert.equal(dev.status, 201, JSON.stringify(dev.data));

  const rechazar = await api(`/devoluciones/${dev.data.id}/estado`, {
    method: 'PATCH', token: tokenAdmin, body: { estado: 'rechazada', motivo_rechazo: 'El producto no presenta ningún problema real.' },
  });
  assert.equal(rechazar.status, 200, JSON.stringify(rechazar.data));
  assert.equal(rechazar.data.pedido.estado_devolucion, 'ninguna', 'una devolución RECHAZADA no cuenta para estado_devolucion');

  const venta = await ventaDelPedido(id);
  assert.equal(venta.estado, 'vendido');
});
