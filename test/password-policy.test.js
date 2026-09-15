// ─────────────────────────────────────────────────────────────────────────
//  Nueva regla de contraseña: 10-20 caracteres, mayúscula, minúscula,
//  número y carácter especial. Se aplica en TODO punto donde se crea o
//  cambia una contraseña (registro de cliente, reset, usuarios, empleados)
//  porque todos pasan por el mismo módulo central (config/passwordPolicy.js).
// ─────────────────────────────────────────────────────────────────────────
// Parte 1: unitaria, sin servidor (contra el módulo directo).
// Parte 2: integración, un solo endpoint real (registro de cliente) como
// evidencia de que el módulo SÍ está conectado end-to-end — el resto de
// endpoints (reset-password, POST/PUT /usuarios, POST /empleados) llaman
// exactamente la misma función (passwordValida/errorPassword), así que no
// hace falta repetir la matriz completa en cada uno.
//
// Ejecutar: npm test
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { passwordValida, errorPassword, PASSWORD_ERROR } = require('../src/config/passwordPolicy');

const MENSAJE_ESPERADO = 'La contraseña debe tener entre 10 y 20 caracteres, con al menos una mayúscula, una minúscula, un número y un carácter especial.';

test('PASSWORD_ERROR es exactamente el mensaje pedido', () => {
  assert.equal(PASSWORD_ERROR, MENSAJE_ESPERADO);
});

test('acepta una contraseña que cumple las 4 reglas dentro de 10-20 caracteres', () => {
  assert.equal(passwordValida('Clave123456#'), true);
  assert.equal(errorPassword('Clave123456#'), null);
});

test('rechaza menos de 10 caracteres', () => {
  assert.equal(passwordValida('Ab1#567'), false); // 7 caracteres
  assert.equal(errorPassword('Ab1#567'), MENSAJE_ESPERADO);
});

test('rechaza más de 20 caracteres', () => {
  assert.equal(passwordValida('Aa1#aaaaaaaaaaaaaaaaaaaa'), false); // 24 caracteres
});

test('exactamente 10 caracteres (límite inferior) se acepta', () => {
  assert.equal(passwordValida('Aa1#aaaaaa'), true); // 10 caracteres exactos
});

test('exactamente 20 caracteres (límite superior) se acepta', () => {
  assert.equal(passwordValida('Aa1#aaaaaaaaaaaaaaaa'), true); // 20 caracteres exactos
});

test('rechaza sin mayúscula', () => {
  assert.equal(passwordValida('clave123456#'), false);
});

test('rechaza sin minúscula', () => {
  assert.equal(passwordValida('CLAVE123456#'), false);
});

test('rechaza sin número', () => {
  assert.equal(passwordValida('ClaveClave##'), false);
});

test('rechaza sin carácter especial', () => {
  assert.equal(passwordValida('Clave1234567'), false);
});

test('rechaza vacío/undefined sin explotar', () => {
  assert.equal(passwordValida(''), false);
  assert.equal(passwordValida(undefined), false);
  assert.equal(errorPassword(''), MENSAJE_ESPERADO);
});

// ── Integración: un endpoint real end-to-end ────────────────────────────
const BASE = process.env.TEST_BASE_URL || 'http://localhost:4000/api';
const api = async (path, { method = 'GET', body } = {}) => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
};

test('POST /auth/cliente/registro: rechaza una contraseña débil con el mensaje exacto', async () => {
  const r = await api('/auth/cliente/registro', {
    method: 'POST',
    body: { nombre: 'Prueba Password Debil', correo: `pw.debil.${Date.now()}@example.com`, password: 'clave123' },
  });
  assert.equal(r.status, 400, JSON.stringify(r.data));
  assert.equal(r.data.error, MENSAJE_ESPERADO);
});

test('POST /auth/cliente/registro: acepta una contraseña que cumple la regla nueva', async () => {
  const r = await api('/auth/cliente/registro', {
    method: 'POST',
    body: { nombre: 'Prueba Password Ok', correo: `pw.ok.${Date.now()}@example.com`, password: 'Clave123456#' },
  });
  assert.equal(r.status, 201, JSON.stringify(r.data));
});
