// ─────────────────────────────────────────────────────────────────────────
//  NIT de proveedores: solo validación de FORMATO (9 dígitos, guion, 1
//  dígito), sin ningún cálculo de dígito de verificación real (Módulo 11).
// ─────────────────────────────────────────────────────────────────────────
// Ejecutar: npm test
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const BASE = process.env.TEST_BASE_URL || 'http://localhost:4000/api';
const ADMIN_USER = process.env.TEST_ADMIN_USER || 'Admin_Sicaber';
const ADMIN_PASS = process.env.TEST_ADMIN_PASS || 'admin2024#';

let tokenAdmin;
const proveedoresCreados = [];

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
  for (const id of proveedoresCreados) {
    try { await api(`/proveedores/${id}`, { method: 'DELETE', token: tokenAdmin }); } catch {}
  }
});

test('POST /proveedores: NIT con el formato correcto (9 dígitos-1 dígito) se acepta, sin importar si el dígito de verificación real sería otro', async () => {
  // 900123456-9: el dígito de verificación matemático real (Módulo 11)
  // para 900123456 NO es 9 — si el algoritmo viejo siguiera activo esto
  // se rechazaría; con la validación nueva (solo forma) se acepta igual.
  const r = await api('/proveedores', {
    method: 'POST', token: tokenAdmin,
    body: { nombre: `Proveedor NIT test ${Date.now()}`, tipoPersona: 'Juridica', nit: '900123456-9' },
  });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  proveedoresCreados.push(r.data.id);
  assert.equal(r.data.nit, '900123456-9');
});

test('POST /proveedores: rechaza un NIT sin guion', async () => {
  const r = await api('/proveedores', {
    method: 'POST', token: tokenAdmin,
    body: { nombre: `Proveedor NIT sin guion ${Date.now()}`, tipoPersona: 'Juridica', nit: '9001234569' },
  });
  assert.equal(r.status, 400, JSON.stringify(r.data));
  assert.match(r.data.error, /formato/i);
});

test('POST /proveedores: rechaza un NIT con menos de 9 dígitos antes del guion', async () => {
  const r = await api('/proveedores', {
    method: 'POST', token: tokenAdmin,
    body: { nombre: `Proveedor NIT corto ${Date.now()}`, tipoPersona: 'Juridica', nit: '12345-6' },
  });
  assert.equal(r.status, 400, JSON.stringify(r.data));
});

test('POST /proveedores: rechaza un NIT con más de 1 dígito de verificación', async () => {
  const r = await api('/proveedores', {
    method: 'POST', token: tokenAdmin,
    body: { nombre: `Proveedor NIT dv largo ${Date.now()}`, tipoPersona: 'Juridica', nit: '900123456-12' },
  });
  assert.equal(r.status, 400, JSON.stringify(r.data));
});

test('POST /proveedores: sin NIT (campo opcional) se sigue aceptando igual que antes', async () => {
  const r = await api('/proveedores', {
    method: 'POST', token: tokenAdmin,
    body: { nombre: `Proveedor sin NIT ${Date.now()}`, tipoPersona: 'Juridica' },
  });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  proveedoresCreados.push(r.data.id);
});

test('POST /proveedores: Persona Natural con tipoDocumento=NIT también valida el formato en numeroDocumento', async () => {
  const r = await api('/proveedores', {
    method: 'POST', token: tokenAdmin,
    body: {
      nombre: `Persona Natural NIT test ${Date.now()}`, tipoPersona: 'Natural',
      tipoDocumento: 'NIT', numeroDocumento: 'no-es-un-nit',
    },
  });
  assert.equal(r.status, 400, JSON.stringify(r.data));
  assert.match(r.data.error, /formato/i);
});

test('PUT /proveedores/:id: el mismo formato se exige también al editar', async () => {
  const creado = await api('/proveedores', {
    method: 'POST', token: tokenAdmin,
    body: { nombre: `Proveedor editar NIT ${Date.now()}`, tipoPersona: 'Juridica', nit: '800234567-1' },
  });
  assert.equal(creado.status, 201, JSON.stringify(creado.data));
  proveedoresCreados.push(creado.data.id);

  const r = await api(`/proveedores/${creado.data.id}`, {
    method: 'PUT', token: tokenAdmin,
    body: { nombre: creado.data.nombre, tipoPersona: 'Juridica', nit: '800234567', estado: 'Activo' },
  });
  assert.equal(r.status, 400, JSON.stringify(r.data));
  assert.match(r.data.error, /formato/i);
});
