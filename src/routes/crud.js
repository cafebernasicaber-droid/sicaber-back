// ─────────────────────────────────────────────────────────────
//  Fábrica de rutas CRUD genéricas para tablas simples
// ─────────────────────────────────────────────────────────────
const router = require('express').Router;
const pool   = require('../config/db');
const { auth } = require('../middleware/auth');
const validateId = require('../middleware/validateId');
const {
  nombreNormalizado, errorNombre, errorLongitud, nombreDuplicado, LIMITES,
} = require('../config/validaciones');

// Devuelve un router con GET/POST/PUT/DELETE para una tabla
//
// `opciones` (tercer parámetro, OPCIONAL — sin él el comportamiento es
// exactamente el de antes, para no alterar ningún uso existente):
//   {
//     etiqueta:      'La categoría',   // cómo se nombra el registro en los mensajes
//     validarNombre: true,             // exige nombre no vacío / no solo espacios
//     maxNombre:     100,              // tope de caracteres del nombre
//     nombreUnico:   true,             // rechaza duplicados ignorando may/min y espacios
//     limites:       { descripcion: 500 },  // topes de otros campos de texto
//   }
const crud = (table, fields, opciones = {}) => {
  const r = router();
  const cols  = fields.join(', ');
  const nums  = fields.map((_, i) => `$${i + 1}`).join(', ');
  const sets  = fields.map((f, i) => `${f}=$${i + 1}`).join(', ');

  const {
    etiqueta      = 'El nombre',
    validarNombre = false,
    maxNombre     = LIMITES.NOMBRE_CORTO,
    nombreUnico   = false,
    limites       = {},
  } = opciones;

  // Corre las validaciones configuradas y devuelve el mensaje de error, o
  // null si todo está bien. `excluirId` solo se usa en el PUT.
  const validarBody = async (body, excluirId = null) => {
    if (validarNombre) {
      const err = errorNombre(body.nombre, etiqueta, maxNombre);
      if (err) return err;
    }
    for (const [campo, max] of Object.entries(limites)) {
      const err = errorLongitud(body[campo], `El campo "${campo}"`, max);
      if (err) return err;
    }
    if (nombreUnico && await nombreDuplicado(pool, table, body.nombre, excluirId)) {
      return `Ya existe un registro con ese nombre.`;
    }
    return null;
  };

  // Guarda el nombre ya normalizado (sin espacios sobrantes al inicio, al
  // final, ni repetidos en medio), para que la detección de duplicados de
  // arriba siga siendo consistente con lo que quedó realmente en la tabla.
  const normalizarBody = (body) => {
    if (!validarNombre && !nombreUnico) return body;
    if (body.nombre === undefined || body.nombre === null) return body;
    return { ...body, nombre: nombreNormalizado(body.nombre) };
  };

  // Todas las tablas usadas con este CRUD genérico (roles, categorias,
  // toppings, adiciones) tienen id integer/SERIAL. Valida el :id antes de
  // que cualquiera de las rutas de abajo lo use en una consulta.
  r.param('id', validateId);

  r.get('/', async (req, res) => {
    try {
      const { rows } = await pool.query(`SELECT * FROM ${table} ORDER BY id DESC`);
      res.json(rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  r.get('/:id', async (req, res) => {
    try {
      const { rows } = await pool.query(`SELECT * FROM ${table} WHERE id=$1`, [req.params.id]);
      if (!rows[0]) return res.status(404).json({ error: 'No encontrado' });
      res.json(rows[0]);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Los campos que llegan como array/objeto (ej: 'permisos' de roles,
  // 'items' de combos) deben convertirse a texto JSON antes de mandarlos
  // a Postgres, porque las columnas jsonb no aceptan un arreglo JS crudo.
  const toDbValue = (v) => (v !== null && typeof v === 'object') ? JSON.stringify(v) : v;

  r.post('/', auth, async (req, res) => {
    try {
      const errorValidacion = await validarBody(req.body, null);
      if (errorValidacion) return res.status(400).json({ error: errorValidacion });

      const body = normalizarBody(req.body);
      const vals = fields.map(f => toDbValue(body[f] ?? null));
      const { rows } = await pool.query(
        `INSERT INTO ${table}(${cols}) VALUES(${nums}) RETURNING *`, vals
      );
      res.status(201).json(rows[0]);
    } catch (e) {
      if (e.code === '23505') return res.status(400).json({ error: 'Ya existe un registro con ese nombre' });
      res.status(500).json({ error: e.message });
    }
  });

  r.put('/:id', auth, async (req, res) => {
    try {
      const errorValidacion = await validarBody(req.body, req.params.id);
      if (errorValidacion) return res.status(400).json({ error: errorValidacion });

      const body = normalizarBody(req.body);
      const vals = [...fields.map(f => toDbValue(body[f] ?? null)), req.params.id];
      const { rows } = await pool.query(
        `UPDATE ${table} SET ${sets} WHERE id=$${fields.length + 1} RETURNING *`, vals
      );
      if (!rows[0]) return res.status(404).json({ error: 'No encontrado' });
      res.json(rows[0]);
    } catch (e) {
      if (e.code === '23505') return res.status(400).json({ error: 'Ya existe un registro con ese nombre' });
      res.status(500).json({ error: e.message });
    }
  });

  r.patch('/:id/estado', auth, async (req, res) => {
    try {
      const { rows } = await pool.query(
        `UPDATE ${table} SET estado = CASE WHEN estado='Activo' THEN 'Inactivo' ELSE 'Activo' END WHERE id=$1 RETURNING *`,
        [req.params.id]
      );
      res.json(rows[0]);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  r.delete('/:id', auth, async (req, res) => {
    try {
      await pool.query(`DELETE FROM ${table} WHERE id=$1`, [req.params.id]);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  return r;
};

module.exports = crud;
