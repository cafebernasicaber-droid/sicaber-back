// ─────────────────────────────────────────────────────────────────────────────
//  Validaciones compartidas de texto (nombres, duplicados y longitudes)
// ─────────────────────────────────────────────────────────────────────────────
// Todas estas reglas ya existían en el frontend (React), pero NO en la API.
// Eso significaba que llamando el servidor directamente (Postman, curl, o
// cualquier otro cliente que en el futuro se conecte a esta misma API) se
// podían saltar por completo: guardar un nombre de puros espacios, repetir un
// nombre cambiando mayúsculas, o mandar una descripción de 50.000 caracteres.
//
// Este módulo centraliza esas tres reglas para que cada router las aplique
// igual, sin copiar/pegar la misma lógica quince veces:
//   1. `textoLimpio` / `nombreNormalizado` → quitar espacios sobrantes.
//   2. `nombreDuplicado`                   → comparar ignorando mayúsculas y
//                                            espacios de más.
//   3. `LIMITES` / `errorLongitud`         → tope máximo de caracteres.
//
// ⚠️ Importante: este módulo NO cambia ningún comportamiento por sí solo. Solo
// expone funciones puras (+ una consulta de duplicados). Cada router decide
// dónde aplicarlas, de forma que un módulo que ya validaba bien (ej. Roles)
// siga funcionando exactamente igual que antes.

// Quita espacios al inicio y al final. Acepta null/undefined/números sin
// reventar (devuelve '' o el número como texto).
const textoLimpio = (valor) => (valor === undefined || valor === null) ? '' : String(valor).trim();

// Igual que textoLimpio, pero además colapsa cualquier secuencia de espacios
// internos (o tabs/saltos de línea) en un solo espacio. Es lo que se guarda
// para los NOMBRES, para que "Café   Latte" y "Café Latte" nunca queden como
// dos registros distintos en la base de datos.
const nombreNormalizado = (valor) => textoLimpio(valor).replace(/\s+/g, ' ');

// true cuando el valor no tiene ningún contenido real (vacío, null, o puros
// espacios en blanco: "   ", "\t", "\n").
const estaVacio = (valor) => textoLimpio(valor).length === 0;

// ── Topes de longitud ───────────────────────────────────────────────────────
// Los de NOMBRE_* coinciden con el ancho real de las columnas VARCHAR en la
// base de datos (ver schema.sql), así que además de dar un mensaje claro
// evitan el error crudo de Postgres "value too long for type character
// varying(100)". Los de texto largo son criterios de producto: las columnas
// son TEXT (sin tope propio), así que sin esto aceptaban cualquier tamaño.
const LIMITES = {
  NOMBRE_CORTO:   100,  // VARCHAR(100): categorías, toppings, adiciones, locales, roles
  NOMBRE:         150,  // VARCHAR(150): productos, combos, insumos, proveedores, usuarios, empleados
  DESCRIPCION:    500,  // descripciones de productos, insumos, combos, categorías, adiciones
  OBSERVACIONES:  500,  // observaciones de proveedores y compras
  NOTAS_FICHA:    500,  // notas y resumen de preparación de una ficha técnica
  PREPARACION:   2000,  // paso a paso de preparación (el más largo del sistema)
  MOTIVO:         500,  // motivo de devolución y de anulación de compra
  MOTIVO_MINIMO:   10,  // mínimo del motivo de devolución (igual que la pantalla)
  RESENA:         400,  // texto de una reseña (igual que el contador de la landing)
};

// ── Validador de nombres ────────────────────────────────────────────────────
// Devuelve un string con el mensaje de error, o null si el nombre es válido.
// `etiqueta` es cómo se llama el campo de cara al usuario ("El nombre del
// producto", "La categoría", ...) para que el mensaje se lea natural.
const errorNombre = (valor, etiqueta = 'El nombre', max = LIMITES.NOMBRE) => {
  if (estaVacio(valor)) return `${etiqueta} es obligatorio y no puede contener solo espacios en blanco.`;
  const limpio = nombreNormalizado(valor);
  if (limpio.length > max) return `${etiqueta} no puede superar los ${max} caracteres (tiene ${limpio.length}).`;
  return null;
};

// ── Validador de campos de texto largo ──────────────────────────────────────
// A diferencia de errorNombre, aquí el campo es OPCIONAL: si viene vacío o no
// viene, no es un error. Solo se revisa el tope máximo. `minimo` es opcional y
// solo lo usa el motivo de devolución (que sí exige un mínimo).
const errorLongitud = (valor, etiqueta, max, minimo = 0) => {
  const limpio = textoLimpio(valor);
  if (minimo > 0 && limpio.length > 0 && limpio.length < minimo) {
    return `${etiqueta} debe tener al menos ${minimo} caracteres.`;
  }
  if (limpio.length > max) {
    return `${etiqueta} no puede superar los ${max} caracteres (tiene ${limpio.length}).`;
  }
  return null;
};

// ── Validador de número de documento ───────────────────────────────────────
// El número de documento (cédula colombiana y equivalentes) es OPCIONAL, pero
// si viene tiene que ser SOLO dígitos y como MÁXIMO 10 — una cédula colombiana
// nunca pasa de 10 dígitos, así que un valor más largo es siempre un error de
// tipeo o un intento de meter basura. Devuelve el mensaje de error o null.
const errorDocumento = (valor, etiqueta = 'El número de documento') => {
  const limpio = textoLimpio(valor);
  if (!limpio) return null; // opcional
  if (!/^\d+$/.test(limpio)) return `${etiqueta} solo puede contener números.`;
  if (limpio.length > 10) return `${etiqueta} no puede tener más de 10 dígitos (tiene ${limpio.length}).`;
  return null;
};

// ── Detector de nombres duplicados ──────────────────────────────────────────
// Compara ignorando mayúsculas/minúsculas Y espacios sobrantes, tanto del
// valor nuevo como de los que ya están guardados. Esto último importa: aunque
// de ahora en adelante todos los nombres se guarden normalizados, en la base
// de datos ya pueden existir filas viejas con espacios de más ("  Lácteos "),
// y esas también tienen que reconocerse como duplicadas.
//
//   pool        → el pool de pg (se recibe por parámetro para que este módulo
//                 no dependa de config/db.js y siga siendo puramente utilitario)
//   tabla       → nombre de la tabla (nunca viene del usuario: siempre es una
//                 constante escrita en el código de cada router)
//   valor       → el nombre que se quiere guardar
//   excluirId   → al editar, el id del propio registro (para que no se
//                 detecte a sí mismo como duplicado). null al crear.
//   columna     → por defecto 'nombre'; 'correo' para el registro de clientes.
const nombreDuplicado = async (pool, tabla, valor, excluirId = null, columna = 'nombre') => {
  const limpio = nombreNormalizado(valor);
  if (!limpio) return false; // un valor vacío lo rechaza errorNombre, no esto

  // Misma normalización a ambos lados de la comparación.
  const expresionColumna = `lower(btrim(regexp_replace(${columna}, '\\s+', ' ', 'g')))`;
  const params = excluirId ? [limpio.toLowerCase(), excluirId] : [limpio.toLowerCase()];
  const condicion = excluirId
    ? `${expresionColumna} = $1 AND id <> $2`
    : `${expresionColumna} = $1`;

  const { rows } = await pool.query(`SELECT id FROM ${tabla} WHERE ${condicion} LIMIT 1`, params);
  return !!rows[0];
};

module.exports = {
  textoLimpio,
  nombreNormalizado,
  estaVacio,
  LIMITES,
  errorNombre,
  errorLongitud,
  errorDocumento,
  nombreDuplicado,
};
