// ─────────────────────────────────────────────────────────────────────────
//  Test de integración: permitirRoles() ya no rechaza por diferencias de
//  mayúsculas/espacios en usuarios.rol (Ronda 29)
// ─────────────────────────────────────────────────────────────────────────
// Reporte original: "Locales no cargan en Empleados" — un Administrador
// real recibía "Solo Administrador puede realizar esta acción" en
// GET /locales/todos. No se pudo reproducir con la cuenta real
// (Admin_Sicaber, rol guardado exactamente como "Administrador"), pero se
// encontró y corrigió una causa raíz real y más general: permitirRoles()
// (middleware/auth.js) comparaba el rol del token con `.includes()` EXACTO
// — sensible a mayúsculas y sin recortar espacios — mientras que
// esAdministrador() (middleware/permisos.js) ya normalizaba (trim +
// minúsculas) para el mismo propósito en otro lugar. Como usuarios.rol es
// un VARCHAR libre (no un enum/CHECK), nada impedía que quedara guardado
// como " administrador" o "ADMINISTRADOR" — y cualquier ruta detrás de
// permitirRoles('Administrador'), incluida /locales, rechazaba a ese
// usuario aunque conceptualmente SÍ fuera Administrador.
//
// Nota: la API no ofrece ningún endpoint para crear una cuenta de rol
// "Administrador" (POST /empleados solo crea login para cargo Cajero o
// Bartender — ver CARGOS_CON_LOGIN — un Administrador se siembra aparte,
// ver seed/Admin_Sicaber), así que este test inserta el usuario
// directamente por SQL (mismo patrón ya usado en otros tests de este
// repo — ver desacople-proveedor-insumo.test.js) para poder guardarle un
// rol con mayúsculas/espacios no canónicos, algo que la API en sí nunca
// impidió al crear/editar un usuario.
// Ejecutar: npm test
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
require('dotenv').config();
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const BASE = process.env.TEST_BASE_URL || 'http://localhost:4000/api';
const ADMIN_USER = process.env.TEST_ADMIN_USER || 'Admin_Sicaber';
const ADMIN_PASS = process.env.TEST_ADMIN_PASS || 'admin2024#';

const pool = new Pool({
  host: process.env.DB_HOST, port: Number(process.env.DB_PORT), database: process.env.DB_NAME,
  user: process.env.DB_USER, password: process.env.DB_PASSWORD,
});

let tokenAdmin;
let usuarioRolRaroId;
let tokenRolRaro;
const sufijo = Date.now();
const username = `admin_rol_raro_${sufijo}`;
const PASSWORD = 'Clave12345678#';

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

  // Rol guardado con espacios colados + minúsculas — el tipo de valor no
  // canónico que un `permitirRoles` sin normalizar rechazaría.
  const hash = await bcrypt.hash(PASSWORD, 10);
  const { rows } = await pool.query(
    `INSERT INTO usuarios(nombre, username, password, rol, sede) VALUES($1,$2,$3,$4,'Ambos') RETURNING id`,
    [`Admin rol raro ${sufijo}`, username, hash, ' administrador ']
  );
  usuarioRolRaroId = rows[0].id;

  const loginRolRaro = await api('/auth/login', { method: 'POST', body: { username, password: PASSWORD } });
  assert.equal(loginRolRaro.status, 200, JSON.stringify(loginRolRaro.data));
  tokenRolRaro = loginRolRaro.data.token;
});

after(async () => {
  try { if (usuarioRolRaroId) await pool.query('DELETE FROM usuarios WHERE id=$1', [usuarioRolRaroId]); } catch {}
  await pool.end();
});

test('usuario con rol " administrador " (espacios + minúsculas) accede a GET /locales/todos igual que "Administrador"', async () => {
  const r = await api('/locales/todos', { token: tokenRolRaro });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.ok(Array.isArray(r.data));
});

test('el rol quedó guardado tal cual, no canónico — confirma que la normalización es solo en el middleware, no un cambio de dato', async () => {
  const { rows } = await pool.query('SELECT rol FROM usuarios WHERE id=$1', [usuarioRolRaroId]);
  assert.equal(rows[0].rol, ' administrador ');
});

test('un rol que de verdad no es Administrador (ej. "Cajero") sigue rechazado con 403', async () => {
  const sufijoCajero = Date.now();
  const usernameCajero = `cajero_rol_check_${sufijoCajero}`;
  const empleadoCajero = await api('/empleados', {
    method: 'POST', token: tokenAdmin,
    body: { nombre: `Cajero rol check ${sufijoCajero}`, cargo: 'Cajero', username: usernameCajero, password: PASSWORD },
  });
  assert.equal(empleadoCajero.status, 201, JSON.stringify(empleadoCajero.data));
  try {
    const loginCajero = await api('/auth/login', { method: 'POST', body: { username: usernameCajero, password: PASSWORD } });
    assert.equal(loginCajero.status, 200, JSON.stringify(loginCajero.data));
    const r = await api('/locales/todos', { token: loginCajero.data.token });
    assert.equal(r.status, 403, JSON.stringify(r.data));
    assert.match(r.data.error, /Solo Administrador/);
  } finally {
    await api(`/empleados/${empleadoCajero.data.id}`, { method: 'DELETE', token: tokenAdmin });
  }
});
