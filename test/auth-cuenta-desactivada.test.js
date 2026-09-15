// ─────────────────────────────────────────────────────────────────────────
//  Una cuenta desactivada (usuario o cliente) no puede iniciar sesión, y
//  un token YA EMITIDO antes de la desactivación deja de servir en la
//  siguiente petición — no solo en el login.
// ─────────────────────────────────────────────────────────────────────────
// Bug real que esto cubre: ni POST /auth/login, ni POST /auth/cliente/
// login, ni el middleware `auth` revisaban `estado` — "desactivar" una
// cuenta (a mano, o en cascada al desactivar su rol — Ronda 25) no le
// cortaba el acceso: podía seguir logueándose, y un token ya emitido
// seguía funcionando hasta que expirara solo (hasta 8h).
//
// Ejecutar: npm test
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const BASE = process.env.TEST_BASE_URL || 'http://localhost:4000/api';
const ADMIN_USER = process.env.TEST_ADMIN_USER || 'Admin_Sicaber';
const ADMIN_PASS = process.env.TEST_ADMIN_PASS || 'admin2024#';

let tokenAdmin;
let usuarioId;
let clienteId;
let localA;
const sufijo = Date.now();
const USERNAME = `usr_desactivado_${sufijo}`;
const PASSWORD = 'Clave123456#';
const CORREO_CLIENTE = `cliente.desactivado.${sufijo}@example.com`;

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

  const usuario = await api('/usuarios', {
    method: 'POST', token: tokenAdmin,
    body: { nombre: 'Usuario Desactivado Test', username: USERNAME, password: PASSWORD, rol: 'Bartender', sede: 'Local 1' },
  });
  assert.equal(usuario.status, 201, JSON.stringify(usuario.data));
  usuarioId = usuario.data.id;

  const registro = await api('/auth/cliente/registro', {
    method: 'POST',
    body: { nombre: 'Cliente Desactivado Test', correo: CORREO_CLIENTE, password: PASSWORD },
  });
  assert.equal(registro.status, 201, JSON.stringify(registro.data));
});

after(async () => {
  if (usuarioId) { try { await api(`/usuarios/${usuarioId}`, { method: 'DELETE', token: tokenAdmin }); } catch {} }
  if (clienteId) { try { await api(`/clientes/${clienteId}`, { method: 'DELETE', token: tokenAdmin }); } catch {} }
});

test('Usuario Activo: login normal (200)', async () => {
  const r = await api('/auth/login', { method: 'POST', body: { username: USERNAME, password: PASSWORD } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.ok(r.data.token);
});

test('Usuario Inactivo: login rechazado (403), mensaje claro', async () => {
  const estado = await api(`/usuarios/${usuarioId}/estado`, { method: 'PATCH', token: tokenAdmin });
  assert.equal(estado.status, 200, JSON.stringify(estado.data));
  assert.equal(estado.data.estado, 'Inactivo');

  const r = await api('/auth/login', { method: 'POST', body: { username: USERNAME, password: PASSWORD } });
  assert.equal(r.status, 403, JSON.stringify(r.data));
  assert.equal(r.data.error, 'Tu cuenta está desactivada. Contacta a un administrador.');

  // Reactivar para el siguiente test.
  await api(`/usuarios/${usuarioId}/estado`, { method: 'PATCH', token: tokenAdmin });
});

test('Token ya emitido pierde acceso en la SIGUIENTE petición tras desactivar la cuenta (no espera a que expire)', async () => {
  const login = await api('/auth/login', { method: 'POST', body: { username: USERNAME, password: PASSWORD } });
  assert.equal(login.status, 200, JSON.stringify(login.data));
  const tokenUsuario = login.data.token;

  // El token, recién emitido, todavía funciona.
  const antes = await api('/auth/me', { token: tokenUsuario });
  assert.equal(antes.status, 200, JSON.stringify(antes.data));

  // Se desactiva la cuenta DESPUÉS de emitido el token (sin volver a loguear).
  const estado = await api(`/usuarios/${usuarioId}/estado`, { method: 'PATCH', token: tokenAdmin });
  assert.equal(estado.status, 200, JSON.stringify(estado.data));
  assert.equal(estado.data.estado, 'Inactivo');

  // Mismo token de antes — debe perder acceso YA, sin esperar su expiración.
  const despues = await api('/auth/me', { token: tokenUsuario });
  assert.equal(despues.status, 403, JSON.stringify(despues.data));
  assert.equal(despues.data.error, 'Tu cuenta está desactivada. Contacta a un administrador.');

  // Cualquier otra ruta protegida por `auth` también debe rechazarlo, no
  // solo /auth/me.
  const otraRuta = await api('/pedidos', { token: tokenUsuario });
  assert.equal(otraRuta.status, 403, JSON.stringify(otraRuta.data));

  await api(`/usuarios/${usuarioId}/estado`, { method: 'PATCH', token: tokenAdmin }); // reactivar
});

test('Cliente Activo: login normal (200)', async () => {
  const r = await api('/auth/cliente/login', { method: 'POST', body: { correo: CORREO_CLIENTE, password: PASSWORD } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  clienteId = r.data.cliente.id;
  assert.ok(r.data.token);
});

test('Cliente Inactivo: login rechazado (403), y su token previo también pierde acceso', async () => {
  const login = await api('/auth/cliente/login', { method: 'POST', body: { correo: CORREO_CLIENTE, password: PASSWORD } });
  assert.equal(login.status, 200, JSON.stringify(login.data));
  const tokenCliente = login.data.token;

  const estado = await api(`/clientes/${clienteId}/estado`, { method: 'PATCH', token: tokenAdmin });
  assert.equal(estado.status, 200, JSON.stringify(estado.data));

  const rLogin = await api('/auth/cliente/login', { method: 'POST', body: { correo: CORREO_CLIENTE, password: PASSWORD } });
  assert.equal(rLogin.status, 403, JSON.stringify(rLogin.data));
  assert.equal(rLogin.data.error, 'Tu cuenta está desactivada. Contacta a un administrador.');

  const rMe = await api('/auth/me', { token: tokenCliente });
  assert.equal(rMe.status, 403, JSON.stringify(rMe.data), 'el token del cliente, emitido ANTES de desactivarlo, debe perder acceso ya');

  await api(`/clientes/${clienteId}/estado`, { method: 'PATCH', token: tokenAdmin }); // reactivar
});

test('authOpcional: un token de cuenta desactivada se degrada a "anónimo" (no bloquea, ver POST /pedidos)', async () => {
  const login = await api('/auth/cliente/login', { method: 'POST', body: { correo: CORREO_CLIENTE, password: PASSWORD } });
  assert.equal(login.status, 200, JSON.stringify(login.data));
  const tokenCliente = login.data.token;

  await api(`/clientes/${clienteId}/estado`, { method: 'PATCH', token: tokenAdmin }); // desactivar

  // POST /pedidos usa authOpcional: nunca debe rechazar por esto — debe
  // seguir aceptando el pedido como si no hubiera token (público), no
  // tirar un 403 ni un 500.
  const pedido = await api('/pedidos', {
    method: 'POST', token: tokenCliente,
    body: { cliente: 'Pedido con token de cliente desactivado', alias: `alias-authopc-${sufijo}`, tipo: 'local', local_id: localA, total: 1000, items: [], origen: 'landing', pago: 'nequi' },
  });
  assert.notEqual(pedido.status, 403, JSON.stringify(pedido.data));
  assert.notEqual(pedido.status, 500, JSON.stringify(pedido.data));

  if (pedido.status === 201) { try { await api(`/pedidos/${pedido.data.id}`, { method: 'DELETE', token: tokenAdmin }); } catch {} }
  await api(`/clientes/${clienteId}/estado`, { method: 'PATCH', token: tokenAdmin }); // reactivar
});
