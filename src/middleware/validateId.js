// Valida que un parámetro de ruta (ej. :id en /combos/:id) sea un entero
// real antes de que llegue a una consulta SQL. Sin esto, un id no numérico
// (ej. "abc", vacío, o cualquier basura) provoca que Postgres rechace la
// consulta con "la sintaxis de entrada no es válida para tipo integer" y el
// cliente recibe un 500 críptico en vez de un 400 claro y accionable.
//
// Se registra con router.param('id', validateId) en cada router cuya
// columna "id" de tabla sea integer/SERIAL (usuarios, clientes, empleados,
// combos, categorías/roles/toppings/adiciones vía crud.js, categorias-
// insumos, insumos, pedidos).
//
// La única excepción es GET /productos/:id: esa ruta necesita aceptar
// además el id sintético de combo que arma el carrito del Landing
// ("combo-5") ANTES de decidir si es un producto o un combo, así que ese
// router NO usa este middleware para :id — valida manualmente dentro del
// propio handler con parseIdentificadorProducto() (ver PRODUCTOS en
// routes/index.js).
module.exports = (req, res, next, value) => {
  if (!/^\d+$/.test(String(value))) {
    return res.status(400).json({ error: `ID inválido: "${value}"` });
  }
  next();
};
