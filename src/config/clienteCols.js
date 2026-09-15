// Columnas públicas de un cliente (con alias camelCase), compartidas entre
// GET /clientes/mi-perfil (routes/index.js — lo que usa la web para "Mi
// perfil") y POST /auth/cliente/login + GET /auth/me (routes/auth.js — lo
// que usa el login/sesión, incluida la app móvil). Una sola fuente de
// verdad para que web y móvil reciban siempre el mismo perfil, con los
// mismos nombres de campo — antes cada endpoint traía su propio subconjunto
// de columnas (algunos con solo id/nombre/correo/telefono), así que campos
// como tipo/número de documento y fecha de registro "desaparecían" según
// por dónde hubiera entrado el cliente.
//
// RETIRADO: departamento/municipio/comuna/direccion — el cliente ya no
// maneja dirección de registro (ver la migración de baja en config/db.js).
// La dirección de ENTREGA de un pedido a domicilio sigue viva y sin
// cambios: es pedidos.direccion_alternativa, un campo propio del pedido,
// nunca derivado de este perfil.
const CLIENTE_COLS = `id, nombre, correo, telefono,
  tipo_doc AS "tipoDoc", numero_doc AS "numeroDoc", estado,
  created_at AS "fechaRegistro"`;

module.exports = { CLIENTE_COLS };
