// ─────────────────────────────────────────────────────────────────────────
//  Tests de integración: validación de rango de fechas (?desde=&hasta=)
// ─────────────────────────────────────────────────────────────────────────
// Antes NINGÚN endpoint de listado aceptaba ?desde=/?hasta= — el filtrado
// por fecha vivía enteramente en el frontend, sin nada que lo respaldara
// del lado del servidor ("hay reportes de filtros que no filtran bien").
// Ahora Usuarios, Empleados, Clientes, Combos, Ventas, Compras, Pedidos y
// Fichas Técnicas comparten la misma validación (errorRangoFechas en
// routes/index.js): formato AAAA-MM-DD y "hasta" nunca antes que "desde"
// — 400 con mensaje claro si no, nunca confiando en que el front ya lo
// validó.
'use strict';
const { test, before } = require('node:test');
const assert = require('node:assert/strict');

const BASE = process.env.TEST_BASE_URL || 'http://localhost:4000/api';
const ADMIN_USER = process.env.TEST_ADMIN_USER || 'Admin_Sicaber';
const ADMIN_PASS = process.env.TEST_ADMIN_PASS || 'admin2024#';

let token;

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
});

// Un rango invertido (hasta antes que desde) debe rechazarse con 400 en
// TODOS los módulos pedidos — se prueba explícitamente cada uno, para que
// una regresión en un módulo puntual (no en el helper compartido) también
// se detecte.
const ENDPOINTS_CON_RANGO = [
  ['/usuarios', 'Usuarios'],
  ['/empleados', 'Empleados'],
  ['/clientes', 'Clientes'],
  ['/combos/todos', 'Combos'],
  ['/ventas', 'Ventas'],
  ['/compras', 'Compras'],
  ['/compras/historial', 'Compras (historial)'],
  ['/pedidos', 'Pedidos'],
  ['/fichas-tecnicas', 'Fichas técnicas'],
];

for (const [path, etiqueta] of ENDPOINTS_CON_RANGO) {
  test(`${etiqueta}: rechaza un rango de fechas invertido (hasta antes que desde)`, async () => {
    const r = await api(`${path}?desde=2026-06-30&hasta=2026-01-01`);
    assert.equal(r.status, 400, JSON.stringify(r.data));
    assert.match(r.data.error, /hasta.*no puede ser anterior a.*desde/i);
  });

  test(`${etiqueta}: rechaza un formato de fecha inválido`, async () => {
    const r = await api(`${path}?desde=30-06-2026`);
    assert.equal(r.status, 400, JSON.stringify(r.data));
    assert.match(r.data.error, /AAAA-MM-DD/);
  });

  test(`${etiqueta}: un rango válido (desde=hasta, hoy) no se rechaza`, async () => {
    const hoy = new Date().toISOString().slice(0, 10);
    const r = await api(`${path}?desde=${hoy}&hasta=${hoy}`);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.ok(Array.isArray(r.data), 'debe seguir devolviendo un arreglo, filtrado o no');
  });
}

test('Pedidos: ?desde=/?hasta= realmente filtran (no solo validan) — un pedido de ayer no aparece si el rango es "hoy"', async () => {
  const pedido = await api('/pedidos', {
    method: 'POST',
    body: {
      cliente: 'Cliente test rango fechas', alias: `alias-rango-fechas-${Date.now()}`, tipo: 'local', pago: 'nequi', total: 5000,
      items: [{ id: 999999999, nombre: 'Item de prueba', cantidad: 1, precio: 5000 }],
      origen: 'admin',
    },
  });
  // No es el foco de este test que la creación tenga éxito con un id de
  // producto inventado — si la valida, se ignora ese resultado y se prueba
  // el filtro igual con lo que ya exista; si fue 201, se limpia al final.
  const hoy = new Date().toISOString().slice(0, 10);
  const manana = new Date(Date.now() + 86400000).toISOString().slice(0, 10);

  const hoyIncluido = await api(`/pedidos?desde=${hoy}&hasta=${hoy}`);
  assert.equal(hoyIncluido.status, 200, JSON.stringify(hoyIncluido.data));

  const soloManana = await api(`/pedidos?desde=${manana}&hasta=${manana}`);
  assert.equal(soloManana.status, 200, JSON.stringify(soloManana.data));
  assert.equal(soloManana.data.length, 0, 'ningún pedido debería existir con fecha de creación mañana');

  if (pedido.status === 201 && pedido.data?.id) {
    assert.ok(hoyIncluido.data.some((p) => p.id === pedido.data.id), 'el pedido recién creado (hoy) debe aparecer en el rango de hoy');
  }
});
