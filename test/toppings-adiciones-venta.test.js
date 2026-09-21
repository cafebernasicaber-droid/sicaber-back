// ─────────────────────────────────────────────────────────────────────────
//  Tests de integración: Toppings/Adiciones — consumo real de insumo,
//  relación con productos y descuento de stock al vender
// ─────────────────────────────────────────────────────────────────────────
// El insumo ya NO se marca como "candidato" a topping/adición (flags
// es_topping/es_adicion retirados): la decisión de qué insumo usa cada
// topping/adición vive en su propia configuración (insumo_id + cantidad).
// Estos tests cubren: validación de cantidad_por_uso según la unidad real
// del insumo, que un mismo insumo pueda ser topping en un producto y
// adición en otro sin conflicto, el filtro de toppings por producto, y el
// descuento efectivo de stock — en el LOCAL correcto — de un topping y de
// una adición, con y sin insumo asociado.
//
// Mismos requisitos que el resto de la suite: servidor corriendo, admin
// sembrado, 1+ local Activo. Ejecutar: npm test
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const BASE = process.env.TEST_BASE_URL || 'http://localhost:4000/api';

// ── Comprobante de prueba ────────────────────────────────────────────────
// El backend ahora VALIDA que el comprobante sea de verdad un archivo de
// imagen (o PDF), mirando sus bytes — ver normalizarArchivoComprobante en
// src/services/comprobante.js. Antes no se validaba nada y estos tests
// mandaban "data:text/plain;base64,..." (un texto cualquiera), que hoy se
// rechaza con 400. Se usa un PNG 1×1 REAL, con bytes finales únicos por
// llamada para que cada pedido tenga un comprobante distinto y no choque
// con el control de "este comprobante ya se usó en otro pedido".
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);
const comprobantePrueba = (marca) =>
  'data:image/png;base64,' +
  Buffer.concat([PNG_1X1, Buffer.from(String(marca))]).toString('base64');

const ADMIN_USER = process.env.TEST_ADMIN_USER || 'Admin_Sicaber';
const ADMIN_PASS = process.env.TEST_ADMIN_PASS || 'admin2024#';

let token;
let localA;
let insumoToppingId, insumoToppingNombre;   // usado por el topping
let insumoAdicionId, insumoAdicionNombre;   // usado por la adición CON insumo
let insumoCompartidoId, insumoCompartidoNombre; // el mismo insumo: topping en un producto, adición en otro
let insumoBaseId, insumoBaseNombre; // ingrediente base de la ficha (obligatorio al menos uno) — no es parte de lo que se está probando
let toppingId, toppingCompartidoId;
let adicionConInsumoId, adicionSinInsumoId, adicionCompartidaId;
let productoId, productoNombre;
let producto2Id, producto2Nombre;
let fichaId, ficha2Id;

const api = async (path, { method = 'GET', body } = {}) => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
};

const filaDelLocal = (respuestaInsumo, localId) =>
  respuestaInsumo.data.porLocal.find((f) => f.localId === localId);

before(async () => {
  const login = await api('/auth/login', { method: 'POST', body: { username: ADMIN_USER, password: ADMIN_PASS } });
  assert.equal(login.status, 200, JSON.stringify(login.data));
  token = login.data.token;

  const listado = await api('/locales/todos');
  const activos = listado.data.filter((l) => l.estado === 'Activo');
  assert.ok(activos.length >= 1, 'se necesita al menos 1 local Activo');
  localA = activos[0].id;

  const sufijo = Date.now();
  insumoToppingNombre = `Insumo test topping ${sufijo}`;
  insumoAdicionNombre = `Insumo test adicion ${sufijo}`;
  insumoCompartidoNombre = `Insumo test compartido topping-adicion ${sufijo}`;

  const iTopping = await api('/insumos', { method: 'POST', body: { nombre: insumoToppingNombre, unidadMedida: 'kg', stockMinimo: 1, stockActual: 10, local_id: localA } });
  assert.equal(iTopping.status, 201, JSON.stringify(iTopping.data));
  insumoToppingId = iTopping.data.id;

  const iAdicion = await api('/insumos', { method: 'POST', body: { nombre: insumoAdicionNombre, unidadMedida: 'unidad', stockMinimo: 1, stockActual: 10, local_id: localA } });
  assert.equal(iAdicion.status, 201, JSON.stringify(iAdicion.data));
  insumoAdicionId = iAdicion.data.id;

  const iCompartido = await api('/insumos', { method: 'POST', body: { nombre: insumoCompartidoNombre, unidadMedida: 'g', stockMinimo: 1, stockActual: 10, local_id: localA } });
  assert.equal(iCompartido.status, 201, JSON.stringify(iCompartido.data));
  insumoCompartidoId = iCompartido.data.id;

  insumoBaseNombre = `Insumo test base receta ${sufijo}`;
  const iBase = await api('/insumos', { method: 'POST', body: { nombre: insumoBaseNombre, unidadMedida: 'kg', stockMinimo: 1, stockActual: 10, local_id: localA } });
  assert.equal(iBase.status, 201, JSON.stringify(iBase.data));
  insumoBaseId = iBase.data.id;
});

after(async () => {
  for (const id of [fichaId, ficha2Id]) {
    try { if (id) await api(`/fichas-tecnicas/${id}`, { method: 'DELETE' }); } catch {}
  }
  for (const id of [productoId, producto2Id]) {
    try {
      if (id) {
        const del = await api(`/productos/${id}`, { method: 'DELETE' });
        if (del.status !== 200) await api(`/productos/${id}`, { method: 'PUT', body: { estado: 'Inactivo' } });
      }
    } catch {}
  }
  for (const id of [toppingId, toppingCompartidoId]) {
    try { if (id) await api(`/toppings/${id}`, { method: 'DELETE' }); } catch {}
  }
  for (const id of [adicionConInsumoId, adicionSinInsumoId, adicionCompartidaId]) {
    try { if (id) await api(`/adiciones/${id}`, { method: 'DELETE' }); } catch {}
  }
  for (const id of [insumoToppingId, insumoAdicionId, insumoCompartidoId, insumoBaseId]) {
    try { if (id) await api(`/insumos/${id}`, { method: 'DELETE' }); } catch {}
  }
});

test('POST /toppings: insumo_id + cantidad_por_uso, validada según la unidad real del insumo', async () => {
  // insumoToppingId es "kg" — acepta decimales.
  const r = await api('/toppings', {
    method: 'POST',
    body: { nombre: `Topping test ${Date.now()}`, insumo_id: insumoToppingId, cantidad: 0.02 },
  });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.insumo_id, insumoToppingId);
  assert.equal(Number(r.data.cantidad), 0.02);
  // El insumo asociado, su unidad y la cantidad por uso deben venir listos
  // para columna (requisito 3, ronda siguiente) — sin que el frontend
  // tenga que resolver el insumo aparte.
  assert.equal(r.data.insumoNombre, insumoToppingNombre);
  assert.equal(r.data.insumoUnidad, 'kg');
  toppingId = r.data.id;

  const listado = await api('/toppings');
  const enListado = listado.data.find((t) => t.id === toppingId);
  assert.ok(enListado, 'debe aparecer en GET /toppings');
  assert.equal(enListado.insumoNombre, insumoToppingNombre);
  assert.equal(enListado.insumoUnidad, 'kg');
  assert.equal(Number(enListado.cantidad), 0.02);
});

test('POST /toppings: rechaza cantidad decimal si el insumo asociado es de unidad "unidad"', async () => {
  const r = await api('/toppings', {
    method: 'POST',
    body: { nombre: `Topping test entero ${Date.now()}`, insumo_id: insumoAdicionId, cantidad: 1.5 },
  });
  assert.equal(r.status, 400, JSON.stringify(r.data));
});

test('POST /adiciones: con insumo_id, la cantidad es obligatoria y se valida por unidad', async () => {
  const sinCantidad = await api('/adiciones', {
    method: 'POST',
    body: { nombre: `Adicion test sin cantidad ${Date.now()}`, precio: 2000, insumo_id: insumoAdicionId },
  });
  assert.equal(sinCantidad.status, 400, JSON.stringify(sinCantidad.data));

  const ok = await api('/adiciones', {
    method: 'POST',
    body: { nombre: `Adicion test con insumo ${Date.now()}`, precio: 2000, insumo_id: insumoAdicionId, cantidad: 1 },
  });
  assert.equal(ok.status, 201, JSON.stringify(ok.data));
  assert.equal(ok.data.insumo_id, insumoAdicionId);
  assert.equal(Number(ok.data.cantidad), 1);
  adicionConInsumoId = ok.data.id;
});

test('POST /adiciones: SIN insumo_id (extra de solo precio) — cantidad se guarda en 0 sin importar qué se mande', async () => {
  const r = await api('/adiciones', {
    method: 'POST',
    body: { nombre: `Adicion test sin insumo ${Date.now()}`, precio: 1500, cantidad: 99 },
  });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.insumo_id, null);
  assert.equal(Number(r.data.cantidad), 0);
  adicionSinInsumoId = r.data.id;
});

test('un mismo insumo puede ser TOPPING en un producto y ADICIÓN en otro, sin conflicto', async () => {
  const t = await api('/toppings', {
    method: 'POST',
    body: { nombre: `Topping compartido ${Date.now()}`, insumo_id: insumoCompartidoId, cantidad: 5 },
  });
  assert.equal(t.status, 201, JSON.stringify(t.data));
  toppingCompartidoId = t.data.id;

  const a = await api('/adiciones', {
    method: 'POST',
    body: { nombre: `Adicion compartida ${Date.now()}`, precio: 3000, insumo_id: insumoCompartidoId, cantidad: 8 },
  });
  assert.equal(a.status, 201, JSON.stringify(a.data));
  assert.equal(a.data.insumo_id, insumoCompartidoId, 'debe aceptar el mismo insumo que ya usa un topping');
  adicionCompartidaId = a.data.id;
});

test('GET /toppings?producto_id= trae los de productos_ids=[] (todos) + los que lo incluyen explícito', async () => {
  const actual = await api(`/toppings/${toppingId}`);
  assert.equal(actual.status, 200, JSON.stringify(actual.data));
  const toppingNombre = actual.data.nombre;

  const productoDestino = 999999999; // id que no existe: el topping con productos_ids=[] debe verse igual
  const universal = await api(`/toppings?producto_id=${productoDestino}`);
  assert.equal(universal.status, 200, JSON.stringify(universal.data));
  assert.ok(universal.data.some((t) => t.id === toppingId), 'un topping con productos_ids=[] debe aplicar a CUALQUIER producto');

  // Ahora se restringe el topping a un producto específico (uno que no es productoDestino)
  const restringido = await api(`/toppings/${toppingId}`, {
    method: 'PUT',
    body: { nombre: toppingNombre, productos_ids: [123456789], insumo_id: insumoToppingId, cantidad: 0.02 },
  });
  assert.equal(restringido.status, 200, JSON.stringify(restringido.data));

  const yaNoAplica = await api(`/toppings?producto_id=${productoDestino}`);
  assert.ok(!yaNoAplica.data.some((t) => t.id === toppingId), 'restringido a otro producto, ya no debe verse para este');

  const siAplicaAlSuyo = await api('/toppings?producto_id=123456789');
  assert.ok(siAplicaAlSuyo.data.some((t) => t.id === toppingId), 'debe verse para el producto al que sí fue restringido');

  // se revierte a "aplica a todos" para el test de venta de más abajo
  const revertido = await api(`/toppings/${toppingId}`, {
    method: 'PUT',
    body: { nombre: toppingNombre, productos_ids: [], insumo_id: insumoToppingId, cantidad: 0.02 },
  });
  assert.equal(revertido.status, 200, JSON.stringify(revertido.data));
});

test('venta: descuenta el topping y la adición (con y sin insumo) del LOCAL correcto', async () => {
  productoNombre = `Producto test topping-adicion ${Date.now()}`;
  const prod = await api('/productos', { method: 'POST', body: { nombre: productoNombre, categoria: 'Bebidas frías', precio: 10000 } });
  assert.equal(prod.status, 201, JSON.stringify(prod.data));
  productoId = prod.data.id;

  const ficha = await api('/fichas-tecnicas', {
    method: 'POST',
    body: {
      id_producto: productoId, porciones: 1, tiempo_prep: 5, costo_estimado: 500,
      preparacion: 'Preparación de prueba para el test de topping/adición.',
      insumos: [{ id_insumo: insumoBaseId, cantidad: 0.01 }],
    },
  });
  assert.equal(ficha.status, 201, JSON.stringify(ficha.data));
  fichaId = ficha.data.id;

  const antesTopping = await api(`/insumos/${insumoToppingId}`);
  const antesAdicion = await api(`/insumos/${insumoAdicionId}`);
  const stockAntesTopping = Number(filaDelLocal(antesTopping, localA).stock);
  const stockAntesAdicion = Number(filaDelLocal(antesAdicion, localA).stock);

  // pago: 'nequi' (no 'efectivo') — efectivo ya no aplica a tipo='local'
  // (ver pedidos-metodo-pago.test.js); se aprueba el comprobante antes de
  // avanzar de estado para no chocar con el gate de pago.
  const pedido = await api('/pedidos', {
    method: 'POST',
    body: {
      cliente: 'Cliente test topping-adicion', alias: `alias-topping-adicion-${Date.now()}`, tipo: 'local', pago: 'nequi',
      // 13.500 = producto 10.000 + adición con insumo 2.000 + adición sin
      // insumo 1.500. El test decía 15.500 (2.000 de más) desde antes de
      // esta ronda y fallaba con "el total no corresponde a los precios
      // vigentes": venía de cuando los TOPPINGS tenían precio propio, una
      // columna que ya se eliminó (`ALTER TABLE toppings DROP COLUMN IF
      // EXISTS precio` en config/db.js — la regla vigente es que un topping
      // nunca cuesta). El backend calculaba bien; la expectativa del test
      // era la que había quedado vieja.
      comprobante_img: comprobantePrueba(`topping-adicion-${Date.now()}`), total: 13500,
      items: [{
        id: productoId, nombre: productoNombre, cantidad: 1, precio: 10000,
        toppings: [toppingId],
        adiciones: [adicionConInsumoId, adicionSinInsumoId],
      }],
      origen: 'admin', local_id: localA,
    },
  });
  assert.equal(pedido.status, 201, JSON.stringify(pedido.data));
  const pedidoId = pedido.data.id;

  const aprobar = await api(`/pedidos/${pedidoId}/comprobante/aprobar`, { method: 'PATCH' });
  assert.equal(aprobar.status, 200, JSON.stringify(aprobar.data));

  for (const estado of ['en_proceso', 'en_camino', 'entregado']) {
    const r = await api(`/pedidos/${pedidoId}/estado`, { method: 'PATCH', body: { estado } });
    assert.equal(r.status, 200, `PATCH estado=${estado} → ${JSON.stringify(r.data)}`);
  }

  const despuesTopping = await api(`/insumos/${insumoToppingId}`);
  const despuesAdicion = await api(`/insumos/${insumoAdicionId}`);
  assert.equal(Number(filaDelLocal(despuesTopping, localA).stock), stockAntesTopping - 0.02, 'el topping debe descontar su cantidad_por_uso (0.02 kg)');
  assert.equal(Number(filaDelLocal(despuesAdicion, localA).stock), stockAntesAdicion - 1, 'la adición CON insumo debe descontar su cantidad_por_uso (1 unidad)');

  // Ningún otro local debe verse afectado.
  for (const f of despuesTopping.data.porLocal.filter((f) => f.localId !== localA)) {
    assert.equal(Number(f.stock), 0, 'otro local no debería tener movimiento de este insumo de prueba');
  }
});
