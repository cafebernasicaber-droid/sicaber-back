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
// cuentas creadas ANTES de esta política (incluida cualquier contraseña más
// corta o sin carácter especial, o el admin sembrado con "admin2024#") siguen
// pudiendo iniciar sesión con normalidad; solo se les exigirá la regla
// vigente el día que cambien su contraseña.
//
// Regla vigente (reemplaza la anterior — ronda de ajustes):
//   • entre 10 y 20 caracteres (antes no había tope máximo)
//   • al menos 1 letra minúscula
//   • al menos 1 letra MAYÚSCULA
//   • al menos 1 dígito numérico (antes exigía 8; ahora basta con 1)
//   • al menos 1 carácter especial (ni letra ni número)
//
// El espejo exacto de este archivo en el frontend está en
// src/shared/utils/passwordPolicy.js — si cambias algo acá, cámbialo
// también allá (y al revés).

const PASSWORD_MIN_LONGITUD = 10;
const PASSWORD_MAX_LONGITUD = 20;
const PASSWORD_MIN_DIGITOS  = 1;

// Regex exacto acordado: minúscula + mayúscula + dígito + especial, todo
// dentro de una longitud de 10 a 20. `.` no cruza saltos de línea por
// defecto, que es justo lo que se quiere (una contraseña no debería
// contener un salto de línea).
const PASSWORD_REGEX = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).{10,20}$/;

const PASSWORD_ERROR =
  'La contraseña debe tener entre 10 y 20 caracteres, con al menos una mayúscula, una minúscula, un número y un carácter especial.';

const passwordValida = (password) => typeof password === 'string' && PASSWORD_REGEX.test(password);

// Se conserva por compatibilidad con quien ya importa esta función
// esperando un arreglo (antes daba un detalle por requisito faltante) —
// ahora el negocio pidió UN mensaje único y fijo para todo el que no
// cumpla, así que el arreglo tiene como mucho un elemento.
const erroresPassword = (password) => (passwordValida(password) ? [] : [PASSWORD_ERROR]);

// Mensaje listo para responder al cliente. Devuelve null cuando la
// contraseña sí cumple.
const errorPassword = (password) => (passwordValida(password) ? null : PASSWORD_ERROR);

module.exports = {
  PASSWORD_REGEX,
  PASSWORD_ERROR,
  PASSWORD_MIN_LONGITUD,
  PASSWORD_MAX_LONGITUD,
  PASSWORD_MIN_DIGITOS,
  passwordValida,
  erroresPassword,
  errorPassword,
};
