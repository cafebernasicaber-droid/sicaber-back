// ─────────────────────────────────────────────────────────────────────────
//  Limpieza de datos de prueba residuales en la base de desarrollo
// ─────────────────────────────────────────────────────────────────────────
// HISTÓRICO (Ronda 15): antes de que existiera una base de datos DEDICADA
// para tests (ver scripts/run-tests.js y test/README.md), "npm test"
// corría contra esta misma base y dejaba insumos/productos/pedidos/ventas
// tageados ("... test aislamiento ...", "... test vaso-pitillo ...", etc.
// + un timestamp). La mayoría se limpiaba sola al final de cada test
// (`after()`), PERO un insumo/producto que llegó a tener una compra o una
// venta real asociada ya no se podía borrar (la propia API lo bloquea —
// mismo candado que protege datos reales de un local), así que el test,
// al toparse con ese bloqueo, lo desactivaba en vez de insistir —
// registros "Inactivo" que nunca se limpiaban solos.
//
// Desde la base de datos dedicada, esto ya NO debería volver a pasar — el
// script se deja igual por si hace falta un repaso puntual (ej. datos de
// prueba viejos de antes del fix, o una corrida manual de un test
// apuntando a la base real por error).
//
// Este script:
//   1) Encuentra TODO lo que coincide con el patrón "test" en el nombre
//      (insumo/producto) o en pedidos.cliente — deliberadamente amplio
//      (no una lista fija de frases): cada archivo de test usa su propio
//      prefijo ("test contadores", "test desacople", "test selector", ...)
//      y una lista cerrada de frases se queda corta apenas se agrega un
//      test nuevo (pasó de verdad: un "Insumo test desacople..." quedó
//      sin cubrir por la lista anterior de 3 frases exactas). SIEMPRE se
//      lista todo antes de tocar nada, así que un match de más se ve y se
//      puede corregir antes de confirmar.
//   2) Guarda un respaldo JSON completo (con todas las tablas relacionadas
//      — ventas, pedidos, compras, movimientos_inventario, insumo_local)
//      ANTES de borrar nada, en respaldo-migraciones/ (gitignored).
//   3) Con --confirm, borra en el orden seguro (hijos antes que padres).
//      SIN --confirm, solo lista y respalda — no borra nada (modo por
//      defecto, para poder revisar antes de confirmar).
//
// Uso:
//   node scripts/limpiar-datos-prueba.js            → lista + respalda, no borra
//   node scripts/limpiar-datos-prueba.js --confirm  → borra (ya respaldado)
'use strict';
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST, port: Number(process.env.DB_PORT), database: process.env.DB_NAME,
  user: process.env.DB_USER, password: process.env.DB_PASSWORD,
});

const CONFIRMAR = process.argv.includes('--confirm');

// Un solo patrón amplio ("test" en cualquier parte del nombre) en vez de
// una lista cerrada de frases — ver el porqué arriba. SIEMPRE se imprime
// el listado completo antes de respaldar/borrar nada, así que cualquier
// match inesperado (un dato real que por coincidencia tenga "test" en el
// nombre) se ve a tiempo.
const PATRONES = ['%test%'];
const condicionOr = (col) => PATRONES.map((_, i) => `${col} ILIKE $${i + 1}`).join(' OR ');

(async () => {
  const insumos = (await pool.query(`SELECT * FROM insumos WHERE ${condicionOr('nombre')} ORDER BY id`, PATRONES)).rows;
  const productos = (await pool.query(`SELECT * FROM productos WHERE ${condicionOr('nombre')} ORDER BY id`, PATRONES)).rows;
  const pedidos = (await pool.query(`SELECT * FROM pedidos WHERE ${condicionOr('cliente')} ORDER BY id`, PATRONES)).rows;

  const insumoIds = insumos.map(i => i.id);
  const productoIds = productos.map(p => p.id);
  const pedidoIds = pedidos.map(p => p.id);

  const ventas = pedidoIds.length
    ? (await pool.query(`SELECT * FROM ventas WHERE pedido_id = ANY($1) ORDER BY id`, [pedidoIds])).rows
    : [];
  const movimientos = insumoIds.length
    ? (await pool.query(`SELECT * FROM movimientos_inventario WHERE insumo_id = ANY($1) ORDER BY id`, [insumoIds])).rows
    : [];
  const insumoLocal = insumoIds.length
    ? (await pool.query(`SELECT * FROM insumo_local WHERE insumo_id = ANY($1) ORDER BY id`, [insumoIds])).rows
    : [];
  // Compras que referencian estos insumos por NOMBRE en su "items" (así
  // sella cada línea de una compra, no por insumo_id — ver
  // resolverInsumoIdPorNombre en routes/index.js). Se incluye la compra
  // COMPLETA solo si TODOS sus items son de prueba (nunca se toca una
  // compra real que además tenga un ítem de prueba mezclado).
  const nombresInsumo = insumos.map(i => i.nombre);
  const comprasCandidatas = nombresInsumo.length
    ? (await pool.query(
        `SELECT * FROM compras c
          WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(c.items) it WHERE it->>'insumo' = ANY($1))
          ORDER BY id`,
        [nombresInsumo]
      )).rows
    : [];
  const compras = comprasCandidatas.filter(c =>
    (c.items || []).every(it => nombresInsumo.includes(it.insumo))
  );
  const comprasMixtas = comprasCandidatas.filter(c => !compras.includes(c));

  console.log('── Registros de PRUEBA encontrados (patrón: "test" en el nombre/cliente) ──\n');
  console.log(`Insumos            : ${insumos.length}`, insumos.map(i => `#${i.id} ${i.nombre}`));
  console.log(`Productos           : ${productos.length}`, productos.map(p => `#${p.id} ${p.nombre}`));
  console.log(`Pedidos             : ${pedidos.length}`, pedidos.map(p => `#${p.id} ${p.cliente}`));
  console.log(`Ventas (de esos pedidos): ${ventas.length}`, ventas.map(v => `#${v.id} (pedido ${v.pedido_id})`));
  console.log(`Compras 100% de prueba (se borran completas): ${compras.length}`, compras.map(c => `#${c.id} ${c.codigo}`));
  console.log(`Movimientos de inventario: ${movimientos.length}`);
  console.log(`Filas insumo_local  : ${insumoLocal.length}`);
  if (comprasMixtas.length) {
    console.log(`\n⚠️  ${comprasMixtas.length} compra(s) tienen ALGÚN ítem de prueba MEZCLADO con ítems reales — NO se tocan (ni la compra ni sus ítems):`, comprasMixtas.map(c => `#${c.id} ${c.codigo}`));
  }

  const dir = path.join(__dirname, '..', 'respaldo-migraciones');
  fs.mkdirSync(dir, { recursive: true });
  const archivo = path.join(dir, `limpieza-datos-prueba-${Date.now()}.json`);
  fs.writeFileSync(archivo, JSON.stringify({ insumos, productos, pedidos, ventas, compras, movimientos, insumoLocal, comprasMixtasNoTocadas: comprasMixtas }, null, 2));
  console.log(`\n💾 Respaldo completo guardado en: ${archivo}`);

  if (!CONFIRMAR) {
    console.log('\nModo dry-run (por defecto): NO se borró nada. Corre con --confirm para aplicar el borrado (ya respaldado arriba).');
    await pool.end();
    return;
  }

  console.log('\n--confirm recibido: borrando en orden seguro...');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (ventas.length) await client.query(`DELETE FROM ventas WHERE id = ANY($1)`, [ventas.map(v => v.id)]);
    if (pedidoIds.length) await client.query(`DELETE FROM pedidos WHERE id = ANY($1)`, [pedidoIds]);
    if (movimientos.length) await client.query(`DELETE FROM movimientos_inventario WHERE id = ANY($1)`, [movimientos.map(m => m.id)]);
    if (insumoLocal.length) await client.query(`DELETE FROM insumo_local WHERE id = ANY($1)`, [insumoLocal.map(x => x.id)]);
    if (compras.length) await client.query(`DELETE FROM compras WHERE id = ANY($1)`, [compras.map(c => c.id)]);
    if (insumoIds.length) await client.query(`DELETE FROM insumos WHERE id = ANY($1)`, [insumoIds]);
    if (productoIds.length) await client.query(`DELETE FROM productos WHERE id = ANY($1)`, [productoIds]);
    await client.query('COMMIT');
    console.log('✅ Borrado aplicado.');
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('❌ Error, se revirtió todo:', e.message);
  } finally {
    client.release();
    await pool.end();
  }
})();
