// ─────────────────────────────────────────────────────────────────────────
//  Test de regresión: POST /insumos con 400 falso-positivo cuando no hace
//  falta un "local_id" explícito
// ─────────────────────────────────────────────────────────────────────────
// Bug real (bloqueante): tras las rondas de "stock inicial validado contra
// locales seleccionados" y "permisos de local para admin/superadmin",
// POST /insumos exigía resolver un "local_id" SIEMPRE — incluso cuando no
// había ninguna cantidad inicial que ubicar y "todosLosLocales"/
// "localesSeleccionados" ya contestaban del todo "en qué locales existe
// el insumo". Un Administrador/Superadministrador (sin local fijo propio)
// que solo mandaba "localesSeleccionados" recibía un 400 pidiendo elegir
// un local que ya había elegido, por otra vía — cualquier alta de insumo
// sin local_id explícito quedaba bloqueada.
//
// Ejecutar: npm test
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
require('dotenv').config();
const { Pool } = require('pg');

const BASE = process.env.TEST_BASE_URL || 'http://localhost:4000/api';
const ADMIN_USER = process.env.TEST_ADMIN_USER || 'Admin_Sicaber';
const ADMIN_PASS = process.env.TEST_ADMIN_PASS || 'admin2024#';

const pool = new Pool({
  host: process.env.DB_HOST, port: Number(process.env.DB_PORT), database: process.env.DB_NAME,
  user: process.env.DB_USER, password: process.env.DB_PASSWORD,
});

let token;
let localA, localB;
const insumosCreados = [];

const api = async (path, { method = 'GET', body } = {}) => {
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
  token = login.data.token;

  const listado = await api('/locales/todos');
  const activos = listado.data.filter((l) => l.estado === 'Activo');
  assert.ok(activos.length >= 2, 'se necesitan al menos 2 locales Activos');
  localA = activos[0].id;
  localB = activos[1].id;
});

after(async () => {
  for (const id of insumosCreados) {
    try { await api(`/insumos/${id}`, { method: 'DELETE' }); } catch {}
  }
  await pool.end();
});

test('Caso 1 — sin stock inicial, con un solo local (local_id): funciona', async () => {
  const r = await api('/insumos', {
    method: 'POST',
    body: { nombre: `Insumo test caso1 ${Date.now()}`, unidadMedida: 'kg', stockMinimo: 1, local_id: localA },
  });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  insumosCreados.push(r.data.id);
  const fila = r.data.porLocal.find((f) => f.localId === localA);
  assert.equal(fila.activo, true);
  assert.equal(Number(fila.stock), 0);
});

test('Caso 2 — sin stock inicial, con VARIOS locales seleccionados y SIN local_id: funciona (antes daba 400)', async () => {
  const r = await api('/insumos', {
    method: 'POST',
    body: { nombre: `Insumo test caso2 ${Date.now()}`, unidadMedida: 'kg', stockMinimo: 1, localesSeleccionados: [localA, localB] },
  });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  insumosCreados.push(r.data.id);
  const filaA = r.data.porLocal.find((f) => f.localId === localA);
  const filaB = r.data.porLocal.find((f) => f.localId === localB);
  assert.equal(filaA.activo, true);
  assert.equal(filaB.activo, true);
  assert.equal(Number(filaA.stock), 0);
  assert.equal(Number(filaB.stock), 0);
});

test('Caso 3 — con stock inicial, apuntando a uno de los locales seleccionados: funciona sin local_id redundante', async () => {
  const r = await api('/insumos', {
    method: 'POST',
    body: { nombre: `Insumo test caso3 ${Date.now()}`, unidadMedida: 'kg', stockMinimo: 1, stockActual: 5, localesSeleccionados: [localA] },
  });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  insumosCreados.push(r.data.id);
  const fila = r.data.porLocal.find((f) => f.localId === localA);
  assert.equal(fila.activo, true);
  assert.equal(Number(fila.stock), 5);
});

test('Caso 3b — con stock inicial y VARIOS locales seleccionados: sigue exigiendo local_id explícito (ambiguo de verdad)', async () => {
  const r = await api('/insumos', {
    method: 'POST',
    body: { nombre: `Insumo test caso3b ${Date.now()}`, unidadMedida: 'kg', stockMinimo: 1, stockActual: 5, localesSeleccionados: [localA, localB] },
  });
  assert.equal(r.status, 400, JSON.stringify(r.data));
  assert.equal(r.data.campo, 'local_id');
});

test('Caso 4 — "Todos los locales" marcado, sin stock, sin local_id: funciona', async () => {
  const r = await api('/insumos', {
    method: 'POST',
    body: { nombre: `Insumo test caso4 ${Date.now()}`, unidadMedida: 'kg', stockMinimo: 1, todosLosLocales: true },
  });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  insumosCreados.push(r.data.id);
  assert.ok(r.data.porLocal.every((f) => f.activo === true));
});

test('Todo 400 de POST /insumos devuelve "campo" además de "error"', async () => {
  const sinNombre = await api('/insumos', { method: 'POST', body: { unidadMedida: 'kg', stockMinimo: 1, local_id: localA } });
  assert.equal(sinNombre.status, 400);
  assert.equal(sinNombre.data.campo, 'nombre');

  const sinMinimo = await api('/insumos', { method: 'POST', body: { nombre: `Insumo test sin minimo ${Date.now()}`, unidadMedida: 'kg', local_id: localA } });
  assert.equal(sinMinimo.status, 400);
  assert.equal(sinMinimo.data.campo, 'stockMinimo');
});

// ── Bug nuevo (esta ronda): stockActual=0 EXPLÍCITO (no omitido) ──────────
// Un <input type="number"> controlado suele arrancar en 0, no en "" — si
// el formulario manda `stockActual: 0` en vez de omitir el campo, antes
// eso se trataba como "SÍ hay cantidad inicial" y exigía un local_id que
// no hacía ninguna falta (0 es 0 en cualquier local). El bug se reportó
// como "el front sospecha que dejó de mandar el local del stock inicial"
// — la causa real era que SÍ lo mandaba (indirectamente, como 0).
test('stockActual=0 explícito + varios locales seleccionados, sin local_id: funciona (0 no exige local recipiente)', async () => {
  const r = await api('/insumos', {
    method: 'POST',
    body: { nombre: `Insumo test stock0 varios ${Date.now()}`, unidadMedida: 'kg', stockMinimo: 1, stockActual: 0, localesSeleccionados: [localA, localB] },
  });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  insumosCreados.push(r.data.id);
  assert.equal(r.data.observaciones, null, 'un stock de 0 no es "cantidad existente": no debe autocompletar observaciones');
});

test('stockActual=0 explícito + todosLosLocales, sin local_id: funciona', async () => {
  const r = await api('/insumos', {
    method: 'POST',
    body: { nombre: `Insumo test stock0 todos ${Date.now()}`, unidadMedida: 'kg', stockMinimo: 1, stockActual: 0, todosLosLocales: true },
  });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  insumosCreados.push(r.data.id);
});

test('stockActual=0 explícito no genera movimiento de inventario (no hay cambio de stock real)', async () => {
  const r = await api('/insumos', {
    method: 'POST',
    body: { nombre: `Insumo test stock0 sin movimiento ${Date.now()}`, unidadMedida: 'kg', stockMinimo: 1, stockActual: 0, local_id: localA },
  });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  insumosCreados.push(r.data.id);
  const mov = await pool.query('SELECT COUNT(*) FROM movimientos_inventario WHERE insumo_id=$1', [r.data.id]);
  assert.equal(Number(mov.rows[0].count), 0, 'un stockActual=0 no representa ningún cambio real de stock: no debe dejar rastro en el kardex');
});
