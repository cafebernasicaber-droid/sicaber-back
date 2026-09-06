// ─────────────────────────────────────────────────────────────────────────
//  Test de regresión: un local Activo sin dirección completa sigue
//  apareciendo en el selector de locales (GET /locales)
// ─────────────────────────────────────────────────────────────────────────
// Bug real que esto cubre: una migración anterior guardó un texto
// placeholder en "direccion" para los locales sin dirección real, y
// GET /locales (el único endpoint de "locales activos" — lo consumen
// también los selectores de Compras e Insumos, no solo el checkout
// público) llegó a filtrar por ese texto, hacienda desaparecer locales
// reales y activos de esos selectores. La dirección obligatoria debe
// aplicar solo a la CREACIÓN/EDICIÓN, nunca ocultar un registro existente.
//
// Requiere: servidor corriendo (npm run dev/start) y conexión directa a la
// misma base (usa `pg` para preparar el escenario: un local Activo con
// "direccion" NULL, que hoy no se puede lograr solo con la API porque
// POST /locales exige dirección al crear — exactamente como debe ser; este
// test simula el caso real de un registro YA EXISTENTE que quedó
// incompleto). Ejecutar: npm test
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
let localNombre;

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

  // Se prepara directo en la base (no vía API): un local ACTIVO con
  // "direccion" NULL — el escenario real de un registro que quedó
  // incompleto, sin pasar por la validación de creación.
  localNombre = `Local test selector ${Date.now()}`;
  const { rows } = await pool.query(
    `INSERT INTO locales(nombre, direccion, estado) VALUES($1, NULL, 'Activo') RETURNING id`,
    [localNombre]
  );
  localId = rows[0].id;
});

after(async () => {
  try { await pool.query('DELETE FROM locales WHERE id=$1', [localId]); } catch {}
  await pool.end();
});

test('GET /locales (selector) incluye un local Activo aunque su dirección esté incompleta', async () => {
  const r = await api('/locales');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const encontrado = r.data.find((l) => l.id === localId);
  assert.ok(encontrado, `el local de prueba (id ${localId}, direccion NULL) debe aparecer en GET /locales`);
  assert.equal(encontrado.direccionPendiente, true, 'debe venir marcado como pendiente, calculado — nunca oculto');
});

test('GET /locales/todos (admin) también lo trae, con direccionPendiente=true', async () => {
  const r = await api('/locales/todos');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const encontrado = r.data.find((l) => l.id === localId);
  assert.ok(encontrado, 'debe aparecer en el listado de administración');
  assert.equal(encontrado.direccionPendiente, true);
  assert.equal(typeof encontrado.insumosConStock, 'number', 'el contador de insumos debe ser un número real, nunca "—"/undefined');
});

test('POST /locales sigue exigiendo dirección al CREAR (la obligatoriedad no desapareció, solo dejó de ocultar registros viejos)', async () => {
  const r = await api('/locales', { method: 'POST', body: { nombre: `Local test sin direccion ${Date.now()}` } });
  assert.equal(r.status, 400, JSON.stringify(r.data));
});
