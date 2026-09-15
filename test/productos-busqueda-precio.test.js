// ─────────────────────────────────────────────────────────────────────────
//  GET /productos?precio= — coincidencia de TEXTO (contiene / empieza
//  con), no una igualdad exacta ni el viejo criterio de "prefijo en
//  miles". Buscar "5" debe encontrar 5000, 15000, 5500, etc. — cualquier
//  precio cuyo texto contenga "5" en cualquier posición.
// ─────────────────────────────────────────────────────────────────────────
// Ejecutar: npm test
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const BASE = process.env.TEST_BASE_URL || 'http://localhost:4000/api';
const ADMIN_USER = process.env.TEST_ADMIN_USER || 'Admin_Sicaber';
const ADMIN_PASS = process.env.TEST_ADMIN_PASS || 'admin2024#';

let tokenAdmin;
const productosCreados = [];
const sufijo = Date.now();

const api = async (path, { method = 'GET', token, body } = {}) => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
};

const crearProducto = async (nombre, precio) => {
  const r = await api('/productos', {
    method: 'POST', token: tokenAdmin,
    body: { nombre, categoria: `Categoria precio test ${sufijo}`, precio, estado: 'Activo' },
  });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  productosCreados.push(r.data.id);
  return r.data;
};

before(async () => {
  const login = await api('/auth/login', { method: 'POST', body: { username: ADMIN_USER, password: ADMIN_PASS } });
  assert.equal(login.status, 200, JSON.stringify(login.data));
  tokenAdmin = login.data.token;

  await crearProducto(`Producto precio 5000 ${sufijo}`, 5000);
  await crearProducto(`Producto precio 15000 ${sufijo}`, 15000);
  await crearProducto(`Producto precio 5500 ${sufijo}`, 5500);
  await crearProducto(`Producto precio 8000 ${sufijo}`, 8000);
  await crearProducto(`Producto precio 25010 ${sufijo}`, 25010);
});

after(async () => {
  for (const id of productosCreados) { try { await api(`/productos/${id}`, { method: 'DELETE', token: tokenAdmin }); } catch {} }
});

const nombresDe = (lista) => lista.map((p) => p.nombre);

test('GET /productos?precio=5: encuentra 5000, 15000, 5500 y 25010 (todos "contienen" un 5) — NO solo 5000-5999', async () => {
  const r = await api(`/productos?precio=5`);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const nombres = nombresDe(r.data.filter((p) => p.nombre.includes(String(sufijo))));
  assert.ok(nombres.some((n) => n.includes('5000')), 'debe incluir el de 5000');
  assert.ok(nombres.some((n) => n.includes('15000')), 'debe incluir el de 15000 (el viejo filtro por rango 5000-5999 NUNCA lo encontraba)');
  assert.ok(nombres.some((n) => n.includes('5500')), 'debe incluir el de 5500');
  assert.ok(nombres.some((n) => n.includes('25010')), 'debe incluir el de 25010 (contiene un 5)');
  assert.ok(!nombres.some((n) => n.includes('8000')), 'NO debe incluir el de 8000 (no contiene ningún 5)');
});

test('GET /productos?precio=550: coincidencia más específica, solo el precio que la contiene', async () => {
  const r = await api(`/productos?precio=550`);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const nombres = nombresDe(r.data.filter((p) => p.nombre.includes(String(sufijo))));
  assert.ok(nombres.some((n) => n.includes('5500')), 'debe incluir el de 5500 ("5500" contiene "550")');
  assert.ok(!nombres.some((n) => n.includes('15000')), 'NO debe incluir 15000 ("15000" no contiene "550")');
  assert.ok(!nombres.some((n) => n.includes('5000 ')), 'NO debe incluir 5000 ("5000" no contiene "550")');
});

test('GET /productos?precio=8000: coincidencia exacta también funciona (es un caso particular de "contiene")', async () => {
  const r = await api(`/productos?precio=8000`);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const nombres = nombresDe(r.data.filter((p) => p.nombre.includes(String(sufijo))));
  assert.ok(nombres.some((n) => n.includes('8000')));
  assert.equal(nombres.filter((n) => n.includes(String(sufijo))).length, 1, 'con "8000" completo, solo ese precio debería matchear entre los de este test');
});

test('GET /productos?precio=abc: rechaza un valor que no son solo dígitos', async () => {
  const r = await api(`/productos?precio=abc`);
  assert.equal(r.status, 400, JSON.stringify(r.data));
});

test('GET /productos sin ?precio=: sin filtro, de nuevo', async () => {
  const r = await api('/productos');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const nombres = nombresDe(r.data.filter((p) => p.nombre.includes(String(sufijo))));
  assert.equal(nombres.length, 5, 'sin filtro deben aparecer los 5 productos de este test');
});
