#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
//  Orquestador de "npm test": base de datos DEDICADA y DESECHABLE, servidor
//  DEDICADO, ambos arrancados y destruidos en cada corrida.
// ─────────────────────────────────────────────────────────────────────────
// CAUSA RAÍZ que esto corrige — ver el reporte completo en CAMBIOS.md
// ("Ronda 15") y test/README.md:
//
// Antes, "npm test" corría la suite de integración contra la MISMA base de
// datos que usa el servidor de desarrollo real (el "DB_NAME" del .env,
// "sicaber"). Cada corrida dejaba insumos/productos/pedidos/ventas/compras
// de prueba reales ahí — la mayoría no se podían borrar solos porque
// terminaban con una venta o una compra real asociada (el mismo candado
// que protege datos reales de un local bloqueaba también la limpieza de
// los tests). Resultado confirmado en vivo: la base de desarrollo
// acumulaba más basura en cada corrida — visible en el panel real y en el
// catálogo del cliente — y encima el conteo de "qué hay que borrar" quedó
// desactualizado apenas alguien volvía a correr la suite.
//
// Esto arranca TODO desde cero, cada vez, contra una base separada
// (sicaber_test — NUNCA "sicaber") que se destruye y recrea al empezar
// cada corrida. Así ninguna corrida puede heredar basura de la anterior,
// y nada de lo que un test haga (falle a mitad de camino o no) puede
// tocar la base de datos real.
//
// Requiere: el mismo Postgres de siempre (.env: DB_HOST/DB_PORT/DB_USER/
// DB_PASSWORD) — solo cambia el NOMBRE de la base. El usuario de .env
// necesita permiso para crear/borrar bases de datos (el rol "postgres" ya
// lo tiene).
'use strict';
require('dotenv').config();
const { spawn } = require('child_process');
const { Pool } = require('pg');
const path = require('path');

const TEST_DB_NAME = process.env.TEST_DB_NAME || 'sicaber_test';
const TEST_PORT = process.env.TEST_PORT || '4099';

const conectarMantenimiento = () => new Pool({
  host: process.env.DB_HOST, port: Number(process.env.DB_PORT),
  user: process.env.DB_USER, password: process.env.DB_PASSWORD,
  database: 'postgres', // base de mantenimiento de Postgres: siempre existe, permite CREATE/DROP DATABASE
});

// DROP + CREATE en vez de "reutilizar si ya existe": la forma más simple
// de garantizar una base 100% limpia en cada corrida, sin depender de que
// cada test se acuerde de borrar exactamente lo que creó (justo el
// problema que causó la acumulación de basura en primer lugar).
const recrearBaseDeTest = async () => {
  const admin = conectarMantenimiento();
  try {
    // Corta cualquier conexión que haya quedado abierta de una corrida
    // anterior (ej. Ctrl+C a mitad de los tests) — sin esto, el DROP
    // fallaría con "la base de datos está siendo accedida por otros
    // usuarios".
    await admin.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
        WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [TEST_DB_NAME]
    );
    await admin.query(`DROP DATABASE IF EXISTS "${TEST_DB_NAME}"`);
    await admin.query(`CREATE DATABASE "${TEST_DB_NAME}"`);
    console.log(`🆕 Base de datos de test "${TEST_DB_NAME}" recreada desde cero.`);
  } finally {
    await admin.end();
  }
};

// No basta con que el servidor responda algo (GET /api/health responde
// aunque las migraciones todavía no hayan terminado — Express empieza a
// escuchar antes de que termine la cadena async de config/db.js). Se
// espera la línea EXACTA que db.js imprime al terminar
// ejecutarSchemaBase()+migrar()+repararSecuenciasId() — recién ahí el
// esquema completo (todas las tablas, no solo las de config/db.js) existe
// de verdad en sicaber_test.
const MARCA_LISTO = 'Migraciones verificadas';
const esperarBootCompleto = (child) => new Promise((resolve, reject) => {
  let listo = false;
  const timeout = setTimeout(() => {
    if (!listo) reject(new Error(`El servidor de test no terminó de arrancar (sin "${MARCA_LISTO}") en 60s.`));
  }, 60000);
  child.stdout.on('data', (buf) => {
    const texto = buf.toString();
    process.stdout.write(texto);
    if (!listo && texto.includes(MARCA_LISTO)) {
      listo = true;
      clearTimeout(timeout);
      resolve();
    }
  });
  child.stderr.on('data', (buf) => process.stderr.write(buf));
  child.on('exit', (code) => {
    if (!listo) {
      clearTimeout(timeout);
      reject(new Error(`El servidor de test terminó solo (código ${code}) antes de completar el arranque.`));
    }
  });
});

(async () => {
  await recrearBaseDeTest();

  const envServidor = { ...process.env, DB_NAME: TEST_DB_NAME, PORT: TEST_PORT };
  console.log(`🚀 Arrancando servidor de test (DB_NAME=${TEST_DB_NAME}, PORT=${TEST_PORT})...`);
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'index.js')], {
    env: envServidor,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let elServidorYaTermino = false;
  server.on('exit', () => { elServidorYaTermino = true; });

  try {
    await esperarBootCompleto(server);
  } catch (e) {
    console.error('❌', e.message);
    if (!elServidorYaTermino) server.kill();
    process.exit(1);
  }
  // A partir de acá, el resto del stdout/stderr del servidor (peticiones
  // de los propios tests) se sigue viendo en vivo (los listeners de
  // esperarBootCompleto quedan escuchando y reenviando).
  console.log('✅ Servidor de test listo. Corriendo la suite...\n');

  // --test-concurrency=1 (documentado a fondo en test/README.md): los
  // archivos de test NO están aislados entre sí — todos comparten esta
  // misma sicaber_test, y varios leen/escriben tablas GLOBALES completas
  // (ej. "cuántos insumos hay en total", "todos los locales Activos"), no
  // solo filas propias. Correr dos archivos en paralelo puede hacer que
  // uno lea un estado a medio escribir del otro — no es un problema de
  // rendimiento, es correctitud: NO lo quites sin leer esa explicación.
  const envTests = { ...envServidor, TEST_BASE_URL: `http://localhost:${TEST_PORT}/api` };
  const tests = spawn(process.execPath, ['--test', '--test-concurrency=1'], {
    env: envTests,
    stdio: 'inherit',
  });

  tests.on('exit', (code) => {
    if (!elServidorYaTermino) server.kill();
    process.exit(code ?? 1);
  });
})().catch((e) => {
  console.error('❌ No se pudo preparar el entorno de test:', e.message);
  process.exit(1);
});
