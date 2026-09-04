// ─────────────────────────────────────────────────────────────────────────────
//  Tipo de preparación de una ficha técnica — vocabulario y derivación
// ─────────────────────────────────────────────────────────────────────────────
// El "tipo de preparación" (fichas_tecnicas.categoria_prep) NO es un dato
// independiente que el administrador deba elegir a mano: se desprende de la
// categoría del producto. Si el producto pertenece a "bebidas calientes",
// su ficha es Caliente; si pertenece a "bebidas frías" o "jugos naturales",
// es Frío. Antes había que seleccionarlo aparte en el formulario, y nada
// impedía guardar una ficha "Caliente" para un producto de la categoría
// "bebidas frías".
//
// `derivarTipoPreparacion` devuelve null cuando la categoría no permite
// deducirlo (una categoría nueva con un nombre que no dice nada sobre la
// preparación). En ese caso —y SOLO en ese caso— el formulario deja elegir
// el tipo a mano; ver FichasTecnicasPage.jsx en el frontend, que usa este
// mismo criterio a través de su espejo src/shared/utils/tiposPreparacion.js.
//
// ⚠️ Si cambias las listas de abajo, cámbialas también en ese espejo.

// Vocabulario cerrado y único de tipos de preparación válidos. Cualquier
// otro valor se rechaza en la API (ver POST/PUT /fichas-tecnicas).
const CATEGORIAS_PREP = ['Caliente', 'Frío', 'Batido', 'Al vapor', 'Sin preparación'];

// Valor por defecto histórico de la columna categoria_prep (ver schema.sql y
// config/db.js). Se conserva como último recurso para no dejar nunca la
// columna vacía.
const CATEGORIA_PREP_DEFECTO = 'Caliente';

// Normaliza un nombre de categoría para poder compararlo: minúsculas, sin
// tildes y sin espacios sobrantes. Así "Bebidas  Frías" y "bebidas frias"
// se tratan igual (en la base de datos real existen ambas formas).
const normalizar = (texto) => String(texto ?? '')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')   // quita tildes/diéresis
  .toLowerCase()
  .replace(/\s+/g, ' ')
  .trim();

// Reglas en ORDEN DE PRIORIDAD: se aplica la primera que coincida. El orden
// importa — "malteadas frías" debe quedar como Batido (la técnica manda),
// no como Frío.
const REGLAS = [
  { tipo: 'Al vapor',        claves: ['vapor'] },
  { tipo: 'Batido',          claves: ['batid', 'malteada', 'smoothie', 'frappe', 'licuad', 'granizad', 'milkshake'] },
  { tipo: 'Caliente',        claves: ['calient'] },
  // Nota: se usan raíces completas ('frio'/'fria'/'helad') y no un simple
  // 'fri', para que una categoría como "fritos" no se clasifique como Frío.
  { tipo: 'Frío',            claves: ['frio', 'fria', 'helad', 'congelad', 'refriger', 'fresc', 'jugo', 'limonada', 'gaseosa', 'soda', 'iced'] },
  { tipo: 'Sin preparación', claves: ['sin preparacion', 'postre', 'panader', 'reposter', 'snack', 'empaquet', 'paquete'] },
];

// Devuelve el tipo de preparación que corresponde a una categoría de
// producto, o null si no se puede deducir con certeza.
const derivarTipoPreparacion = (categoriaProducto) => {
  const cat = normalizar(categoriaProducto);
  if (!cat) return null;
  for (const regla of REGLAS) {
    if (regla.claves.some(clave => cat.includes(clave))) return regla.tipo;
  }
  return null;
};

// true si el valor recibido es uno de los tipos válidos.
const tipoPreparacionValido = (valor) => CATEGORIAS_PREP.includes(String(valor ?? '').trim());

// Resuelve el valor definitivo que se va a guardar en categoria_prep:
//   1. Si la categoría del producto permite deducirlo, MANDA la derivación
//      (es lo mismo que muestra el formulario, bloqueado y en solo lectura,
//      así que servidor e interfaz nunca se contradicen).
//   2. Si no se puede deducir, se respeta lo que eligió el usuario, siempre
//      que sea un valor del vocabulario.
//   3. Si tampoco eso es válido, se cae al valor por defecto.
const resolverTipoPreparacion = (categoriaProducto, valorRecibido) => {
  const derivado = derivarTipoPreparacion(categoriaProducto);
  if (derivado) return derivado;
  const recibido = String(valorRecibido ?? '').trim();
  if (tipoPreparacionValido(recibido)) return recibido;
  return CATEGORIA_PREP_DEFECTO;
};

module.exports = {
  CATEGORIAS_PREP,
  CATEGORIA_PREP_DEFECTO,
  derivarTipoPreparacion,
  tipoPreparacionValido,
  resolverTipoPreparacion,
};
