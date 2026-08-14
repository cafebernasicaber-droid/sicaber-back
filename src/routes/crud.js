// ─────────────────────────────────────────────────────────────
//  Fábrica de rutas CRUD genéricas para tablas simples
// ─────────────────────────────────────────────────────────────
const router = require('express').Router;
const pool   = require('../config/db');
const { auth } = require('../middleware/auth');
const validateId = require('../middleware/validateId');

// Devuelve un router con GET/POST/PUT/DELETE para una tabla
const crud = (table, fields) => {
  const r = router();
  const cols  = fields.join(', ');
  const nums  = fields.map((_, i) => `$${i + 1}`).join(', ');
  const sets  = fields.map((f, i) => `${f}=$${i + 1}`).join(', ');

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
    const vals = fields.map(f => toDbValue(req.body[f] ?? null));
    try {
      const { rows } = await pool.query(
        `INSERT INTO ${table}(${cols}) VALUES(${nums}) RETURNING *`, vals
      );
      res.status(201).json(rows[0]);
    } catch (e) {
      // 🔍 DEBUG TEMPORAL: si vuelve a fallar, esto imprime en la consola
      // del servidor exactamente qué valores se intentaron insertar.
      // Bórralo una vez confirmes que ya funciona.
      console.error(`[crud:${table}] INSERT falló`, { body: req.body, vals, dbError: e.message });
      if (e.code === '23505') return res.status(400).json({ error: 'Ya existe un registro con ese nombre' });
      res.status(500).json({ error: e.message });
    }
  });

  r.put('/:id', auth, async (req, res) => {
    const vals = [...fields.map(f => toDbValue(req.body[f] ?? null)), req.params.id];
    try {
      const { rows } = await pool.query(
        `UPDATE ${table} SET ${sets} WHERE id=$${fields.length + 1} RETURNING *`, vals
      );
      if (!rows[0]) return res.status(404).json({ error: 'No encontrado' });
      res.json(rows[0]);
    } catch (e) { res.status(500).json({ error: e.message }); }
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
