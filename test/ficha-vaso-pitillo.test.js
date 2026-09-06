// ─────────────────────────────────────────────────────────────────────────
//  Tests de integración: descuento de VASO y PITILLO al vender (requisito 4)
// ─────────────────────────────────────────────────────────────────────────
// Vaso y Pitillo NO son un tipo especial de insumo (requisito 3): son
// insumos normales del módulo de Insumos, con su propia unidad de medida
// (Vaso → 'oz', Pitillo → 'unidad'). Una ficha técnica los referencia por
// vaso_insumo_id/pitillo_insumo_id + su cantidad, y al vender deben
// descontarse del stock exactamente igual que cualquier otro insumo de la
// receta — solo en el local donde ocurrió la venta.
//
// Mismos requisitos para correrlos que test/inventario-por-local.test.js:
// servidor corriendo (npm run dev/start), admin sembrado, 2+ locales
// Activos. Ejecutar: npm test
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const BASE = process.env.TEST_BASE_URL || 'http://localhost:4000/api';
const ADMIN_USER = process.env.TEST_ADMIN_USER || 'Admin_Sicaber';
const ADMIN_PASS = process.env.TEST_ADMIN_PASS || 'admin2024#';

let token;
let localA;
let vasoId, vasoNombre;
let pitilloId, pitilloNombre;
let ingredienteId, ingredienteNombre;
let productoId, productoNombre;
let fichaId;

const api = async (path, { method = 'GET', body } = {}) => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
};

const filaDelLocal = (respuestaInsumo, localId) =>
  respuestaInsumo.data.porLocal.find((f) => f.localId === localId);

before(async () => {
  const login = await api('/auth/login', { method: 'POST', body: { username: ADMIN_USER, password: ADMIN_PASS } });
  assert.equal(login.status, 200, JSON.stringify(login.data));
  token = login.data.token;

  const listado = await api('/locales/todos');
  const activos = listado.data.filter((l) => l.estado === 'Activo');
  assert.ok(activos.length >= 1, 'se necesita al menos 1 local Activo');
  localA = activos[0].id;

  const sufijo = Date.now();
  vasoNombre = `Vaso test vaso-pitillo ${sufijo}`;
  pitilloNombre = `Pitillo test vaso-pitillo ${sufijo}`;
  ingredienteNombre = `Ingrediente test vaso-pitillo ${sufijo}`;

  // Vaso y pitillo: insumos NORMALES, cada uno con su unidad real (oz/unidad
  // — requisito 3), con stock de sobra en el local de prueba.
  const vaso = await api('/insumos', { method: 'POST', body: { nombre: vasoNombre, unidadMedida: 'oz', stockMinimo: 1, stockActual: 50, local_id: localA } });
  assert.equal(vaso.status, 201, JSON.stringify(vaso.data));
  vasoId = vaso.data.id;

  const pitillo = await api('/insumos', { method: 'POST', body: { nombre: pitilloNombre, unidadMedida: 'unidad', stockMinimo: 1, stockActual: 50, local_id: localA } });
  assert.equal(pitillo.status, 201, JSON.stringify(pitillo.data));
  pitilloId = pitillo.data.id;

  const ingrediente = await api('/insumos', { method: 'POST', body: { nombre: ingredienteNombre, unidadMedida: 'kg', stockMinimo: 1, stockActual: 50, local_id: localA } });
  assert.equal(ingrediente.status, 201, JSON.stringify(ingrediente.data));
  ingredienteId = ingrediente.data.id;

  productoNombre = `Producto test vaso-pitillo ${sufijo}`;
  const prod = await api('/productos', { method: 'POST', body: { nombre: productoNombre, categoria: 'Bebidas frías', precio: 12000 } });
  assert.equal(prod.status, 201, JSON.stringify(prod.data));
  productoId = prod.data.id;

  // Ficha técnica CON vaso y pitillo: 1 kg de ingrediente, 8 oz de vaso,
  // 1 unidad de pitillo (lleva_pitillo=true).
  const ficha = await api('/fichas-tecnicas', {
    method: 'POST',
    body: {
      id_producto: productoId, porciones: 1, tiempo_prep: 5, costo_estimado: 1000,
      preparacion: 'Preparación de prueba para el test de vaso y pitillo.',
      insumos: [{ id_insumo: ingredienteId, cantidad: 1 }],
      vaso_insumo_id: vasoId, cantidad_vaso: 8,
      lleva_pitillo: true, pitillo_insumo_id: pitilloId, cantidad_pitillo: 1,
    },
  });
  assert.equal(ficha.status, 201, JSON.stringify(ficha.data));
  fichaId = ficha.data.id;
});

after(async () => {
  try { if (fichaId) await api(`/fichas-tecnicas/${fichaId}`, { method: 'DELETE' }); } catch {}
  try {
    if (productoId) {
      const del = await api(`/productos/${productoId}`, { method: 'DELETE' });
      if (del.status !== 200) await api(`/productos/${productoId}`, { method: 'PUT', body: { nombre: productoNombre, categoria: 'Bebidas frías', precio: 12000, estado: 'Inactivo' } });
    }
  } catch {}
  for (const id of [vasoId, pitilloId, ingredienteId]) {
    try {
      const del = await api(`/insumos/${id}`, { method: 'DELETE' });
      if (del.status !== 200) await api(`/insumos/${id}`, { method: 'PUT', body: { unidadMedida: del.data?.unidadMedida, estado: 'Inactivo' } });
    } catch {}
  }
});

test('la ficha técnica guarda vaso y pitillo correctamente', async () => {
  const detalle = await api(`/fichas-tecnicas/${fichaId}`);
  assert.equal(detalle.status, 200);
  assert.equal(detalle.data.vaso_insumo_id, vasoId);
  assert.equal(Number(detalle.data.cantidad_vaso), 8);
  assert.equal(detalle.data.lleva_pitillo, true);
  assert.equal(detalle.data.pitillo_insumo_id, pitilloId);
  assert.equal(Number(detalle.data.cantidad_pitillo), 1);
});

test('lleva_pitillo=false obliga a que pitillo_insumo_id/cantidad_pitillo queden en null', async () => {
  const r = await api(`/fichas-tecnicas/${fichaId}`, {
    method: 'PUT',
    body: {
      id_producto: productoId, porciones: 1, tiempo_prep: 5, costo_estimado: 1000,
      preparacion: 'Preparación de prueba para el test de vaso y pitillo.',
      insumos: [{ id_insumo: ingredienteId, cantidad: 1 }],
      vaso_insumo_id: vasoId, cantidad_vaso: 8,
      lleva_pitillo: false, pitillo_insumo_id: pitilloId, cantidad_pitillo: 1, // se mandan igual: deben ignorarse
    },
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.lleva_pitillo, false);
  assert.equal(r.data.pitillo_insumo_id, null);
  assert.equal(r.data.cantidad_pitillo, null);

  // se restaura para el resto de los tests de este archivo
  const restaurar = await api(`/fichas-tecnicas/${fichaId}`, {
    method: 'PUT',
    body: {
      id_producto: productoId, porciones: 1, tiempo_prep: 5, costo_estimado: 1000,
      preparacion: 'Preparación de prueba para el test de vaso y pitillo.',
      insumos: [{ id_insumo: ingredienteId, cantidad: 1 }],
      vaso_insumo_id: vasoId, cantidad_vaso: 8,
      lleva_pitillo: true, pitillo_insumo_id: pitilloId, cantidad_pitillo: 1,
    },
  });
  assert.equal(restaurar.status, 200, JSON.stringify(restaurar.data));
});

test('una venta descuenta el vaso y el pitillo del stock del local correcto', async () => {
  const antesVaso = await api(`/insumos/${vasoId}`);
  const antesPitillo = await api(`/insumos/${pitilloId}`);
  const antesIngrediente = await api(`/insumos/${ingredienteId}`);
  const stockAntesVaso = Number(filaDelLocal(antesVaso, localA).stock);
  const stockAntesPitillo = Number(filaDelLocal(antesPitillo, localA).stock);
  const stockAntesIngrediente = Number(filaDelLocal(antesIngrediente, localA).stock);

  const pedido = await api('/pedidos', {
    method: 'POST',
    body: {
      cliente: 'Cliente test vaso-pitillo', tipo: 'local', pago: 'efectivo', total: 12000,
      items: [{ id: productoId, nombre: productoNombre, cantidad: 1, precio: 12000 }],
      origen: 'admin', local_id: localA,
    },
  });
  assert.equal(pedido.status, 201, JSON.stringify(pedido.data));
  const pedidoId = pedido.data.id;

  for (const estado of ['en_proceso', 'en_camino', 'entregado']) {
    const r = await api(`/pedidos/${pedidoId}/estado`, { method: 'PATCH', body: { estado } });
    assert.equal(r.status, 200, `PATCH estado=${estado} → ${JSON.stringify(r.data)}`);
  }

  const despuesVaso = await api(`/insumos/${vasoId}`);
  const despuesPitillo = await api(`/insumos/${pitilloId}`);
  const despuesIngrediente = await api(`/insumos/${ingredienteId}`);
  assert.equal(Number(filaDelLocal(despuesVaso, localA).stock), stockAntesVaso - 8, 'el vaso debe descontarse la cantidad_vaso de la ficha (8 oz)');
  assert.equal(Number(filaDelLocal(despuesPitillo, localA).stock), stockAntesPitillo - 1, 'el pitillo debe descontarse la cantidad_pitillo de la ficha (1 unidad)');
  assert.equal(Number(filaDelLocal(despuesIngrediente, localA).stock), stockAntesIngrediente - 1, 'el ingrediente normal se sigue descontando igual que siempre');

  // Ningún otro local debe verse afectado (requisito 3, ya cubierto en el
  // otro archivo de tests — acá se confirma también para vaso/pitillo).
  const otrosLocalesVaso = despuesVaso.data.porLocal.filter((f) => f.localId !== localA);
  for (const f of otrosLocalesVaso) assert.equal(Number(f.stock), 0, 'otro local no debería tener movimiento de este vaso de prueba');
});
