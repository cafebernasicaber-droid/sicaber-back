// ─────────────────────────────────────────────────────────────────────────
//  Test de integración: el comprobante de una compra es SIEMPRE opcional,
//  y el detalle informa explícitamente si lo tiene (Ronda 31)
// ─────────────────────────────────────────────────────────────────────────
// El backend NUNCA exigió comprobante_url en /compras (ni NOT NULL en el
// esquema, ni ninguna validación) — la obligatoriedad que existía era
// solo del formulario del frontend (CompraForm.jsx / RegistrarCompraPage.jsx,
// disparada cuando algún ítem no era "Unitario"), ya retirada. Este test
// confirma, contra la API real, que una compra SIN comprobante_url se
// crea sin problema sea cual sea el modo de sus ítems, y que el campo
// nuevo "tieneComprobante" (GET /compras, /historial y /:id — todos usan
// COMPRA_COLS) refleja fielmente si ese campo está lleno o no.
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
const comprasCreadas = [];
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
    body: { nombre: `Proveedor test comprobante opcional ${sufijo}`, tipoPersona: 'Juridica' },
  });
  assert.equal(prov.status, 201, JSON.stringify(prov.data));
  proveedorId = prov.data.id;

  insumoNombre = `Insumo test comprobante opcional ${sufijo}`;
  const ins = await api('/insumos', {
    method: 'POST', token: tokenAdmin,
    body: { nombre: insumoNombre, unidadMedida: 'kg', stockMinimo: 1, local_id: localId },
  });
  assert.equal(ins.status, 201, JSON.stringify(ins.data));
  insumoId = ins.data.id;
});

after(async () => {
  for (const id of comprasCreadas) {
    try { await api(`/compras/${id}/anular`, { method: 'PATCH', token: tokenAdmin, body: { motivo: 'Limpieza de test' } }); } catch {}
  }
  try { if (insumoId) await api(`/insumos/${insumoId}`, { method: 'DELETE', token: tokenAdmin }); } catch {}
  try { if (proveedorId) await api(`/proveedores/${proveedorId}`, { method: 'DELETE', token: tokenAdmin }); } catch {}
});

test('POST /compras por presentación (no "Unitario") SIN comprobante_url: se crea igual, sin exigirlo', async () => {
  const r = await api('/compras', {
    method: 'POST', token: tokenAdmin,
    body: {
      proveedorId, local_id: localId, fecha: new Date().toISOString().slice(0, 10),
      total: 50000, descuento: 0,
      items: [{
        insumo: insumoNombre, cantidad: 10, precioUnitario: 5000,
        modo: 'presentacion', cantidad_presentaciones: 2, contenido_por_presentacion: 5,
        presentacion: { tipo: 'Caja', cantidad: 2, contenidoPorPresentacion: 5, precioPresentacion: 50000 },
      }],
      // comprobante_url deliberadamente ausente
    },
  });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  comprasCreadas.push(r.data.id);
  assert.equal(r.data.comprobante_url ?? null, null);
  assert.equal(r.data.tieneComprobante, false);
});

test('GET /compras/:id: tieneComprobante=false para la compra sin comprobante de arriba', async () => {
  const [id] = comprasCreadas;
  const r = await api(`/compras/${id}`, { token: tokenAdmin });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.tieneComprobante, false);
});

test('POST /compras CON comprobante_url: tieneComprobante=true, y se ve así en /compras, /historial y /:id', async () => {
  const r = await api('/compras', {
    method: 'POST', token: tokenAdmin,
    body: {
      proveedorId, local_id: localId, fecha: new Date().toISOString().slice(0, 10),
      total: 10000, descuento: 0,
      items: [{ insumo: insumoNombre, cantidad: 1, precioUnitario: 10000 }],
      comprobante_url: 'https://res.cloudinary.com/dwkdxelo4/image/upload/comprobante-test.png',
    },
  });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const id = r.data.id;
  comprasCreadas.push(id);
  assert.equal(r.data.tieneComprobante, true);

  const detalle = await api(`/compras/${id}`, { token: tokenAdmin });
  assert.equal(detalle.data.tieneComprobante, true);

  const listado = await api('/compras', { token: tokenAdmin });
  const enListado = listado.data.find((c) => c.id === id);
  assert.ok(enListado, 'debe aparecer en el listado de compras activas');
  assert.equal(enListado.tieneComprobante, true);
});
