// ─────────────────────────────────────────────────────────────────────────
//  Tests de integración: Insumo/Proveedor desacoplados, Ciudades/Categorías
//  sin borrado, stock inicial con observación y trazabilidad (Ronda 12)
// ─────────────────────────────────────────────────────────────────────────
// Corren contra la API real (mismo criterio que el resto de la suite: sin
// base de datos de prueba separada). Requiere servidor corriendo y el admin
// sembrado (Admin_Sicaber/admin2024#, o TEST_ADMIN_USER/TEST_ADMIN_PASS).
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
let localId;
const insumosCreados = []; // ids a limpiar al final

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

  const { rows } = await pool.query(`SELECT id FROM locales WHERE estado='Activo' ORDER BY id LIMIT 1`);
  assert.ok(rows[0], 'necesito al menos un local Activo para estas pruebas');
  localId = rows[0].id;
});

after(async () => {
  try {
    for (const id of insumosCreados) {
      await pool.query('DELETE FROM movimientos_inventario WHERE insumo_id=$1', [id]);
      await pool.query('DELETE FROM insumo_local WHERE insumo_id=$1', [id]);
      await pool.query('DELETE FROM insumos WHERE id=$1', [id]);
    }
  } catch {}
  await pool.end();
});

test('Ciudades: hay al menos las 16 base y no existe DELETE', async () => {
  const r = await api('/ciudades');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.ok(r.data.length >= 16, `se esperaban al menos 16 ciudades, hay ${r.data.length}`);

  const del = await api('/ciudades/' + r.data[0].id, { method: 'DELETE' });
  assert.equal(del.status, 404, 'no debe existir ninguna ruta DELETE /ciudades/:id');
});

test('Ciudades: búsqueda por nombre (?q=)', async () => {
  const r = await api('/ciudades?q=Bog');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.ok(r.data.some((c) => c.nombre === 'Bogotá'), 'debe encontrar "Bogotá" con ?q=Bog');
});

test('Categorías de Insumo: sin DELETE ni /recategorizar', async () => {
  const cats = await api('/categorias-insumos');
  assert.equal(cats.status, 200, JSON.stringify(cats.data));
  assert.ok(cats.data[0], 'debe existir al menos una categoría de insumo para esta prueba');
  const id = cats.data[0].id;

  const del = await api('/categorias-insumos/' + id, { method: 'DELETE' });
  assert.equal(del.status, 404, 'no debe existir DELETE /categorias-insumos/:id');

  const recat = await api('/categorias-insumos/' + id + '/recategorizar', { method: 'POST', body: {} });
  assert.equal(recat.status, 404, 'no debe existir /recategorizar');
});

test('POST /insumos: se crea SIN proveedor y sin exigir que exista uno Activo', async () => {
  const nombre = `Insumo test desacople ${Date.now()}`;
  const r = await api('/insumos', {
    method: 'POST',
    body: { nombre, unidadMedida: 'kg', stockMinimo: 1, local_id: localId },
  });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal('proveedorId' in r.data, false, 'la respuesta de un insumo nunca debe traer proveedorId');
  insumosCreados.push(r.data.id);
});

test('POST /insumos: con cantidad inicial, la observación por defecto es "Comenzó con cantidad existente"', async () => {
  const nombre = `Insumo test stock inicial ${Date.now()}`;
  const r = await api('/insumos', {
    method: 'POST',
    body: { nombre, unidadMedida: 'kg', stockMinimo: 1, stockActual: 3.5, local_id: localId },
  });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.observaciones, 'Comenzó con cantidad existente');
  const fila = r.data.porLocal.find((f) => f.localId === localId);
  assert.equal(fila.stock, 3.5);
  insumosCreados.push(r.data.id);

  const mov = await pool.query(
    `SELECT * FROM movimientos_inventario WHERE insumo_id=$1 AND tipo='ajuste' AND referencia_tipo='alta_insumo'`,
    [r.data.id]
  );
  assert.equal(mov.rows.length, 1, 'debe quedar registrado un movimiento de inventario para el stock inicial');
  assert.equal(Number(mov.rows[0].cantidad), 3.5);
});

test('POST /insumos: si el usuario manda su propia observación, esa se respeta (no se pisa con el default)', async () => {
  const nombre = `Insumo test obs propia ${Date.now()}`;
  const r = await api('/insumos', {
    method: 'POST',
    body: { nombre, unidadMedida: 'unidad', stockMinimo: 1, stockActual: 2, observaciones: 'Nota del usuario', local_id: localId },
  });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.observaciones, 'Nota del usuario');
  insumosCreados.push(r.data.id);
});

test('POST /insumos: sin cantidad inicial, stock queda en 0 y observaciones en null', async () => {
  const nombre = `Insumo test sin cantidad ${Date.now()}`;
  const r = await api('/insumos', {
    method: 'POST',
    body: { nombre, unidadMedida: 'kg', stockMinimo: 1, local_id: localId },
  });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.observaciones, null);
  const fila = r.data.porLocal.find((f) => f.localId === localId);
  assert.equal(fila.stock, 0);
  insumosCreados.push(r.data.id);
});

test('POST /compras: rechaza fecha futura', async () => {
  const manana = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const r = await api('/compras', {
    method: 'POST',
    body: {
      local_id: localId, fecha: manana, total: 1000, descuento: 0,
      items: [{ insumo: 'insumo que no existe para esta prueba', cantidad: 1, precioUnitario: 1000 }],
    },
  });
  assert.equal(r.status, 400, JSON.stringify(r.data));
  assert.match(r.data.error, /futura/i);
});
