// ─────────────────────────────────────────────────────────────────────────
//  Test de integración: ruido decimal en compras por presentación (Ronda 29)
// ─────────────────────────────────────────────────────────────────────────
// calcularCantidadStock() (routes/index.js) calcula, para un ítem en modo
// "presentacion", cantidad_presentaciones × contenido_por_presentacion. Esa
// multiplicación en punto flotante puede arrastrar ruido binario típico de
// JS aunque los dos factores tengan decimales "limpios" — el ejemplo real:
// 3 × 13.7 === 41.099999999999994 (no 41.1). Antes ese número crudo se
// usaba tal cual para sumar al stock, para guardarse en cantidad_anulada
// (JSONB, sin tope de precisión) y para armar los mensajes de error de
// anulación parcial. Ahora se redondea a 2 decimales antes de usarse.
// Ejecutar: npm test
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const BASE = process.env.TEST_BASE_URL || 'http://localhost:4000/api';
const ADMIN_USER = process.env.TEST_ADMIN_USER || 'Admin_Sicaber';
const ADMIN_PASS = process.env.TEST_ADMIN_PASS || 'admin2024#';

let tokenAdmin;
let localId;
let proveedorId;
let insumoId;
let insumoNombre;
let compraId;
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

before(async () => {
  const login = await api('/auth/login', { method: 'POST', body: { username: ADMIN_USER, password: ADMIN_PASS } });
  assert.equal(login.status, 200, JSON.stringify(login.data));
  tokenAdmin = login.data.token;

  const locales = await api('/locales/todos', { token: tokenAdmin });
  const activo = locales.data.find((l) => l.estado === 'Activo');
  assert.ok(activo, 'se necesita al menos 1 local Activo');
  localId = activo.id;

  const prov = await api('/proveedores', {
    method: 'POST', token: tokenAdmin,
    body: { nombre: `Proveedor test decimal ${sufijo}`, tipoPersona: 'Juridica' },
  });
  assert.equal(prov.status, 201, JSON.stringify(prov.data));
  proveedorId = prov.data.id;

  insumoNombre = `Insumo test decimal ${sufijo}`;
  const ins = await api('/insumos', {
    method: 'POST', token: tokenAdmin,
    body: { nombre: insumoNombre, unidadMedida: 'kg', stockMinimo: 1, local_id: localId },
  });
  assert.equal(ins.status, 201, JSON.stringify(ins.data));
  insumoId = ins.data.id;
});

after(async () => {
  try { if (compraId) await api(`/compras/${compraId}/anular`, { method: 'PATCH', token: tokenAdmin, body: { motivo: 'Limpieza de test' } }); } catch {}
  try { if (insumoId) await api(`/insumos/${insumoId}`, { method: 'DELETE', token: tokenAdmin }); } catch {}
  try { if (proveedorId) await api(`/proveedores/${proveedorId}`, { method: 'DELETE', token: tokenAdmin }); } catch {}
});

test('POST /compras por presentación: 3 × 13.7 (ruido flotante conocido: 41.099999999999994) queda limpio en el stock', async () => {
  const r = await api('/compras', {
    method: 'POST', token: tokenAdmin,
    body: {
      proveedorId, local_id: localId, fecha: new Date().toISOString().slice(0, 10),
      total: 50000, descuento: 0,
      items: [{
        insumo: insumoNombre, cantidad: 41.1, precioUnitario: 1216.53,
        modo: 'presentacion', cantidad_presentaciones: 3, contenido_por_presentacion: 13.7,
        presentacion: { tipo: 'Unitario', cantidad: 3, contenidoPorPresentacion: 13.7, precioPresentacion: 50000 },
      }],
    },
  });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  compraId = r.data.id;

  const insumo = await api(`/insumos/${insumoId}`, { token: tokenAdmin });
  assert.equal(insumo.status, 200, JSON.stringify(insumo.data));
  const fila = insumo.data.porLocal.find((l) => l.localId === localId);
  assert.ok(fila, 'debe existir la fila insumo_local del local de la compra');
  assert.equal(Number(fila.stock), 41.1, `el stock debe quedar en 41.1 exacto, no ${fila.stock}`);
  assert.equal(String(fila.stock).includes('41.099999999999'), false, 'no debe verse el ruido binario crudo');
});

test('PATCH /compras/:id/anular (parcial): el mensaje de "pendientes de anular" muestra un número limpio, no ruido binario', async () => {
  const r = await api(`/compras/${compraId}/anular`, {
    method: 'PATCH', token: tokenAdmin,
    body: { motivo: 'Test anulación parcial — pide más de lo disponible', items: [{ insumo_id: insumoId, cantidad: 41.2 }] },
  });
  assert.equal(r.status, 400, JSON.stringify(r.data));
  assert.match(r.data.error, /solo quedan 41\.1 pendientes de anular/, `mensaje real: ${r.data.error}`);
  assert.doesNotMatch(r.data.error, /41\.099999999999/);
});

test('PATCH /compras/:id/anular (parcial real, 20): descuenta stock limpio y guarda cantidad_anulada limpia', async () => {
  const r = await api(`/compras/${compraId}/anular`, {
    method: 'PATCH', token: tokenAdmin,
    body: { motivo: 'Test anulación parcial real', items: [{ insumo_id: insumoId, cantidad: 20 }] },
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.estado, 'anulada_parcial');

  const item = r.data.items.find((it) => it.insumo_id === insumoId || it.insumo === insumoNombre);
  assert.ok(item, 'debe traer el ítem de la compra');
  assert.equal(Number(item.cantidad_anulada), 20);

  const insumo = await api(`/insumos/${insumoId}`, { token: tokenAdmin });
  const fila = insumo.data.porLocal.find((l) => l.localId === localId);
  assert.equal(Number(fila.stock), 21.1, `queda 41.1 - 20 = 21.1 exacto, no ${fila.stock}`);
});
