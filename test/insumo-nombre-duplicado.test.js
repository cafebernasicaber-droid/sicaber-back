// ─────────────────────────────────────────────────────────────────────────
//  El nombre de insumo es único GLOBALMENTE. Antes, chocar con un insumo
//  existente devolvía un error muerto ("Ya existe un insumo con ese
//  nombre.") sin decir CUÁL insumo ni en qué locales está activo — el
//  usuario que intentaba dar de alta "leche" para un segundo local no
//  tenía forma de saber que lo que debía hacer era activarla ahí (PUT
//  /insumos/:id/locales/:localId), no crearla de nuevo.
// ─────────────────────────────────────────────────────────────────────────
// Ejecutar: npm test
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const BASE = process.env.TEST_BASE_URL || 'http://localhost:4000/api';
const ADMIN_USER = process.env.TEST_ADMIN_USER || 'Admin_Sicaber';
const ADMIN_PASS = process.env.TEST_ADMIN_PASS || 'admin2024#';

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
});

test('POST /insumos con nombre duplicado devuelve el id del existente y en qué locales está activo', async () => {
  const nombre = `Leche test duplicado ${Date.now()}`;

  const r1 = await api('/insumos', {
    method: 'POST',
    body: { nombre, unidadMedida: 'kg', stockMinimo: 1, localesSeleccionados: [localA] },
  });
  assert.equal(r1.status, 201, JSON.stringify(r1.data));
  insumosCreados.push(r1.data.id);

  // Segundo alta, mismo nombre, pensando en activarlo en localB.
  const r2 = await api('/insumos', {
    method: 'POST',
    body: { nombre, unidadMedida: 'kg', stockMinimo: 1, localesSeleccionados: [localB] },
  });
  assert.equal(r2.status, 400, JSON.stringify(r2.data));
  assert.equal(r2.data.campo, 'nombre');
  assert.ok(r2.data.insumoExistente, 'debe traer el insumo existente');
  assert.equal(r2.data.insumoExistente.id, r1.data.id);
  assert.equal(r2.data.insumoExistente.nombre, nombre);
  assert.ok(Array.isArray(r2.data.insumoExistente.localesActivos));
  assert.ok(r2.data.insumoExistente.localesActivos.some((l) => l.localId === localA));
  // El mensaje debe ser accionable: mencionar el flujo real (activar, no crear).
  assert.match(r2.data.error, /act.valo/i);
  assert.match(r2.data.error, new RegExp(`/insumos/${r1.data.id}/locales`));

  // El flujo correcto: activarlo en localB con PUT /insumos/:id/locales/:localId,
  // no crear un registro nuevo — y esa fila YA existe (sembrada al crear el
  // insumo en TODOS los locales, ver insRouter.post('/')), así que un PUT
  // alcanza sin necesidad de POST /insumos/:id/locales.
  const activar = await api(`/insumos/${r1.data.id}/locales/${localB}`, {
    method: 'PUT',
    body: { activo: true, stockActual: 4 },
  });
  assert.equal(activar.status, 200, JSON.stringify(activar.data));
  assert.equal(activar.data.activo, true);
  assert.equal(Number(activar.data.stock), 4);
});

test('PUT /insumos/:id con nombre que choca con OTRO insumo también trae el insumoExistente', async () => {
  const nombreA = `Insumo dup edit A ${Date.now()}`;
  const nombreB = `Insumo dup edit B ${Date.now()}`;
  const rA = await api('/insumos', { method: 'POST', body: { nombre: nombreA, unidadMedida: 'kg', stockMinimo: 1, localesSeleccionados: [localA] } });
  assert.equal(rA.status, 201, JSON.stringify(rA.data));
  insumosCreados.push(rA.data.id);
  const rB = await api('/insumos', { method: 'POST', body: { nombre: nombreB, unidadMedida: 'kg', stockMinimo: 1, localesSeleccionados: [localA] } });
  assert.equal(rB.status, 201, JSON.stringify(rB.data));
  insumosCreados.push(rB.data.id);

  const edit = await api(`/insumos/${rB.data.id}`, {
    method: 'PUT',
    body: { nombre: nombreA, unidadMedida: 'kg', precioUnitario: 0, estado: 'Activo' },
  });
  assert.equal(edit.status, 400, JSON.stringify(edit.data));
  assert.ok(edit.data.insumoExistente);
  assert.equal(edit.data.insumoExistente.id, rA.data.id);
});

test('editar un insumo SIN cambiar su propio nombre no dispara el choque contra sí mismo', async () => {
  const nombre = `Insumo dup self edit ${Date.now()}`;
  const r = await api('/insumos', { method: 'POST', body: { nombre, unidadMedida: 'kg', stockMinimo: 1, localesSeleccionados: [localA] } });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  insumosCreados.push(r.data.id);

  const edit = await api(`/insumos/${r.data.id}`, {
    method: 'PUT',
    body: { nombre, unidadMedida: 'kg', precioUnitario: 0, estado: 'Activo', descripcion: 'actualizado' },
  });
  assert.equal(edit.status, 200, JSON.stringify(edit.data));
});
