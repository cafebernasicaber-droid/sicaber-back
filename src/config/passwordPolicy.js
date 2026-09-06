// ─────────────────────────────────────────────────────────────────────────────
//  Política ÚNICA de fortaleza de contraseña
// ─────────────────────────────────────────────────────────────────────────────
// Se aplica en TODO punto del backend donde se CREA o CAMBIA una contraseña
// (registro de cliente, reset de contraseña, creación/edición de usuarios
// administrativos, y la cuenta de acceso que se crea junto con un empleado
// Cajero/Bartender).
//
// ⚠️ NUNCA se aplica en el login: ahí solo se compara contra el hash ya
// guardado, no se valida formato. Esto es a propósito y es importante — las
// cuentas creadas ANTES de esta política (incluido el admin sembrado con
// "admin2024#") siguen pudiendo iniciar sesión con normalidad; solo se les
// exigirá la nueva regla el día que cambien su contraseña.
//
// Regla acordada con el negocio:
//   • mínimo 10 caracteres
//   • al menos 8 dígitos numéricos
//   • al menos 1 letra MAYÚSCULA
//   • al menos 1 carácter especial (ni letra ni número ni espacio)
//
// (8 dígitos + 1 mayúscula + 1 especial = 10 caracteres, así que el mínimo
// de longitud es consistente con el resto de reglas: nunca es contradictorio.)
//
// El espejo exacto de este archivo en el frontend está en
// src/shared/utils/passwordPolicy.js — si cambias un número acá, cámbialo
// también allá (y al revés).

const PASSWORD_MIN_LONGITUD = 10;
const PASSWORD_MIN_DIGITOS  = 8;

// Letras (con acentos y ñ) para poder decidir qué NO es letra. Se listan
// explícitamente en vez de usar rangos tipo À-ÿ para que "ñ" o "é" nunca se
// cuenten por error como "carácter especial".
const LETRAS = 'A-Za-zÁÉÍÓÚÜÑáéíóúüñ';
const RE_DIGITO     = /\d/g;
const RE_MAYUSCULA  = /[A-ZÁÉÍÓÚÜÑ]/;
// Especial = cualquier cosa que no sea letra, ni dígito, ni espacio en
// blanco. El espacio se excluye a propósito: " " no debe contar como el
// carácter especial obligatorio.
const RE_ESPECIAL   = new RegExp(`[^${LETRAS}0-9\\s]`);

// Regex equivalente a las 4 reglas de arriba, en una sola expresión. Se
// conserva exportada porque ya formaba parte de la API pública de este
// módulo; la validación real la hacen las funciones de abajo, que además
// pueden decir EXACTAMENTE qué requisito falta.
const PASSWORD_REGEX = new RegExp(
  `^(?=(?:[^0-9]*[0-9]){${PASSWORD_MIN_DIGITOS}})` +      // ≥ 8 dígitos
  `(?=.*[A-ZÁÉÍÓÚÜÑ])` +                                   // ≥ 1 mayúscula
  `(?=.*[^${LETRAS}0-9\\s])` +                             // ≥ 1 especial
  `[\\s\\S]{${PASSWORD_MIN_LONGITUD},}$`                   // ≥ 10 caracteres
);

const PASSWORD_ERROR =
  `La contraseña debe tener mínimo ${PASSWORD_MIN_LONGITUD} caracteres e incluir al menos ` +
  `${PASSWORD_MIN_DIGITOS} números, 1 letra mayúscula y 1 carácter especial (por ejemplo: # $ % & * -).`;

const contarDigitos = (password) => (String(password).match(RE_DIGITO) || []).length;

// Devuelve la lista de requisitos que NO se cumplen (vacía = contraseña
// válida). Sirve para dar un mensaje específico en vez del genérico.
const erroresPassword = (password) => {
  const faltas = [];
  if (typeof password !== 'string' || password.length === 0) {
    return ['La contraseña es obligatoria.'];
  }
  if (password.length < PASSWORD_MIN_LONGITUD) {
    faltas.push(`debe tener mínimo ${PASSWORD_MIN_LONGITUD} caracteres (tiene ${password.length})`);
  }
  const digitos = contarDigitos(password);
  if (digitos < PASSWORD_MIN_DIGITOS) {
    faltas.push(`debe incluir al menos ${PASSWORD_MIN_DIGITOS} números (tiene ${digitos})`);
  }
  if (!RE_MAYUSCULA.test(password)) faltas.push('debe incluir al menos 1 letra mayúscula');
  if (!RE_ESPECIAL.test(password))  faltas.push('debe incluir al menos 1 carácter especial (por ejemplo: # $ % & * -)');
  return faltas;
};

const passwordValida = (password) => erroresPassword(password).length === 0;

// Mensaje listo para responder al cliente: dice exactamente qué falta.
// Devuelve null cuando la contraseña sí cumple.
const errorPassword = (password) => {
  const faltas = erroresPassword(password);
  if (faltas.length === 0) return null;
  if (faltas.length === 1 && faltas[0].endsWith('.')) return faltas[0]; // "es obligatoria."
  return `La contraseña ${faltas.join(', ')}.`;
};

module.exports = {
  PASSWORD_REGEX,
  PASSWORD_ERROR,
  PASSWORD_MIN_LONGITUD,
  PASSWORD_MIN_DIGITOS,
  passwordValida,
  erroresPassword,
  errorPassword,
};
