// ─────────────────────────────────────────────────────────────────────────
//  Tests de integración: métodos de pago dinámicos del checkout (Ronda 29)
// ─────────────────────────────────────────────────────────────────────────
// Catálogo administrable (nombre + descripción + QR opcional) que el
// checkout de la Landing lista públicamente — separado del identificador
// interno fijo de pedidos.pago (efectivo/nequi/transferencia), que sigue
// intacto. El QR reutiliza el mecanismo de imágenes ya existente: el
// backend solo guarda una URL de texto (igual que productos.imagen);
// nada nuevo de subida de archivos.
// Ejecutar: npm test
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const BASE = process.env.TEST_BASE_URL || 'http://localhost:4000/api';
const ADMIN_USER = process.env.TEST_ADMIN_USER || 'Admin_Sicaber';
const ADMIN_PASS = process.env.TEST_ADMIN_PASS || 'admin2024#';

let tokenAdmin;
const sufijo = Date.now();
const metodosCreados = [];

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
});

after(async () => {
  for (const id of metodosCreados) {
    try { await api(`/metodos-pago/${id}/estado`, { method: 'PATCH', token: tokenAdmin }); } catch {}
  }
});

test('GET /metodos-pago (público, sin token): 200 y solo trae métodos activos', async () => {
  const r = await api('/metodos-pago');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.ok(Array.isArray(r.data));
  assert.ok(r.data.every((m) => m.activo === true), 'ningún método inactivo debería listarse públicamente');
});

test('GET /metodos-pago/todos sin token: 401', async () => {
  const r = await api('/metodos-pago/todos');
  assert.equal(r.status, 401, JSON.stringify(r.data));
});

test('POST /metodos-pago: crea un método SIN QR (url_qr opcional)', async () => {
  const r = await api('/metodos-pago', {
    method: 'POST', token: tokenAdmin,
    body: { nombre: `Nequi test ${sufijo}`, descripcion: 'Paga por Nequi al número tal' },
  });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.urlQr, null);
  assert.equal(r.data.activo, true);
  metodosCreados.push(r.data.id);
});

test('POST /metodos-pago: crea un método CON QR', async () => {
  const r = await api('/metodos-pago', {
    method: 'POST', token: tokenAdmin,
    body: { nombre: `Bancolombia QR test ${sufijo}`, descripcion: 'Escanea el QR', url_qr: 'https://res.cloudinary.com/dwkdxelo4/image/upload/qr-test.png' },
  });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.urlQr, 'https://res.cloudinary.com/dwkdxelo4/image/upload/qr-test.png');
  metodosCreados.push(r.data.id);
});

test('POST /metodos-pago: nombre duplicado (case/espacios insensible) se rechaza con 400', async () => {
  const r = await api('/metodos-pago', {
    method: 'POST', token: tokenAdmin,
    body: { nombre: `  nequi test ${sufijo}  `.toUpperCase(), descripcion: 'duplicado' },
  });
  assert.equal(r.status, 400, JSON.stringify(r.data));
  assert.match(r.data.error, /Ya existe un método de pago/);
});

test('GET /metodos-pago/todos (admin): incluye los recién creados', async () => {
  const r = await api('/metodos-pago/todos', { token: tokenAdmin });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const ids = r.data.map((m) => m.id);
  for (const id of metodosCreados) assert.ok(ids.includes(id));
});

test('PATCH /metodos-pago/:id/qr: sube/cambia el QR de un método que no tenía', async () => {
  const [sinQrId] = metodosCreados;
  const r = await api(`/metodos-pago/${sinQrId}/qr`, {
    method: 'PATCH', token: tokenAdmin,
    body: { url_qr: 'https://res.cloudinary.com/dwkdxelo4/image/upload/qr-agregado.png' },
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.urlQr, 'https://res.cloudinary.com/dwkdxelo4/image/upload/qr-agregado.png');
});

test('PATCH /metodos-pago/:id/estado: desactiva, y ya no aparece en el listado público', async () => {
  const [id] = metodosCreados;
  const r = await api(`/metodos-pago/${id}/estado`, { method: 'PATCH', token: tokenAdmin });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.activo, false);

  const publico = await api('/metodos-pago');
  assert.ok(!publico.data.some((m) => m.id === id), 'un método desactivado no debe aparecer en el listado público');

  // lo reactiva de nuevo para no interferir con el resto de la suite / limpieza
  const reactivar = await api(`/metodos-pago/${id}/estado`, { method: 'PATCH', token: tokenAdmin });
  assert.equal(reactivar.data.activo, true);
});

test('PUT /metodos-pago/:id sin mandar "activo": preserva el activo actual (no lo reactiva/desactiva solo)', async () => {
  const [id] = metodosCreados;
  // lo desactiva primero
  await api(`/metodos-pago/${id}/estado`, { method: 'PATCH', token: tokenAdmin });

  const r = await api(`/metodos-pago/${id}`, {
    method: 'PUT', token: tokenAdmin,
    body: { nombre: `Nequi test editado ${sufijo}`, descripcion: 'descripción editada' },
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.activo, false, 'editar sin mandar "activo" no debería reactivarlo');
  assert.equal(r.data.nombre, `Nequi test editado ${sufijo}`);

  // deja el estado como estaba antes de este test (activo) para la limpieza del after()
  await api(`/metodos-pago/${id}/estado`, { method: 'PATCH', token: tokenAdmin });
});

test('PUT /metodos-pago/:id sin mandar "url_qr": preserva el QR existente', async () => {
  const conQrId = metodosCreados[1];
  const r = await api(`/metodos-pago/${conQrId}`, {
    method: 'PUT', token: tokenAdmin,
    body: { nombre: `Bancolombia QR test editado ${sufijo}`, descripcion: 'sigue con QR' },
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.urlQr, 'https://res.cloudinary.com/dwkdxelo4/image/upload/qr-test.png');
});
