// ─────────────────────────────────────────────────────────────────────────
//  Test de regresión: el stock inicial de un insumo nuevo debe caer SOLO
//  en un local marcado como "donde existe este insumo"
// ─────────────────────────────────────────────────────────────────────────
// Bug real que esto cubre: nada cruzaba "a qué local va la cantidad
// inicial" (local_id) contra "en qué locales existe el insumo"
// (todosLosLocales / localesSeleccionados) — se podía mandar un local
// para el stock inicial que ni siquiera estuviera entre los marcados como
// existentes, creando stock en una fila que debía quedar inactiva.
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

test('rechaza el stock inicial si su local NO está en localesSeleccionados', async () => {
  const r = await api('/insumos', {
    method: 'POST',
    body: {
      nombre: `Insumo test locales seleccionados ${Date.now()}`,
      unidadMedida: 'kg', stockMinimo: 1, stockActual: 5,
      local_id: localB,
      localesSeleccionados: [localA], // localB (el del stock) NO está acá
    },
  });
  assert.equal(r.status, 400, JSON.stringify(r.data));
  assert.match(r.data.error, /local del stock inicial.*locales donde marcaste/i);
});

test('acepta el stock inicial cuando su local SÍ está entre los seleccionados', async () => {
  const nombre = `Insumo test locales seleccionados ok ${Date.now()}`;
  const r = await api('/insumos', {
    method: 'POST',
    body: {
      nombre, unidadMedida: 'kg', stockMinimo: 1, stockActual: 5,
      local_id: localB,
      localesSeleccionados: [localA, localB],
    },
  });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  insumosCreados.push(r.data.id);

  const filaA = r.data.porLocal.find((f) => f.localId === localA);
  const filaB = r.data.porLocal.find((f) => f.localId === localB);
  assert.equal(filaA.activo, true, 'localA fue seleccionado: debe quedar activo');
  assert.equal(filaB.activo, true, 'localB fue seleccionado (y es el del stock): debe quedar activo');
  assert.equal(Number(filaB.stock), 5, 'el stock inicial debe caer en localB, el resuelto');
  assert.equal(Number(filaA.stock), 0, 'localA no recibe stock, solo queda activo');
});

test('todosLosLocales=true acepta cualquier local activo para el stock inicial, incluso sin localesSeleccionados', async () => {
  const nombre = `Insumo test todos los locales ${Date.now()}`;
  const r = await api('/insumos', {
    method: 'POST',
    body: { nombre, unidadMedida: 'kg', stockMinimo: 1, stockActual: 3, local_id: localB, todosLosLocales: true },
  });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  insumosCreados.push(r.data.id);
  assert.ok(r.data.porLocal.every((f) => f.activo === true), 'con todosLosLocales, TODAS las filas deben quedar activas');
});

test('sin localesSeleccionados ni todosLosLocales, el backend asume un único local: el resuelto (local_id)', async () => {
  const nombre = `Insumo test local unico implicito ${Date.now()}`;
  const r = await api('/insumos', {
    method: 'POST',
    body: { nombre, unidadMedida: 'kg', stockMinimo: 1, stockActual: 7, local_id: localA },
  });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  insumosCreados.push(r.data.id);
  const filaA = r.data.porLocal.find((f) => f.localId === localA);
  assert.equal(filaA.activo, true);
  assert.equal(Number(filaA.stock), 7);
  const otras = r.data.porLocal.filter((f) => f.localId !== localA);
  for (const f of otras) assert.equal(f.activo, false, 'sin selección explícita, el resto queda inactivo (comportamiento de siempre)');
});

// ── Flujo actual del formulario: un solo local por alta (sin "Todos los
// locales" ni selector múltiple) — localesSeleccionados siempre llega con
// exactamente un id. rechaza [] explícito: un insumo sin ningún local
// marcado quedaría activo=false en TODOS, un insumo "fantasma".
test('localesSeleccionados=[] (vacío) se rechaza con 400, no crea un insumo fantasma', async () => {
  const r = await api('/insumos', {
    method: 'POST',
    body: {
      nombre: `Insumo test locales vacio ${Date.now()}`,
      unidadMedida: 'kg', stockMinimo: 1,
      localesSeleccionados: [],
    },
  });
  assert.equal(r.status, 400, JSON.stringify(r.data));
  assert.equal(r.data.campo, 'localesSeleccionados');
  assert.match(r.data.error, /al menos un local/i);
});

test('localesSeleccionados con exactamente un id (flujo actual del formulario): esa fila queda activa con el stock, el resto en 0 e inactivo, y el movimiento queda en el kardex', async () => {
  const nombre = `Insumo test un solo local ${Date.now()}`;
  const r = await api('/insumos', {
    method: 'POST',
    body: {
      nombre, unidadMedida: 'kg', stockMinimo: 2, stockActual: 12,
      localesSeleccionados: [localA],
    },
  });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  insumosCreados.push(r.data.id);

  const filaA = r.data.porLocal.find((f) => f.localId === localA);
  assert.equal(filaA.activo, true, 'el único local seleccionado queda activo');
  assert.equal(Number(filaA.stock), 12, 'recibe el stock inicial completo');
  const otras = r.data.porLocal.filter((f) => f.localId !== localA);
  assert.ok(otras.length > 0, 'debe haber otros locales en el catálogo para que la prueba sea significativa');
  for (const f of otras) {
    assert.equal(f.activo, false, 'el resto de locales existe (fila sembrada) pero inactivo');
    assert.equal(Number(f.stock), 0, 'el resto de locales arranca en 0');
  }

  // kardex: el alta con cantidad real queda trazada en movimientos_inventario
  // (no hay endpoint GET para esta tabla — es de auditoría, se verifica
  // directo contra la base, igual que en insumos-creacion-local-no-obligatorio.test.js).
  const mov = await pool.query(
    `SELECT tipo, local_id, cantidad, referencia_tipo FROM movimientos_inventario WHERE insumo_id=$1`,
    [r.data.id]
  );
  assert.equal(mov.rows.length, 1, 'debe quedar exactamente un movimiento para esta alta');
  assert.equal(mov.rows[0].referencia_tipo, 'alta_insumo');
  assert.equal(mov.rows[0].local_id, localA);
  assert.equal(Number(mov.rows[0].cantidad), 12);
});
