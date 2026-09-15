// ─────────────────────────────────────────────────────────────────────────
//  Tests de integración: Administrador/Superadministrador operan sobre
//  CUALQUIER local; los roles operativos (Cajero, Bartender) quedan
//  forzados al suyo, con 403 real si intentan otro
// ─────────────────────────────────────────────────────────────────────────
// Antes esto estaba planteado al revés: el mensaje de error decía que
// Superadministrador/Administrador "no tienen un local fijo", como si
// fuera una carencia — en realidad es la atribución del rol (pueden
// operar sobre cualquiera). Y del otro lado, un Cajero SÍ podía mandar un
// local_id distinto al suyo en una compra y el backend lo aceptaba sin
// más ("una compra puede ser para otro local" aplicaba también a roles
// operativos, que no debería).
//
// Ejecutar: npm test
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const BASE = process.env.TEST_BASE_URL || 'http://localhost:4000/api';
const ADMIN_USER = process.env.TEST_ADMIN_USER || 'Admin_Sicaber';
const ADMIN_PASS = process.env.TEST_ADMIN_PASS || 'admin2024#';

let tokenAdmin, tokenCajero;
let localA, localB;
let empleadoCajeroId;
let proveedorId;
let insumoId;
const comprasCreadas = [];
const insumosCreados = [];

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
  assert.ok(activos.length >= 2, 'se necesitan al menos 2 locales Activos');
  localA = activos[0].id;
  localB = activos[1].id;

  // Proveedor + insumo, creados libremente por el admin (necesarios para
  // registrar una compra real más abajo).
  const prov = await api('/proveedores', {
    method: 'POST', token: tokenAdmin,
    body: { nombre: `Proveedor test permisos local ${Date.now()}`, tipoPersona: 'Juridica' },
  });
  assert.equal(prov.status, 201, JSON.stringify(prov.data));
  proveedorId = prov.data.id;

  const insumoNombre = `Insumo test permisos local ${Date.now()}`;
  const ins = await api('/insumos', {
    method: 'POST', token: tokenAdmin,
    body: { nombre: insumoNombre, unidadMedida: 'kg', stockMinimo: 1, local_id: localA },
  });
  assert.equal(ins.status, 201, JSON.stringify(ins.data));
  insumoId = ins.data.id;
  insumosCreados.push(insumoId);

  // Un Cajero real, asignado a localA — el rol operativo de prueba.
  const sufijo = Date.now();
  const empleado = await api('/empleados', {
    method: 'POST', token: tokenAdmin,
    body: {
      nombre: `Cajero test permisos local ${sufijo}`, cargo: 'Cajero',
      local_id: localA, username: `cajero_test_${sufijo}`, password: 'Clave12345678#',
    },
  });
  assert.equal(empleado.status, 201, JSON.stringify(empleado.data));
  empleadoCajeroId = empleado.data.id;

  const loginCajero = await api('/auth/login', {
    method: 'POST', body: { username: `cajero_test_${sufijo}`, password: 'Clave12345678#' },
  });
  assert.equal(loginCajero.status, 200, JSON.stringify(loginCajero.data));
  tokenCajero = loginCajero.data.token;
});

after(async () => {
  for (const id of comprasCreadas) {
    try { await api(`/compras/${id}/anular`, { method: 'PATCH', token: tokenAdmin, body: { motivo: 'Limpieza de test' } }); } catch {}
  }
  try { if (insumoId) await api(`/insumos/${insumoId}`, { method: 'DELETE', token: tokenAdmin }); } catch {}
  try { if (empleadoCajeroId) await api(`/empleados/${empleadoCajeroId}`, { method: 'DELETE', token: tokenAdmin }); } catch {}
  try { if (proveedorId) await api(`/proveedores/${proveedorId}`, { method: 'DELETE', token: tokenAdmin }); } catch {}
});

const compraBody = (localId, insumoNombreOverride) => ({
  proveedorId, local_id: localId, fecha: new Date().toISOString().slice(0, 10),
  total: 10000, descuento: 0,
  items: [{ insumo: insumoNombreOverride, cantidad: 1, precioUnitario: 10000 }],
});

test('Administrador: registra una compra en localA y en localB, sin restricción', async () => {
  const insumoNombre = (await api(`/insumos/${insumoId}`, { token: tokenAdmin })).data.nombre;

  const compraA = await api('/compras', { method: 'POST', token: tokenAdmin, body: compraBody(localA, insumoNombre) });
  assert.equal(compraA.status, 201, JSON.stringify(compraA.data));
  assert.equal(compraA.data.localId, localA);
  comprasCreadas.push(compraA.data.id);

  const compraB = await api('/compras', { method: 'POST', token: tokenAdmin, body: compraBody(localB, insumoNombre) });
  assert.equal(compraB.status, 201, JSON.stringify(compraB.data));
  assert.equal(compraB.data.localId, localB);
  comprasCreadas.push(compraB.data.id);
});

test('Administrador: crea un insumo en localA y otro en localB, sin restricción', async () => {
  const sufijo = Date.now();
  const insA = await api('/insumos', { method: 'POST', token: tokenAdmin, body: { nombre: `Insumo test permisos A ${sufijo}`, unidadMedida: 'kg', stockMinimo: 1, local_id: localA } });
  assert.equal(insA.status, 201, JSON.stringify(insA.data));
  insumosCreados.push(insA.data.id);

  const insB = await api('/insumos', { method: 'POST', token: tokenAdmin, body: { nombre: `Insumo test permisos B ${sufijo}`, unidadMedida: 'kg', stockMinimo: 1, local_id: localB } });
  assert.equal(insB.status, 201, JSON.stringify(insB.data));
  insumosCreados.push(insB.data.id);
});

test('Cajero: registra una compra en SU PROPIO local (localA) sin problema', async () => {
  const insumoNombre = (await api(`/insumos/${insumoId}`, { token: tokenAdmin })).data.nombre;
  const r = await api('/compras', { method: 'POST', token: tokenCajero, body: compraBody(localA, insumoNombre) });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.localId, localA);
  comprasCreadas.push(r.data.id);
});

test('Cajero: 403 al intentar registrar una compra en un local ajeno (localB)', async () => {
  const insumoNombre = (await api(`/insumos/${insumoId}`, { token: tokenAdmin })).data.nombre;
  const r = await api('/compras', { method: 'POST', token: tokenCajero, body: compraBody(localB, insumoNombre) });
  assert.equal(r.status, 403, JSON.stringify(r.data));
  assert.match(r.data.error, /no puedes operar sobre un local distinto al tuyo/i);
});

test('Cajero: 403 al intentar crear un insumo en un local ajeno (localB)', async () => {
  const r = await api('/insumos', {
    method: 'POST', token: tokenCajero,
    body: { nombre: `Insumo test cajero ajeno ${Date.now()}`, unidadMedida: 'kg', stockMinimo: 1, local_id: localB },
  });
  assert.equal(r.status, 403, JSON.stringify(r.data));
  assert.match(r.data.error, /no puedes operar sobre un local distinto al tuyo/i);
});

test('Superadministrador: el mensaje de "sin local" invita a elegir, no dice que le falta uno', async () => {
  const r = await api('/insumos', { method: 'POST', token: tokenAdmin, body: { nombre: `Insumo test mensaje admin ${Date.now()}`, unidadMedida: 'kg', stockMinimo: 1 } });
  // Admin_Sicaber es Superadministrador y no tiene local_id propio: sin
  // local_id en el body, debe pedir que elija — nunca un 403.
  assert.equal(r.status, 400, JSON.stringify(r.data));
  assert.match(r.data.error, /puedes operar sobre cualquier local/i);
  assert.doesNotMatch(r.data.error, /no tien(es|e) un local fijo/i);
});
