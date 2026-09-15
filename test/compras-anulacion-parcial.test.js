// ─────────────────────────────────────────────────────────────────────────
//  PATCH /compras/:id/anular: anulación PARCIAL por insumo — revierte
//  SOLO el stock de los items indicados, dejando el resto de la compra
//  intacta. Sin "items" en el body, sigue anulando TODO (compatibilidad).
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
let proveedorId;
let insumoAId, insumoANombre, insumoBId, insumoBNombre;
const sufijo = Date.now();
const comprasCreadas = [];
const insumosCreados = [];

const api = async (path, { method = 'GET', token, body } = {}) => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
};

const stockDe = async (insumoId, localId) => {
  const r = await api(`/insumos/${insumoId}`, { token: tokenAdmin });
  const fila = r.data.porLocal.find((f) => f.localId === localId);
  return Number(fila?.stock) || 0;
};

before(async () => {
  const login = await api('/auth/login', { method: 'POST', body: { username: ADMIN_USER, password: ADMIN_PASS } });
  assert.equal(login.status, 200, JSON.stringify(login.data));
  tokenAdmin = login.data.token;

  const listado = await api('/locales/todos', { token: tokenAdmin });
  const activos = listado.data.filter((l) => l.estado === 'Activo');
  assert.ok(activos.length >= 1, 'se necesita al menos 1 local Activo');
  localA = activos[0].id;

  const prov = await api('/proveedores', {
    method: 'POST', token: tokenAdmin,
    body: { nombre: `Proveedor test anulacion parcial ${sufijo}`, tipoPersona: 'Juridica' },
  });
  assert.equal(prov.status, 201, JSON.stringify(prov.data));
  proveedorId = prov.data.id;

  const insA = await api('/insumos', {
    method: 'POST', token: tokenAdmin,
    body: { nombre: `Insumo A anulacion parcial ${sufijo}`, unidadMedida: 'kg', stockMinimo: 1, local_id: localA },
  });
  assert.equal(insA.status, 201, JSON.stringify(insA.data));
  insumoAId = insA.data.id; insumoANombre = insA.data.nombre;
  insumosCreados.push(insumoAId);

  const insB = await api('/insumos', {
    method: 'POST', token: tokenAdmin,
    body: { nombre: `Insumo B anulacion parcial ${sufijo}`, unidadMedida: 'kg', stockMinimo: 1, local_id: localA },
  });
  assert.equal(insB.status, 201, JSON.stringify(insB.data));
  insumoBId = insB.data.id; insumoBNombre = insB.data.nombre;
  insumosCreados.push(insumoBId);
});

after(async () => {
  for (const id of insumosCreados) { try { await api(`/insumos/${id}`, { method: 'DELETE', token: tokenAdmin }); } catch {} }
});

test('Anulación PARCIAL: revierte solo el insumo indicado, deja el otro intacto, y va acumulando hasta cubrir todo', async () => {
  const stockAAntes = await stockDe(insumoAId, localA);
  const stockBAntes = await stockDe(insumoBId, localA);

  const compra = await api('/compras', {
    method: 'POST', token: tokenAdmin,
    body: {
      proveedorId, local_id: localA, fecha: new Date().toISOString().slice(0, 10),
      total: 20000, descuento: 0,
      items: [
        { insumo: insumoANombre, cantidad: 10, precioUnitario: 1000 },
        { insumo: insumoBNombre, cantidad: 5, precioUnitario: 2000 },
      ],
    },
  });
  assert.equal(compra.status, 201, JSON.stringify(compra.data));
  const compraId = compra.data.id;
  comprasCreadas.push(compraId);

  assert.equal(await stockDe(insumoAId, localA), stockAAntes + 10);
  assert.equal(await stockDe(insumoBId, localA), stockBAntes + 5);

  // Anular solo 4 de las 10 de A.
  const anular1 = await api(`/compras/${compraId}/anular`, {
    method: 'PATCH', token: tokenAdmin,
    body: { motivo: 'Se dañaron 4 unidades del insumo A', items: [{ insumo_id: insumoAId, cantidad: 4 }] },
  });
  assert.equal(anular1.status, 200, JSON.stringify(anular1.data));
  assert.equal(anular1.data.estado, 'anulada_parcial', 'con solo parte de A anulado, la compra queda parcial');
  assert.equal(await stockDe(insumoAId, localA), stockAAntes + 10 - 4, 'A baja solo lo anulado');
  assert.equal(await stockDe(insumoBId, localA), stockBAntes + 5, 'B no se toca');

  // Anular el RESTO de A (las 6 que quedaban) — B sigue intacto, así que
  // la compra debe seguir "parcial", no "anulada" todavía.
  const anular2 = await api(`/compras/${compraId}/anular`, {
    method: 'PATCH', token: tokenAdmin,
    body: { motivo: 'Se dañó el resto de A también', items: [{ insumo_id: insumoAId, cantidad: 6 }] },
  });
  assert.equal(anular2.status, 200, JSON.stringify(anular2.data));
  assert.equal(anular2.data.estado, 'anulada_parcial', 'B todavía no se anuló, sigue parcial');
  assert.equal(await stockDe(insumoAId, localA), stockAAntes, 'A queda exactamente como antes de la compra');

  // Anular B (todo lo que queda) — ahora SÍ debe quedar 'anulada' completa.
  const anular3 = await api(`/compras/${compraId}/anular`, {
    method: 'PATCH', token: tokenAdmin,
    body: { motivo: 'Proveedor confirmó que B tampoco llegó', items: [{ insumo_id: insumoBId, cantidad: 5 }] },
  });
  assert.equal(anular3.status, 200, JSON.stringify(anular3.data));
  assert.equal(anular3.data.estado, 'anulada', 'con A y B completamente revertidos, la compra queda anulada del todo');
  assert.equal(await stockDe(insumoBId, localA), stockBAntes);
});

test('Anulación PARCIAL: rechaza anular más de lo que queda pendiente para un insumo', async () => {
  const compra = await api('/compras', {
    method: 'POST', token: tokenAdmin,
    body: {
      proveedorId, local_id: localA, fecha: new Date().toISOString().slice(0, 10),
      total: 5000, descuento: 0,
      items: [{ insumo: insumoANombre, cantidad: 5, precioUnitario: 1000 }],
    },
  });
  assert.equal(compra.status, 201, JSON.stringify(compra.data));
  comprasCreadas.push(compra.data.id);

  const r = await api(`/compras/${compra.data.id}/anular`, {
    method: 'PATCH', token: tokenAdmin,
    body: { motivo: 'Intento anular de más', items: [{ insumo_id: insumoAId, cantidad: 999 }] },
  });
  assert.equal(r.status, 400, JSON.stringify(r.data));
  assert.match(r.data.error, /pendientes de anular/i);

  // La compra NO debe haber quedado a medio anular por el intento fallido.
  const full = await api(`/compras/${compra.data.id}`, { token: tokenAdmin });
  assert.equal(full.data.estado, 'activa');
});

test('Anulación PARCIAL: rechaza un insumo que no forma parte de la compra', async () => {
  const compra = await api('/compras', {
    method: 'POST', token: tokenAdmin,
    body: {
      proveedorId, local_id: localA, fecha: new Date().toISOString().slice(0, 10),
      total: 5000, descuento: 0,
      items: [{ insumo: insumoANombre, cantidad: 5, precioUnitario: 1000 }],
    },
  });
  assert.equal(compra.status, 201, JSON.stringify(compra.data));
  comprasCreadas.push(compra.data.id);

  const r = await api(`/compras/${compra.data.id}/anular`, {
    method: 'PATCH', token: tokenAdmin,
    body: { motivo: 'Insumo equivocado', items: [{ insumo_id: insumoBId, cantidad: 1 }] },
  });
  assert.equal(r.status, 400, JSON.stringify(r.data));
  assert.match(r.data.error, /no forma parte de esta compra/i);
});

test('Anulación TOTAL (sin "items" en el body) sigue funcionando igual que siempre — compatibilidad', async () => {
  const stockAAntes = await stockDe(insumoAId, localA);
  const stockBAntes = await stockDe(insumoBId, localA);

  const compra = await api('/compras', {
    method: 'POST', token: tokenAdmin,
    body: {
      proveedorId, local_id: localA, fecha: new Date().toISOString().slice(0, 10),
      total: 15000, descuento: 0,
      items: [
        { insumo: insumoANombre, cantidad: 3, precioUnitario: 1000 },
        { insumo: insumoBNombre, cantidad: 2, precioUnitario: 2000 },
      ],
    },
  });
  assert.equal(compra.status, 201, JSON.stringify(compra.data));
  comprasCreadas.push(compra.data.id);

  const r = await api(`/compras/${compra.data.id}/anular`, {
    method: 'PATCH', token: tokenAdmin, body: { motivo: 'Anulación total, sin especificar items' },
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.estado, 'anulada');
  assert.equal(await stockDe(insumoAId, localA), stockAAntes, 'A vuelve exactamente a como estaba');
  assert.equal(await stockDe(insumoBId, localA), stockBAntes, 'B vuelve exactamente a como estaba');
});

test('No se puede volver a anular (ni total ni parcial) una compra ya completamente anulada', async () => {
  const compra = await api('/compras', {
    method: 'POST', token: tokenAdmin,
    body: {
      proveedorId, local_id: localA, fecha: new Date().toISOString().slice(0, 10),
      total: 1000, descuento: 0,
      items: [{ insumo: insumoANombre, cantidad: 1, precioUnitario: 1000 }],
    },
  });
  assert.equal(compra.status, 201, JSON.stringify(compra.data));
  comprasCreadas.push(compra.data.id);

  const anular = await api(`/compras/${compra.data.id}/anular`, { method: 'PATCH', token: tokenAdmin, body: { motivo: 'Anulación total' } });
  assert.equal(anular.status, 200, JSON.stringify(anular.data));
  assert.equal(anular.data.estado, 'anulada');

  const r = await api(`/compras/${compra.data.id}/anular`, { method: 'PATCH', token: tokenAdmin, body: { motivo: 'Intento repetido' } });
  assert.equal(r.status, 400, JSON.stringify(r.data));
  assert.match(r.data.error, /ya está anulada/i);
});
