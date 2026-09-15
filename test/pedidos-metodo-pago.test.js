// ─────────────────────────────────────────────────────────────────────────
//  Tests de integración: reorganización de métodos de pago
// ─────────────────────────────────────────────────────────────────────────
// Regla de negocio VIGENTE (Ronda 32 — reemplaza la de una ronda anterior,
// que restringía "efectivo" solo a domicilio; ver test/
// pedidos-contraentrega-y-transiciones-bartender.test.js para el caso real
// que forzó el cambio, pedido #158 trabado en 'pendiente_verificacion'):
//   • Lo que decide si se exige comprobante es el MÉTODO DE PAGO, no el
//     tipo de entrega. "Efectivo" (pago contraentrega/al llegar, sin
//     comprobante) es válido tanto en domicilio como en recoger en el
//     local — en los dos casos nace directo en 'pendiente'.
//   • El valor interno 'transferencia' NO cambia (el frontend le pone la
//     etiqueta "Llave Bancolombia") — sigue exigiendo comprobante
//     verificado antes de avanzar a 'en_proceso', igual que 'nequi', en
//     los DOS tipos de entrega.
//
// Requiere: servidor corriendo contra una base con GEOAPIFY_API_KEY
// configurada (el test de "efectivo + domicilio" geocodifica una
// dirección REAL de cobertura conocida — ver test-geocoding.js en la raíz
// del repo, "Calle 57B" → Comuna 8, Local Villa Liliam). Si el servicio de
// geocodificación no responde, ese test puntual fallará por causas
// externas al código que valida — el resto de esta suite no depende de
// red externa. Ejecutar: npm test
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const BASE = process.env.TEST_BASE_URL || 'http://localhost:4000/api';
const ADMIN_USER = process.env.TEST_ADMIN_USER || 'Admin_Sicaber';
const ADMIN_PASS = process.env.TEST_ADMIN_PASS || 'admin2024#';

// Dirección real, ya confirmada dentro de la zona de cobertura (Comuna 8)
// por test-geocoding.js — evita depender de una dirección inventada que
// podría caer fuera de cobertura y romper el test por una razón ajena a
// lo que se está probando.
const DIRECCION_CUBIERTA = 'Calle 57B # 7-71, Medellín';

let tokenAdmin;
let localA;
const pedidosCreados = [];

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

  const listado = await api('/locales/todos', { token: tokenAdmin });
  const activos = listado.data.filter((l) => l.estado === 'Activo');
  assert.ok(activos.length >= 1, 'se necesita al menos 1 local Activo');
  localA = activos[0].id;
});

after(async () => {
  for (const id of pedidosCreados) {
    try { await api(`/pedidos/${id}`, { method: 'DELETE', token: tokenAdmin }); } catch {}
  }
});

test('POST /pedidos: efectivo + tipo="local" (recoger, pago contraentrega) SÍ se acepta, y arranca en "pendiente" sin comprobante', async () => {
  const r = await api('/pedidos', {
    method: 'POST',
    body: {
      cliente: 'Prueba efectivo local', alias: `alias-efectivo-local-${Date.now()}`,
      tipo: 'local', local_id: localA, total: 5000, items: [], origen: 'landing', pago: 'efectivo',
    },
  });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  pedidosCreados.push(r.data.id);
  assert.equal(r.data.tipo, 'local');
  assert.equal(r.data.pago, 'efectivo');
  assert.equal(r.data.estado, 'pendiente');
  assert.equal(r.data.comprobante_img, null);
});

test('POST /pedidos: efectivo + tipo="domicilio" (dirección real de cobertura) SÍ se acepta, y arranca en "pendiente" (no exige comprobante)', async () => {
  const r = await api('/pedidos', {
    method: 'POST',
    body: {
      cliente: 'Prueba efectivo domicilio', alias: `alias-efectivo-domicilio-${Date.now()}`, tipo: 'domicilio', direccion_alternativa: DIRECCION_CUBIERTA,
      total: 6000, items: [], origen: 'landing', pago: 'efectivo',
    },
  });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  pedidosCreados.push(r.data.id);
  assert.equal(r.data.tipo, 'domicilio');
  assert.equal(r.data.pago, 'efectivo');
  // Efectivo no exige comprobante: nace directo en 'pendiente', nunca
  // 'pendiente_verificacion' (eso es exclusivo de nequi/transferencia).
  assert.equal(r.data.estado, 'pendiente');
  assert.equal(r.data.estado_pago, 'pendiente');
});

test('POST /pedidos: "transferencia" sigue siendo el valor interno real (la etiqueta "Llave Bancolombia" es solo del frontend)', async () => {
  const r = await api('/pedidos', {
    method: 'POST',
    body: {
      cliente: 'Prueba llave bancolombia', alias: `alias-llave-bancolombia-${Date.now()}`, tipo: 'local', local_id: localA, total: 7000, items: [],
      origen: 'landing', pago: 'transferencia', comprobante_img: `data:text/plain;base64,evidencia-${Date.now()}`,
    },
  });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  pedidosCreados.push(r.data.id);
  assert.equal(r.data.pago, 'transferencia', 'el valor guardado en base sigue siendo "transferencia", no cambia a otro identificador');

  // Nequi y "transferencia" (Llave Bancolombia) exigen las DOS el mismo
  // gate de comprobante verificado antes de avanzar a 'en_proceso'.
  const avance = await api(`/pedidos/${r.data.id}/estado`, {
    method: 'PATCH', token: tokenAdmin, body: { estado: 'en_proceso' },
  });
  assert.equal(avance.status, 409, JSON.stringify(avance.data));
  assert.match(avance.data.error, /comprobante/i);

  const aprobar = await api(`/pedidos/${r.data.id}/comprobante/aprobar`, { method: 'PATCH', token: tokenAdmin });
  assert.equal(aprobar.status, 200, JSON.stringify(aprobar.data));
  assert.equal(aprobar.data.estado_pago, 'aprobado');

  const avanceOk = await api(`/pedidos/${r.data.id}/estado`, {
    method: 'PATCH', token: tokenAdmin, body: { estado: 'en_proceso' },
  });
  assert.equal(avanceOk.status, 200, JSON.stringify(avanceOk.data));
});

test('PUT /pedidos/:id: cambiar el pago a efectivo en un pedido tipo="local" YA se acepta (edición parcial, combinación resultante)', async () => {
  const creado = await api('/pedidos', {
    method: 'POST',
    body: { cliente: 'Prueba put efectivo local', alias: `alias-put-efectivo-local-${Date.now()}`, tipo: 'local', local_id: localA, total: 4000, items: [], origen: 'landing', pago: 'nequi' },
  });
  assert.equal(creado.status, 201, JSON.stringify(creado.data));
  pedidosCreados.push(creado.data.id);

  // El PUT solo manda "pago" — "tipo" no viene en este body, pero sigue
  // siendo 'local' en la base; la combinación resultante ya no choca.
  const r = await api(`/pedidos/${creado.data.id}`, {
    method: 'PUT', token: tokenAdmin, body: { pago: 'efectivo' },
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.pago, 'efectivo');
  assert.equal(r.data.tipo, 'local');
});

test('PUT /pedidos/:id: cambiar el "tipo" a local en un pedido YA pagado en efectivo también se acepta (misma combinación, desde el otro campo)', async () => {
  const creado = await api('/pedidos', {
    method: 'POST',
    body: {
      cliente: 'Prueba put tipo local con efectivo', alias: `alias-put-tipo-local-${Date.now()}`, tipo: 'domicilio', direccion_alternativa: DIRECCION_CUBIERTA,
      total: 4500, items: [], origen: 'landing', pago: 'efectivo',
    },
  });
  assert.equal(creado.status, 201, JSON.stringify(creado.data));
  pedidosCreados.push(creado.data.id);

  const r = await api(`/pedidos/${creado.data.id}`, {
    method: 'PUT', token: tokenAdmin, body: { tipo: 'local', local_id: localA },
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.tipo, 'local');
  assert.equal(r.data.pago, 'efectivo');
});
