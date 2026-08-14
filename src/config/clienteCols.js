// Columnas públicas de un cliente (con alias camelCase), compartidas entre
// GET /clientes/mi-perfil (routes/index.js — lo que usa la web para "Mi
// perfil") y POST /auth/cliente/login + GET /auth/me (routes/auth.js — lo
// que usa el login/sesión, incluida la app móvil). Una sola fuente de
// verdad para que web y móvil reciban siempre el mismo perfil, con los
// mismos nombres de campo — antes cada endpoint traía su propio subconjunto
// de columnas (algunos con solo id/nombre/correo/telefono), así que campos
// como dirección, comuna, tipo/número de documento, departamento,
// municipio y fecha de registro "desaparecían" según por dónde hubiera
// entrado el cliente.
const CLIENTE_COLS = `id, nombre, correo, telefono,
  tipo_doc AS "tipoDoc", numero_doc AS "numeroDoc",
  departamento, municipio, comuna, direccion, estado,
  created_at AS "fechaRegistro"`;

module.exports = { CLIENTE_COLS };
