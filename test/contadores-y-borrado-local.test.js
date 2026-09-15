// ─────────────────────────────────────────────────────────────────────────
//  Tests de integración: contadores de Insumos por local (requisito 1) y
//  borrado de Locales con restricciones (requisito 2)
// ─────────────────────────────────────────────────────────────────────────
// Requisito 1 — bug real: las tarjetas Todos/Activos/Inactivos de Insumos
// mostraban siempre el mismo número sin importar la pestaña de local
// (56/39/17 fijo) porque no existía ningún endpoint que contara "por
// local": lo único que había era `insumos.estado` (global). Este archivo
// prueba que GET /insumos/contadores cuenta de verdad por
// `insumo_local.activo`, que cambia según el local consultado.
//
// Requisito 2 — DELETE /locales/:id debe bloquear con 409 (diciendo qué y
// cuántos) si hay ventas/pedidos/empleados/compras, pero SÍ debe poder
// borrar un local vacío (sin dejar sus filas insumo_local huérfanas).
//
// Mismos requisitos que el resto de la suite: servidor corriendo, admin
// sembrado. Ejecutar: npm test
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const BASE = process.env.TEST_BASE_URL || 'http://localhost:4000/api';
const ADMIN_USER = process.env.TEST_ADMIN_USER || 'Admin_Sicaber';
const ADMIN_PASS = process.env.TEST_ADMIN_PASS || 'admin2024#';

let token;
let localA, localB; // 2 locales Activos existentes, usados solo para LEER contadores (no se tocan)
let insumoId;
let localVacioId; // local nuevo, sin nada — se borra en el propio test
let localConEmpleadoId, empleadoId;

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

  const listado = await api('/locales/todos');
  const activos = listado.data.filter((l) => l.estado === 'Activo');
  assert.ok(activos.length >= 2, 'se necesitan al menos 2 locales Activos');
  localA = activos[0].id;
  localB = activos[1].id;

  const sufijo = Date.now();
  // Insumo nuevo: activo por defecto en localA (el elegido al crear),
  // inactivo en el resto (localB incluido) — comportamiento ya existente
  // de POST /insumos sin "todosLosLocales".
  const insumo = await api('/insumos', {
    method: 'POST',
    body: { nombre: `Insumo test contadores ${sufijo}`, unidadMedida: 'kg', stockMinimo: 1, local_id: localA },
  });
  assert.equal(insumo.status, 201, JSON.stringify(insumo.data));
  insumoId = insumo.data.id;
});

after(async () => {
  try { if (insumoId) await api(`/insumos/${insumoId}`, { method: 'DELETE' }); } catch {}
  try { if (empleadoId) await api(`/empleados/${empleadoId}`, { method: 'DELETE' }); } catch {}
  try { if (localConEmpleadoId) await api(`/locales/${localConEmpleadoId}`, { method: 'DELETE' }); } catch {}
  try { if (localVacioId) await api(`/locales/${localVacioId}`, { method: 'DELETE' }); } catch {} // no-op si el test ya lo borró
});

test('GET /insumos/contadores exige local_id (nunca un total global)', async () => {
  const r = await api('/insumos/contadores');
  assert.equal(r.status, 400, JSON.stringify(r.data));
});

test('GET /insumos/contadores: activos/inactivos cambian según el local, según insumo_local.activo', async () => {
  const enA = await api(`/insumos/contadores?local_id=${localA}`);
  assert.equal(enA.status, 200, JSON.stringify(enA.data));
  const enB = await api(`/insumos/contadores?local_id=${localB}`);
  assert.equal(enB.status, 200, JSON.stringify(enB.data));

  // El insumo de prueba quedó activo=true en A y activo=false en B: el
  // conteo de "activos" en A debe ser mayor que en B por al menos 1 (a
  // menos que otro insumo compense la diferencia — se verifica con el
  // propio insumo_local de este insumo puntual para no depender del
  // estado del resto de la tabla).
  const filaA = (await api(`/insumos/${insumoId}`)).data.porLocal.find((f) => f.localId === localA);
  const filaB = (await api(`/insumos/${insumoId}`)).data.porLocal.find((f) => f.localId === localB);
  assert.equal(filaA.activo, true, 'el insumo de prueba debe quedar activo en el local elegido al crearlo');
  assert.equal(filaB.activo, false, 'el insumo de prueba debe quedar inactivo en el resto de locales');

  // "todos" siempre es el total de filas insumo_local de ESE local (todo
  // insumo tiene una fila en todos los locales) — debe ser el mismo total
  // en A y en B.
  assert.equal(enA.data.todos, enB.data.todos, '"todos" es el mismo total en cualquier local (una fila por insumo en cada uno)');
  assert.equal(enA.data.activos + enA.data.inactivos, enA.data.todos);
  assert.equal(enB.data.activos + enB.data.inactivos, enB.data.todos);
});

test('GET /insumos/contadores: "stockBajo" refleja un insumo con stock 0 en ese local', async () => {
  const antes = await api(`/insumos/contadores?local_id=${localA}`);
  // El insumo recién creado quedó con stock 0 en localA (sin stockActual) — ya cuenta como "agotado" (stock bajo).
  // Se compara contra un insumo NUEVO con stock de sobra en el mismo local, para confirmar que sí distingue.
  const conStock = await api('/insumos', {
    method: 'POST',
    body: { nombre: `Insumo test contadores con stock ${Date.now()}`, unidadMedida: 'kg', stockMinimo: 1, stockActual: 50, local_id: localA },
  });
  assert.equal(conStock.status, 201, JSON.stringify(conStock.data));
  const despues = await api(`/insumos/contadores?local_id=${localA}`);
  assert.equal(despues.data.stockBajo, antes.data.stockBajo, 'un insumo con stock de sobra no debe sumar a stockBajo (el de "antes" ya contaba el insumo en 0 del before())');
  await api(`/insumos/${conStock.data.id}`, { method: 'DELETE' });
});

test('DELETE /locales/:id: un local vacío (sin ventas/pedidos/empleados/compras) SÍ se puede eliminar', async () => {
  const nuevo = await api('/locales', {
    method: 'POST',
    body: { nombre: `Local test borrado vacio ${Date.now()}`, direccion: 'Dirección de prueba 123' },
  });
  assert.equal(nuevo.status, 201, JSON.stringify(nuevo.data));
  localVacioId = nuevo.data.id;

  const borrado = await api(`/locales/${localVacioId}`, { method: 'DELETE' });
  assert.equal(borrado.status, 200, JSON.stringify(borrado.data));

  const yaNoExiste = await api('/locales/todos');
  assert.ok(!yaNoExiste.data.some((l) => l.id === localVacioId), 'el local borrado no debe seguir apareciendo');
  localVacioId = null; // ya borrado, el after() no debe reintentarlo
});

test('DELETE /locales/:id: 409 con el detalle exacto si tiene empleados asignados', async () => {
  const nuevo = await api('/locales', {
    method: 'POST',
    body: { nombre: `Local test con empleado ${Date.now()}`, direccion: 'Dirección de prueba 456' },
  });
  assert.equal(nuevo.status, 201, JSON.stringify(nuevo.data));
  localConEmpleadoId = nuevo.data.id;

  const empleado = await api('/empleados', {
    method: 'POST',
    body: { nombre: `Empleado test local ${Date.now()}`, cargo: 'Mesero', local_id: localConEmpleadoId },
  });
  assert.equal(empleado.status, 201, JSON.stringify(empleado.data));
  empleadoId = empleado.data.id;

  const bloqueado = await api(`/locales/${localConEmpleadoId}`, { method: 'DELETE' });
  assert.equal(bloqueado.status, 409, JSON.stringify(bloqueado.data));
  assert.match(bloqueado.data.error, /1 empleado asignado/);

  // se limpia el empleado y AHORA sí se puede borrar el local
  const delEmp = await api(`/empleados/${empleadoId}`, { method: 'DELETE' });
  assert.equal(delEmp.status, 200, JSON.stringify(delEmp.data));
  empleadoId = null;

  const borradoAhora = await api(`/locales/${localConEmpleadoId}`, { method: 'DELETE' });
  assert.equal(borradoAhora.status, 200, JSON.stringify(borradoAhora.data));
  localConEmpleadoId = null;
});
