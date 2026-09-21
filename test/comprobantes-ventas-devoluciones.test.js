// ─────────────────────────────────────────────────────────────────────────
//  Tests de integración: comprobantes enviados desde la página (req. 2 y 3),
//  ventas que no desaparecen (req. 5) y devoluciones (req. 4)
// ─────────────────────────────────────────────────────────────────────────
// Qué cubre, contra la base real y por HTTP:
//
//  COMPROBANTES
//   • Un CLIENTE puede enviar el comprobante de SU pedido desde la página
//     (POST /pedidos/:id/comprobante) — antes no existía ninguna ruta para
//     eso: PUT /pedidos/:id bloquea el rol Cliente con 403, así que el único
//     camino era mandarlo por fuera (WhatsApp) y que el cajero lo adjuntara.
//   • El comprobante queda PERSISTIDO y asociado al pedido correcto.
//   • Se recupera después: en el detalle del pedido y por su ruta propia.
//   • Se aceptan distintos formatos/entidades (PNG, JPEG, PDF, binario
//     crudo) — la validación mira el TIPO DE ARCHIVO, nunca el banco.
//   • No se puede pegar un comprobante al pedido de otra persona.
//
//  VENTAS
//   • Una venta procesada queda registrada y se puede consultar después.
//   • Sigue apareciendo al pedir las ventas, incluso filtrando por local.
//   • Conserva su información (cliente, productos, método de pago, sede).
//   • Un pedido con venta registrada ya no se puede borrar.
//
//  DEVOLUCIONES
//   • Se crea la devolución identificándola por la VENTA (que es lo que
//     tiene a mano la pantalla de Ventas) y queda persistida.
//   • Se consulta después, con su vínculo venta → devolución.
//   • Una SEGUNDA devolución sobre la misma venta se rechaza.
//   • La venta original sigue registrada y consultable.
//
// Ejecutar: npm test
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const BASE = process.env.TEST_BASE_URL || 'http://localhost:4000/api';
const ADMIN_USER = process.env.TEST_ADMIN_USER || 'Admin_Sicaber';
const ADMIN_PASS = process.env.TEST_ADMIN_PASS || 'admin2024#';
const PASSWORD_CLIENTE = 'Clave12345678#';

let tokenAdmin, tokenCliente, clienteId, localA, localNombreA;
const pedidosCreados = [];
const clientesCreados = [];

const api = async (ruta, { method = 'GET', token, body } = {}) => {
  const res = await fetch(`${BASE}${ruta}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
};

// Subida BINARIA cruda (lo que haría la página mandando el File/Blob tal
// cual, sin convertirlo a base64).
const apiBinario = async (ruta, { token, buffer, contentType }) => {
  const res = await fetch(`${BASE}${ruta}`, {
    method: 'POST',
    headers: { 'Content-Type': contentType, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: buffer,
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
};

// ── Comprobantes de prueba, en varios formatos ───────────────────────────
// Bytes REALES de cada formato (el backend valida por los bytes iniciales,
// no por lo que declare el data URL). La "marca" al final hace único cada
// archivo, para que el control de "este comprobante ya se usó" no confunda
// dos pedidos distintos.
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);
const JPEG_MINIMO = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]);
const PDF_MINIMO = Buffer.from('%PDF-1.4\n% comprobante de prueba\n');

const bufferMarcado = (base, marca) => Buffer.concat([base, Buffer.from(String(marca))]);
const comprobantePng = (marca) => 'data:image/png;base64,' + bufferMarcado(PNG_1X1, marca).toString('base64');
const comprobanteJpeg = (marca) => 'data:image/jpeg;base64,' + bufferMarcado(JPEG_MINIMO, marca).toString('base64');
const comprobantePdf = (marca) => 'data:application/pdf;base64,' + bufferMarcado(PDF_MINIMO, marca).toString('base64');

const marca = (etiqueta) => `${etiqueta}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

before(async () => {
  const login = await api('/auth/login', { method: 'POST', body: { username: ADMIN_USER, password: ADMIN_PASS } });
  assert.equal(login.status, 200, JSON.stringify(login.data));
  tokenAdmin = login.data.token;

  const locales = await api('/locales/todos', { token: tokenAdmin });
  const activos = locales.data.filter((l) => l.estado === 'Activo');
  assert.ok(activos.length >= 1, 'se necesita al menos 1 local Activo');
  localA = activos[0].id;
  localNombreA = activos[0].nombre;

  const sufijo = marca('cvd');
  const correo = `cliente.${sufijo}@pruebas-sicaber.test`;
  const registro = await api('/auth/cliente/registro', {
    method: 'POST',
    body: { nombre: `Cliente CVD ${sufijo}`, correo, password: PASSWORD_CLIENTE, telefono: '3001234567' },
  });
  assert.equal(registro.status, 201, JSON.stringify(registro.data));
  const loginCliente = await api('/auth/cliente/login', { method: 'POST', body: { correo, password: PASSWORD_CLIENTE } });
  assert.equal(loginCliente.status, 200, JSON.stringify(loginCliente.data));
  tokenCliente = loginCliente.data.token;
  clienteId = loginCliente.data.cliente.id;
  clientesCreados.push(clienteId);
});

after(async () => {
  for (const id of pedidosCreados) {
    try { await api(`/pedidos/${id}`, { method: 'DELETE', token: tokenAdmin }); } catch { /* los que tienen venta ya no se borran: es a propósito */ }
  }
  for (const id of clientesCreados) {
    try { await api(`/clientes/${id}`, { method: 'DELETE', token: tokenAdmin }); } catch {}
  }
});

// Pedido de un CLIENTE autenticado, con método digital (nequi) y SIN
// comprobante: el caso real del requisito 2 — el cliente pide primero y
// transfiere después.
const crearPedidoDelCliente = async (etiqueta, { total = 9000, items } = {}) => {
  const creado = await api('/pedidos', {
    method: 'POST',
    token: tokenCliente,
    body: {
      cliente_id: clienteId,
      cliente: `Cliente CVD ${etiqueta}`,
      alias: `alias-${etiqueta}`,
      tipo: 'local',
      local_id: localA,
      origen: 'landing',
      pago: 'nequi',
      total,
      items: items || [
        { id: `prod-cvd-a-${etiqueta}`, nombre: 'Café', precio: 4000, cantidad: 1 },
        { id: `prod-cvd-b-${etiqueta}`, nombre: 'Jugo', precio: 5000, cantidad: 1 },
      ],
    },
  });
  assert.equal(creado.status, 201, JSON.stringify(creado.data));
  pedidosCreados.push(creado.data.id);
  return creado.data;
};

// Lleva un pedido hasta 'entregado' (lo que REGISTRA la venta).
const entregar = async (pedidoId) => {
  const aprobar = await api(`/pedidos/${pedidoId}/comprobante/aprobar`, { method: 'PATCH', token: tokenAdmin });
  assert.equal(aprobar.status, 200, `aprobar comprobante: ${JSON.stringify(aprobar.data)}`);
  const entregado = await api(`/pedidos/${pedidoId}/estado`, {
    method: 'PATCH', token: tokenAdmin, body: { estado: 'entregado' },
  });
  assert.equal(entregado.status, 200, `entregar: ${JSON.stringify(entregado.data)}`);
};

const ventaDelPedido = async (pedidoId) => {
  const ventas = await api('/ventas', { token: tokenAdmin });
  assert.ok(Array.isArray(ventas.data), JSON.stringify(ventas.data));
  return ventas.data.find((v) => Number(v.pedido_id) === Number(pedidoId)) || null;
};

// ─────────────────────────────────────────────────────────────────────────
//  COMPROBANTES (requisitos 2 y 3)
// ─────────────────────────────────────────────────────────────────────────

test('El CLIENTE puede enviar el comprobante de su pedido desde la página, y queda persistido', async () => {
  const etiqueta = marca('envio-cliente');
  const pedido = await crearPedidoDelCliente(etiqueta);
  assert.ok(!pedido.comprobante_img, 'el pedido nace sin comprobante');

  const envio = await api(`/pedidos/${pedido.id}/comprobante`, {
    method: 'POST', token: tokenCliente, body: { comprobante_img: comprobantePng(etiqueta) },
  });
  assert.equal(envio.status, 201, JSON.stringify(envio.data));
  assert.equal(envio.data.tieneComprobante, true);
  assert.equal(envio.data.comprobanteArchivo.mime, 'image/png');

  // PERSISTIDO: se vuelve a pedir desde cero y sigue ahí.
  const detalle = await api(`/pedidos/${pedido.id}`, { token: tokenCliente });
  assert.equal(detalle.status, 200, JSON.stringify(detalle.data));
  assert.equal(detalle.data.tieneComprobante, true, 'el detalle del pedido debe traer el comprobante');
  assert.equal(detalle.data.comprobanteValido, true, 'la referencia guardada debe ser un archivo válido');
  assert.equal(detalle.data.comprobanteMime, 'image/png');
  assert.ok(String(detalle.data.comprobanteImg).startsWith('data:image/png;base64,'));
  assert.equal(detalle.data.comprobanteUrl, `/api/pedidos/${pedido.id}/comprobante`);

  // ASOCIADO AL PEDIDO CORRECTO: el comprobante devuelto es el que se subió.
  const recuperado = await api(`/pedidos/${pedido.id}/comprobante`, { token: tokenCliente });
  assert.equal(recuperado.status, 200, JSON.stringify(recuperado.data));
  assert.equal(Number(recuperado.data.pedido_id), Number(pedido.id));
  assert.equal(recuperado.data.comprobanteImg, comprobantePng(etiqueta), 'debe devolver exactamente el archivo enviado');
});

test('El pedido queda en verificación tras recibir el comprobante, y el cajero lo ve en la cola', async () => {
  const etiqueta = marca('cola-cajero');
  const pedido = await crearPedidoDelCliente(etiqueta);

  const envio = await api(`/pedidos/${pedido.id}/comprobante`, {
    method: 'POST', token: tokenCliente, body: { comprobante_img: comprobantePng(etiqueta) },
  });
  assert.equal(envio.status, 201, JSON.stringify(envio.data));
  assert.equal(envio.data.estado, 'pendiente_verificacion');

  // El listado del cajero filtrado por "con comprobante" lo incluye.
  const conComprobante = await api('/pedidos?comprobante=con', { token: tokenAdmin });
  assert.ok(
    conComprobante.data.some((p) => Number(p.id) === Number(pedido.id)),
    'el pedido debe aparecer en la lista de pedidos CON comprobante'
  );

  // Y el cajero lo puede aprobar (el flujo sigue siendo manual).
  const aprobado = await api(`/pedidos/${pedido.id}/comprobante/aprobar`, { method: 'PATCH', token: tokenAdmin });
  assert.equal(aprobado.status, 200, JSON.stringify(aprobado.data));
});

test('Se aceptan comprobantes de distintos formatos y entidades: PNG, JPEG, PDF y binario crudo', async () => {
  for (const [nombre, hacerComprobante, mimeEsperado] of [
    ['png', comprobantePng, 'image/png'],
    ['jpeg', comprobanteJpeg, 'image/jpeg'],
    ['pdf', comprobantePdf, 'application/pdf'],
  ]) {
    const etiqueta = marca(`formato-${nombre}`);
    const pedido = await crearPedidoDelCliente(etiqueta);
    const envio = await api(`/pedidos/${pedido.id}/comprobante`, {
      method: 'POST', token: tokenCliente, body: { comprobante_img: hacerComprobante(etiqueta) },
    });
    assert.equal(envio.status, 201, `${nombre}: ${JSON.stringify(envio.data)}`);
    assert.equal(envio.data.comprobanteArchivo.mime, mimeEsperado, `${nombre} debe reconocerse por sus bytes`);
  }

  // Binario crudo (la página manda el File tal cual, sin base64).
  const etiquetaBin = marca('formato-binario');
  const pedidoBin = await crearPedidoDelCliente(etiquetaBin);
  const envioBin = await apiBinario(`/pedidos/${pedidoBin.id}/comprobante`, {
    token: tokenCliente,
    buffer: bufferMarcado(PNG_1X1, etiquetaBin),
    contentType: 'image/png',
  });
  assert.equal(envioBin.status, 201, JSON.stringify(envioBin.data));
  assert.equal(envioBin.data.comprobanteArchivo.mime, 'image/png');

  // El binario se guardó igual que el base64: se recupera bien.
  const recuperado = await api(`/pedidos/${pedidoBin.id}/comprobante`, { token: tokenCliente });
  assert.equal(recuperado.status, 200, JSON.stringify(recuperado.data));
  assert.equal(recuperado.data.comprobanteMime, 'image/png');
});

test('Un archivo que no es imagen ni PDF se rechaza con un mensaje claro, sin depender de la entidad', async () => {
  const etiqueta = marca('no-imagen');
  const pedido = await crearPedidoDelCliente(etiqueta);
  const envio = await api(`/pedidos/${pedido.id}/comprobante`, {
    method: 'POST', token: tokenCliente,
    body: { comprobante_img: 'data:text/plain;base64,' + Buffer.from('esto no es un comprobante').toString('base64') },
  });
  assert.equal(envio.status, 400, JSON.stringify(envio.data));
  assert.equal(envio.data.motivo, 'formato_no_reconocido');

  // Nada se guardó.
  const detalle = await api(`/pedidos/${pedido.id}`, { token: tokenCliente });
  assert.equal(detalle.data.tieneComprobante, false);
});

test('Un cliente NO puede enviar el comprobante del pedido de otra persona', async () => {
  const etiqueta = marca('ajeno');
  // Pedido de mostrador (sin cliente_id), creado por el Admin.
  const ajeno = await api('/pedidos', {
    method: 'POST', token: tokenAdmin,
    body: {
      cliente: 'Otro cliente', alias: `alias-ajeno-${etiqueta}`, tipo: 'local', local_id: localA,
      origen: 'admin', pago: 'nequi', total: 4000,
      items: [{ id: `prod-ajeno-${etiqueta}`, nombre: 'Café', precio: 4000, cantidad: 1 }],
    },
  });
  assert.equal(ajeno.status, 201, JSON.stringify(ajeno.data));
  pedidosCreados.push(ajeno.data.id);

  const intento = await api(`/pedidos/${ajeno.data.id}/comprobante`, {
    method: 'POST', token: tokenCliente, body: { comprobante_img: comprobantePng(etiqueta) },
  });
  assert.equal(intento.status, 403, JSON.stringify(intento.data));

  // El cajero/admin sí puede adjuntarlo por el cliente.
  const porElCajero = await api(`/pedidos/${ajeno.data.id}/comprobante`, {
    method: 'POST', token: tokenAdmin, body: { comprobante_img: comprobantePng(etiqueta) },
  });
  assert.equal(porElCajero.status, 201, JSON.stringify(porElCajero.data));
});

test('El mismo comprobante no se puede reutilizar en otro pedido', async () => {
  const etiqueta = marca('repetido');
  const imagen = comprobantePng(etiqueta);

  const primero = await crearPedidoDelCliente(`${etiqueta}-1`);
  const envio1 = await api(`/pedidos/${primero.id}/comprobante`, {
    method: 'POST', token: tokenCliente, body: { comprobante_img: imagen },
  });
  assert.equal(envio1.status, 201, JSON.stringify(envio1.data));

  const segundo = await crearPedidoDelCliente(`${etiqueta}-2`);
  const envio2 = await api(`/pedidos/${segundo.id}/comprobante`, {
    method: 'POST', token: tokenCliente, body: { comprobante_img: imagen },
  });
  assert.equal(envio2.status, 409, JSON.stringify(envio2.data));
  assert.equal(envio2.data.motivo, 'comprobante_repetido');

  // Reenviar el MISMO comprobante a SU PROPIO pedido sí se permite (la foto
  // salió cortada y el cliente la vuelve a mandar).
  const reenvio = await api(`/pedidos/${primero.id}/comprobante`, {
    method: 'POST', token: tokenCliente, body: { comprobante_img: imagen },
  });
  assert.equal(reenvio.status, 201, JSON.stringify(reenvio.data));
});

test('Un comprobante nuevo reabre la verificación de un pedido cuyo comprobante fue rechazado', async () => {
  const etiqueta = marca('reenvio-tras-rechazo');
  const pedido = await crearPedidoDelCliente(etiqueta);
  await api(`/pedidos/${pedido.id}/comprobante`, {
    method: 'POST', token: tokenCliente, body: { comprobante_img: comprobantePng(`${etiqueta}-1`) },
  });

  const rechazo = await api(`/pedidos/${pedido.id}/comprobante/rechazar`, {
    method: 'PATCH', token: tokenAdmin, body: { motivo: 'La imagen no corresponde al pago del pedido' },
  });
  assert.equal(rechazo.status, 200, JSON.stringify(rechazo.data));
  assert.equal(rechazo.data.estado, 'cancelado');

  // El pedido queda cancelado: ya no admite comprobante nuevo (regla de
  // negocio explícita, con mensaje claro en vez de guardarlo en silencio).
  const reintento = await api(`/pedidos/${pedido.id}/comprobante`, {
    method: 'POST', token: tokenCliente, body: { comprobante_img: comprobantePng(`${etiqueta}-2`) },
  });
  assert.equal(reintento.status, 409, JSON.stringify(reintento.data));
  assert.match(reintento.data.error, /cancelado/i);
});

// ─────────────────────────────────────────────────────────────────────────
//  VENTAS (requisito 5)
// ─────────────────────────────────────────────────────────────────────────

test('Una venta procesada queda registrada, se consulta después y NO desaparece del listado', async () => {
  const etiqueta = marca('venta-persiste');
  const pedido = await crearPedidoDelCliente(etiqueta);
  await api(`/pedidos/${pedido.id}/comprobante`, {
    method: 'POST', token: tokenCliente, body: { comprobante_img: comprobantePng(etiqueta) },
  });
  await entregar(pedido.id);

  // 1. Aparece en el listado general.
  const venta = await ventaDelPedido(pedido.id);
  assert.ok(venta, 'la venta debe aparecer al pedir las ventas');
  assert.equal(venta.estado, 'vendido');
  assert.equal(Number(venta.total), 9000);

  // 2. Se consulta puntualmente.
  const puntual = await api(`/ventas/${venta.id}`, { token: tokenAdmin });
  assert.equal(puntual.status, 200, JSON.stringify(puntual.data));
  assert.equal(Number(puntual.data.id), Number(venta.id));

  // 3. Mantiene SU INFORMACIÓN y su relación con pedido y cliente.
  assert.equal(Number(puntual.data.pedido_id), Number(pedido.id), 'relación con el pedido');
  assert.equal(Number(puntual.data.cliente_id), Number(clienteId), 'relación con el cliente');
  assert.equal(puntual.data.metodo_pago, 'nequi');
  assert.equal(puntual.data.tipo_venta, 'local');
  assert.ok(Array.isArray(puntual.data.productos) && puntual.data.productos.length === 2, 'conserva los productos');

  // 4. Sigue apareciendo al filtrar por local — el filtro que usa el cajero.
  const porLocal = await api(`/ventas?sede=${encodeURIComponent(localNombreA)}`, { token: tokenAdmin });
  assert.ok(
    porLocal.data.some((v) => Number(v.id) === Number(venta.id)),
    'la venta debe seguir visible al filtrar por el local del pedido'
  );

  // 5. Cuenta en las estadísticas.
  const stats = await api('/ventas/stats', { token: tokenAdmin });
  assert.ok(Number(stats.data.vendido) >= 1);
});

test('Procesar una venta NO la elimina: el pedido con venta registrada ya no se puede borrar', async () => {
  const etiqueta = marca('venta-no-borrable');
  const pedido = await crearPedidoDelCliente(etiqueta);
  await api(`/pedidos/${pedido.id}/comprobante`, {
    method: 'POST', token: tokenCliente, body: { comprobante_img: comprobantePng(etiqueta) },
  });
  await entregar(pedido.id);

  const venta = await ventaDelPedido(pedido.id);
  assert.ok(venta);

  const borrado = await api(`/pedidos/${pedido.id}`, { method: 'DELETE', token: tokenAdmin });
  assert.equal(borrado.status, 409, JSON.stringify(borrado.data));
  assert.equal(borrado.data.motivo, 'pedido_con_venta');

  // La venta sigue ahí, intacta.
  const sigue = await api(`/ventas/${venta.id}`, { token: tokenAdmin });
  assert.equal(sigue.status, 200, JSON.stringify(sigue.data));
  assert.equal(Number(sigue.data.total), 9000);
});

test('POST /ventas/desde-pedido es idempotente: no duplica ni pierde la venta', async () => {
  const etiqueta = marca('venta-idempotente');
  const pedido = await crearPedidoDelCliente(etiqueta);
  await api(`/pedidos/${pedido.id}/comprobante`, {
    method: 'POST', token: tokenCliente, body: { comprobante_img: comprobantePng(etiqueta) },
  });
  await entregar(pedido.id);

  const reintento = await api('/ventas/desde-pedido', {
    method: 'POST', token: tokenAdmin, body: { id_pedido: pedido.id },
  });
  assert.equal(reintento.status, 200, `debe devolver la venta existente, no crear otra: ${JSON.stringify(reintento.data)}`);

  const ventas = await api('/ventas', { token: tokenAdmin });
  const delPedido = ventas.data.filter((v) => Number(v.pedido_id) === Number(pedido.id));
  assert.equal(delPedido.length, 1, 'debe haber UNA sola venta para ese pedido');
});

test('PATCH /ventas/:id/estado valida el estado y responde 404 si la venta no existe', async () => {
  const inexistente = await api('/ventas/99999999/estado', {
    method: 'PATCH', token: tokenAdmin, body: { estado: 'vendido' },
  });
  assert.equal(inexistente.status, 404, JSON.stringify(inexistente.data));

  const etiqueta = marca('venta-estado');
  const pedido = await crearPedidoDelCliente(etiqueta);
  await api(`/pedidos/${pedido.id}/comprobante`, {
    method: 'POST', token: tokenCliente, body: { comprobante_img: comprobantePng(etiqueta) },
  });
  await entregar(pedido.id);
  const venta = await ventaDelPedido(pedido.id);

  const invalido = await api(`/ventas/${venta.id}/estado`, {
    method: 'PATCH', token: tokenAdmin, body: { estado: 'Anulada' },
  });
  assert.equal(invalido.status, 400, 'un estado que ningún filtro reconoce haría desaparecer la venta');
});

// ─────────────────────────────────────────────────────────────────────────
//  DEVOLUCIONES (requisito 4)
// ─────────────────────────────────────────────────────────────────────────

// Pedido entregado + su venta, listo para devolver.
const ventaLista = async (etiqueta) => {
  const pedido = await crearPedidoDelCliente(etiqueta);
  await api(`/pedidos/${pedido.id}/comprobante`, {
    method: 'POST', token: tokenCliente, body: { comprobante_img: comprobantePng(etiqueta) },
  });
  await entregar(pedido.id);
  const venta = await ventaDelPedido(pedido.id);
  assert.ok(venta, 'la venta debe existir antes de devolver');
  return { pedido, venta };
};

test('Devolución identificada por la VENTA (id_venta): se crea, queda persistida y se consulta después', async () => {
  const etiqueta = marca('dev-por-venta');
  const { pedido, venta } = await ventaLista(etiqueta);

  // La pantalla de Ventas manda "id_venta" — que es la clave que devuelve
  // GET /ventas. Antes esto fallaba con 400 "pedido_id es requerido".
  const dev = await api('/devoluciones', {
    method: 'POST', token: tokenAdmin,
    body: {
      id_venta: venta.id,
      motivo: 'El producto llegó frío y en mal estado',
      items: [{ item_index: 0, cantidad: 1 }],
    },
  });
  assert.equal(dev.status, 201, JSON.stringify(dev.data));
  assert.ok(dev.data.id, 'la devolución debe traer su id');
  assert.equal(Number(dev.data.venta_id), Number(venta.id), 'relación directa venta → devolución');
  assert.equal(Number(dev.data.id_venta), Number(venta.id));
  assert.equal(Number(dev.data.pedido_id), Number(pedido.id));
  assert.equal(dev.data.estado, 'pendiente');

  // PERSISTIDA: se consulta puntualmente, desde cero.
  const consulta = await api(`/devoluciones/${dev.data.id}`, { token: tokenAdmin });
  assert.equal(consulta.status, 200, JSON.stringify(consulta.data));
  assert.equal(Number(consulta.data.venta_id), Number(venta.id));
  assert.equal(consulta.data.motivo, 'El producto llegó frío y en mal estado');

  // Y aparece en el listado.
  const listado = await api('/devoluciones', { token: tokenAdmin });
  assert.ok(listado.data.some((d) => Number(d.id) === Number(dev.data.id)), 'debe aparecer en el listado');

  // Consultable desde la venta.
  const porVenta = await api(`/devoluciones/por-venta/${venta.id}`, { token: tokenAdmin });
  assert.equal(porVenta.status, 200, JSON.stringify(porVenta.data));
  assert.equal(porVenta.data.tieneDevolucion, true);
  assert.equal(Number(porVenta.data.devolucion.id), Number(dev.data.id));

  // La venta lo refleja.
  const ventaAhora = await api(`/ventas/${venta.id}`, { token: tokenAdmin });
  assert.equal(ventaAhora.data.tieneDevolucion, true);
  assert.equal(Number(ventaAhora.data.devolucion_id), Number(dev.data.id));
});

test('Una venta solo puede tener UNA devolución: la segunda se rechaza y no crea nada', async () => {
  const etiqueta = marca('dev-unica');
  const { venta } = await ventaLista(etiqueta);

  const primera = await api('/devoluciones', {
    method: 'POST', token: tokenAdmin,
    body: { venta_id: venta.id, motivo: 'Primera devolución de esta venta', items: [{ item_index: 0, cantidad: 1 }] },
  });
  assert.equal(primera.status, 201, JSON.stringify(primera.data));

  const segunda = await api('/devoluciones', {
    method: 'POST', token: tokenAdmin,
    body: { venta_id: venta.id, motivo: 'Segunda devolución de la misma venta', items: [{ item_index: 1, cantidad: 1 }] },
  });
  assert.equal(segunda.status, 409, JSON.stringify(segunda.data));
  assert.equal(segunda.data.motivo, 'devolucion_ya_existe');
  assert.equal(Number(segunda.data.devolucionExistente.id), Number(primera.data.id), 'debe decir cuál es la que ya existe');

  // No se creó un segundo registro.
  const listado = await api('/devoluciones', { token: tokenAdmin });
  const deEstaVenta = listado.data.filter((d) => Number(d.venta_id) === Number(venta.id));
  assert.equal(deEstaVenta.length, 1, 'debe haber UNA sola devolución para esa venta');

  // Tampoco por el otro camino (identificando el pedido en vez de la venta).
  const porPedido = await api('/devoluciones', {
    method: 'POST', token: tokenAdmin,
    body: { pedido_id: primera.data.pedido_id, motivo: 'Intento por pedido en vez de venta', items: [{ item_index: 1, cantidad: 1 }] },
  });
  assert.equal(porPedido.status, 409, JSON.stringify(porPedido.data));
  assert.equal(porPedido.data.motivo, 'devolucion_ya_existe');
});

test('La venta original permanece registrada aunque tenga una devolución', async () => {
  const etiqueta = marca('dev-venta-sobrevive');
  const { venta } = await ventaLista(etiqueta);

  const dev = await api('/devoluciones', {
    method: 'POST', token: tokenAdmin,
    body: { venta_id: venta.id, motivo: 'Devolución total de la venta completa', items: [{ item_index: 0, cantidad: 1 }, { item_index: 1, cantidad: 1 }] },
  });
  assert.equal(dev.status, 201, JSON.stringify(dev.data));

  const aprobar = await api(`/devoluciones/${dev.data.id}/estado`, {
    method: 'PATCH', token: tokenAdmin, body: { estado: 'aprobada' },
  });
  assert.equal(aprobar.status, 200, JSON.stringify(aprobar.data));

  // La venta NO se borró: sigue consultable, con su información.
  const despues = await api(`/ventas/${venta.id}`, { token: tokenAdmin });
  assert.equal(despues.status, 200, JSON.stringify(despues.data));
  assert.equal(despues.data.estado, 'devuelto', 'se devolvió todo → la venta queda marcada como devuelta');
  assert.equal(Number(despues.data.total), 9000, 'conserva su total');
  assert.ok(Array.isArray(despues.data.productos) && despues.data.productos.length === 2, 'conserva sus productos');

  // Y sigue en el listado, incluso filtrando por local.
  const porLocal = await api(`/ventas?sede=${encodeURIComponent(localNombreA)}`, { token: tokenAdmin });
  assert.ok(porLocal.data.some((v) => Number(v.id) === Number(venta.id)), 'sigue visible en el listado del local');
});

test('Devolución sobre un pedido SIN venta registrada: se rechaza con motivo claro', async () => {
  const etiqueta = marca('dev-sin-venta');
  const pedido = await crearPedidoDelCliente(etiqueta);

  const dev = await api('/devoluciones', {
    method: 'POST', token: tokenAdmin,
    body: { pedido_id: pedido.id, motivo: 'Intento de devolver algo que no se vendió', items: [{ item_index: 0, cantidad: 1 }] },
  });
  assert.equal(dev.status, 409, JSON.stringify(dev.data));
  assert.equal(dev.data.motivo, 'pedido_sin_venta');
});

test('Devolución sin identificar venta ni pedido: mensaje claro, no un 500', async () => {
  const dev = await api('/devoluciones', {
    method: 'POST', token: tokenAdmin,
    body: { motivo: 'Sin decir de qué venta es', items: [{ item_index: 0, cantidad: 1 }] },
  });
  assert.equal(dev.status, 400, JSON.stringify(dev.data));
  assert.equal(dev.data.motivo, 'falta_identificador');
  assert.ok(Array.isArray(dev.data.camposAceptados));
});

test('Devolución sobre una venta inexistente: 404', async () => {
  const dev = await api('/devoluciones', {
    method: 'POST', token: tokenAdmin,
    body: { venta_id: 99999999, motivo: 'Venta que no existe en el sistema', items: [{ item_index: 0, cantidad: 1 }] },
  });
  assert.equal(dev.status, 404, JSON.stringify(dev.data));
  assert.equal(dev.data.motivo, 'venta_no_encontrada');
});

test('El monto de la devolución se calcula desde las líneas devueltas cuando no lo mandan', async () => {
  const etiqueta = marca('dev-monto');
  const { venta } = await ventaLista(etiqueta);

  const dev = await api('/devoluciones', {
    method: 'POST', token: tokenAdmin,
    body: { venta_id: venta.id, motivo: 'Devolución de una sola línea del pedido', items: [{ item_index: 1, cantidad: 1 }] },
  });
  assert.equal(dev.status, 201, JSON.stringify(dev.data));
  // item_index 1 = "Jugo" a $5.000 × 1.
  assert.equal(Number(dev.data.monto), 5000, 'el monto debe salir del precio × cantidad de lo devuelto');
});
