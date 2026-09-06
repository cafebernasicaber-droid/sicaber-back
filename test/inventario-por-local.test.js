// ─────────────────────────────────────────────────────────────────────────
//  Tests de integración: aislamiento de stock por local (requisito 3)
// ─────────────────────────────────────────────────────────────────────────
// "Ninguna operación de un local puede modificar el stock de otro" — estos
// tests lo verifican contra la API REAL, corriendo en vivo (no hay una base
// de datos de prueba separada en este proyecto; usan la misma que .env).
//
// Requisito para correrlos:
//   1) El servidor debe estar corriendo (`npm run dev` o `npm start`) en
//      otra terminal — por defecto contra http://localhost:4000/api
//      (configurable con TEST_BASE_URL).
//   2) Debe existir el usuario admin sembrado (Admin_Sicaber/admin2024#,
//      o pasar TEST_ADMIN_USER/TEST_ADMIN_PASS) y al menos 2 locales
//      Activos (ver módulo de Empleados > Locales).
//
// Ejecutar: npm test
//
// Los datos que crean (insumo/producto/ficha técnica/pedido de prueba,
// todos con el prefijo "test aislamiento") se limpian al final en la medida
// en que las reglas de negocio lo permiten (un producto con una venta real
// no se puede borrar — solo desactivar; eso es correcto, no un fallo del
// test).
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const BASE = process.env.TEST_BASE_URL || 'http://localhost:4000/api';
const ADMIN_USER = process.env.TEST_ADMIN_USER || 'Admin_Sicaber';
const ADMIN_PASS = process.env.TEST_ADMIN_PASS || 'admin2024#';

let token;
let locales = []; // al menos 2 locales Activos
let totalLocales = 0; // activos + inactivos — insumo_local trae fila para TODOS
let insumoId, insumoNombre;
let productoId, productoNombre;
let fichaId;
let pedidoId;
let compraIdParaAnular;

const api = async (path, { method = 'GET', body } = {}) => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
};

const filaDelLocal = (respuestaInsumo, localId) =>
  respuestaInsumo.data.porLocal.find((f) => f.localId === localId);

before(async () => {
  const login = await api('/auth/login', { method: 'POST', body: { username: ADMIN_USER, password: ADMIN_PASS } });
  assert.equal(login.status, 200, `Login falló — ¿el servidor está corriendo en ${BASE} y existe el admin sembrado? ${JSON.stringify(login.data)}`);
  token = login.data.token;

  const listado = await api('/locales/todos');
  assert.equal(listado.status, 200, JSON.stringify(listado.data));
  locales = listado.data.filter((l) => l.estado === 'Activo');
  totalLocales = listado.data.length;
  assert.ok(locales.length >= 2, `Se necesitan al menos 2 locales Activos para probar aislamiento (hay ${locales.length}).`);

  insumoNombre = `Insumo test aislamiento ${Date.now()}`;
  const ins = await api('/insumos', {
    method: 'POST',
    body: {
      nombre: insumoNombre, unidadMedida: 'kg', stockMinimo: 1,
      stockActual: 10, local_id: locales[0].id,
    },
  });
  assert.equal(ins.status, 201, JSON.stringify(ins.data));
  insumoId = ins.data.id;
});

after(async () => {
  // Best-effort: cada paso puede fallar por reglas de negocio propias (ej.
  // un producto con venta real no se puede borrar) — no es un fallo del
  // test, así que no se afirma nada acá, solo se intenta dejar todo limpio.
  //
  // OJO: el pedido de prueba (una vez entregado) queda con una fila real en
  // "ventas" — a propósito NO se borra el pedido acá: borrarlo deja esa
  // venta con pedido_id=NULL (huérfana, sin producto trazado) por el
  // ON DELETE SET NULL de la FK. Mejor un pedido/venta de prueba histórico
  // y trazable (claramente nombrado "test aislamiento") que una fila
  // fantasma en Ventas.
  try { if (fichaId) await api(`/fichas-tecnicas/${fichaId}`, { method: 'DELETE' }); } catch {}
  try {
    if (productoId) {
      await api(`/productos/${productoId}`, { method: 'DELETE' }).then(async (r) => {
        if (r.status !== 200) await api(`/productos/${productoId}`, { method: 'PUT', body: { nombre: productoNombre, categoria: 'Bebidas calientes', precio: 15000, estado: 'Inactivo' } });
      });
    }
  } catch {}
  try {
    if (insumoId) {
      // Si el insumo quedó con una compra registrada (la de la propia
      // prueba, ya anulada), DELETE lo rechaza a propósito — se desactiva
      // en su lugar, igual que indicaría la propia API.
      const del = await api(`/insumos/${insumoId}`, { method: 'DELETE' });
      if (del.status !== 200) {
        await api(`/insumos/${insumoId}`, {
          method: 'PUT',
          body: { nombre: insumoNombre, unidadMedida: 'kg', estado: 'Inactivo' },
        });
      }
    }
  } catch {}
});

test('al crear un insumo, TODOS los locales (activos e inactivos) quedan con fila en insumo_local (stock=0 salvo el elegido)', async () => {
  const detalle = await api(`/insumos/${insumoId}`);
  assert.equal(detalle.status, 200);
  assert.equal(detalle.data.porLocal.length, totalLocales, 'debe haber una fila de insumo_local por cada local, sin importar si está Activo o Inactivo');
  for (const fila of detalle.data.porLocal) {
    if (fila.localId === locales[0].id) assert.equal(Number(fila.stock), 10);
    else assert.equal(Number(fila.stock), 0, `el local ${fila.localNombre} no debería tener stock de un insumo recién creado en otro local`);
  }
});

test('un mismo insumo puede tener cantidades distintas en dos locales, de forma independiente', async () => {
  const localB = locales[1].id;
  const ajuste = await api(`/insumos/${insumoId}/locales/${localB}`, { method: 'PUT', body: { stockActual: 5 } });
  assert.equal(ajuste.status, 200, JSON.stringify(ajuste.data));

  const detalle = await api(`/insumos/${insumoId}`);
  assert.equal(Number(filaDelLocal(detalle, locales[0].id).stock), 10);
  assert.equal(Number(filaDelLocal(detalle, localB).stock), 5);
});

test('el estado de stock se calcula POR LOCAL, nunca sumando (requisito 4)', async () => {
  const consolidado = await api(`/insumos/${insumoId}?local_id=all`);
  assert.equal(consolidado.status, 200);
  // El nivel superior (consolidado/sumado) NUNCA debe traer un "estadoStock"
  // propio — solo cada entrada de "porLocal" tiene el suyo.
  assert.equal(consolidado.data.estadoStock, undefined, 'el estado no debe calcularse sobre el total sumado');
  const ESTADOS_VALIDOS = ['agotado', 'bajo_minimo', 'agotandose', 'ok'];
  for (const fila of consolidado.data.porLocal) {
    assert.ok(ESTADOS_VALIDOS.includes(fila.estadoStock), `estado inesperado: ${fila.estadoStock}`);
  }
});

test('una compra en el local A solo sube el stock_actual de A (B queda intacto)', async () => {
  const localA = locales[0].id;
  const localB = locales[1].id;

  const antes = await api(`/insumos/${insumoId}?local_id=all`);
  const stockAntesA = Number(filaDelLocal(antes, localA).stock);
  const stockAntesB = Number(filaDelLocal(antes, localB).stock);

  const proveedores = await api('/proveedores');
  const proveedorActivo = proveedores.data.find((p) => p.estado === 'Activo');
  assert.ok(proveedorActivo, 'se necesita al menos un proveedor Activo para registrar la compra de prueba');

  const compra = await api('/compras', {
    method: 'POST',
    body: {
      proveedorId: proveedorActivo.id, local_id: localA,
      fecha: new Date().toISOString().slice(0, 10), total: 40000, descuento: 0,
      items: [{ insumo: insumoNombre, cantidad: 4, precioUnitario: 10000 }],
    },
  });
  assert.equal(compra.status, 201, JSON.stringify(compra.data));
  compraIdParaAnular = compra.data.id;

  const despues = await api(`/insumos/${insumoId}?local_id=all`);
  assert.equal(Number(filaDelLocal(despues, localA).stock), stockAntesA + 4, 'el local de la compra debe subir exactamente lo comprado');
  assert.equal(Number(filaDelLocal(despues, localB).stock), stockAntesB, 'ningún otro local debe cambiar');

  const anular = await api(`/compras/${compraIdParaAnular}/anular`, { method: 'PATCH', body: { motivo: 'Revertir compra de la prueba automatizada de aislamiento por local.' } });
  assert.equal(anular.status, 200, JSON.stringify(anular.data));

  const trasAnular = await api(`/insumos/${insumoId}?local_id=all`);
  assert.equal(Number(filaDelLocal(trasAnular, localA).stock), stockAntesA, 'anular la compra debe revertir SOLO en el mismo local');
  assert.equal(Number(filaDelLocal(trasAnular, localB).stock), stockAntesB);
});

test('una venta (pedido entregado) en el local A solo descuenta el stock de A (B queda intacto)', async () => {
  const localA = locales[0].id;
  const localB = locales[1].id;

  productoNombre = `Producto test aislamiento ${Date.now()}`;
  const prod = await api('/productos', { method: 'POST', body: { nombre: productoNombre, categoria: 'Bebidas calientes', precio: 15000 } });
  assert.equal(prod.status, 201, JSON.stringify(prod.data));
  productoId = prod.data.id;

  // Ficha técnica mínima: consume 2 kg del insumo de prueba como ingrediente,
  // y lo reutiliza también como "vaso" (ya NO obligatorio, pero se manda con
  // su cantidad) — el descuento total esperado por unidad vendida es,
  // entonces, 2 (ingrediente) + 0.5 (vaso, cantidad_vaso) = 2.5.
  const ficha = await api('/fichas-tecnicas', {
    method: 'POST',
    body: {
      id_producto: productoId, porciones: 1, tiempo_prep: 5, costo_estimado: 1000,
      preparacion: 'Preparación de prueba para el test de aislamiento por local.',
      insumos: [{ id_insumo: insumoId, cantidad: 2 }],
      vaso_insumo_id: insumoId, cantidad_vaso: 0.5,
    },
  });
  assert.equal(ficha.status, 201, JSON.stringify(ficha.data));
  fichaId = ficha.data.id;
  const CONSUMO_ESPERADO = 2.5; // 2 (ingrediente) + 0.5 (vaso)

  const antes = await api(`/insumos/${insumoId}?local_id=all`);
  const stockAntesA = Number(filaDelLocal(antes, localA).stock);
  const stockAntesB = Number(filaDelLocal(antes, localB).stock);
  assert.ok(stockAntesA >= CONSUMO_ESPERADO, 'el local A necesita stock suficiente para la venta de prueba');

  const pedido = await api('/pedidos', {
    method: 'POST',
    body: {
      cliente: 'Cliente test aislamiento', tipo: 'local', pago: 'efectivo', total: 15000,
      items: [{ id: productoId, nombre: productoNombre, cantidad: 1, precio: 15000 }],
      origen: 'admin', local_id: localA,
    },
  });
  assert.equal(pedido.status, 201, JSON.stringify(pedido.data));
  pedidoId = pedido.data.id;

  // Camino completo del estado: pendiente → en_proceso → en_camino → entregado
  // (en efectivo no hay comprobante que aprobar, así que no hay bloqueo de pago).
  for (const estado of ['en_proceso', 'en_camino', 'entregado']) {
    const r = await api(`/pedidos/${pedidoId}/estado`, { method: 'PATCH', body: { estado } });
    assert.equal(r.status, 200, `PATCH estado=${estado} → ${JSON.stringify(r.data)}`);
  }

  const despues = await api(`/insumos/${insumoId}?local_id=all`);
  assert.equal(Number(filaDelLocal(despues, localA).stock), stockAntesA - CONSUMO_ESPERADO, 'la venta debe descontar exactamente la receta, solo en el local del pedido');
  assert.equal(Number(filaDelLocal(despues, localB).stock), stockAntesB, 'ningún otro local debe descontarse por una venta que no es suya');
});
