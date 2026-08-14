// Regla única de fortaleza de contraseña — se aplica en TODO punto del
// backend donde se CREA o CAMBIA una contraseña (registro de cliente,
// reset de contraseña, creación/edición de usuarios administrativos).
// Nunca se aplica en login: ahí solo se compara contra el hash ya
// guardado, no se valida formato.
//
// Al menos 10 caracteres, al menos una letra, un número y un carácter
// especial (cualquiera que no sea letra ni número).
const PASSWORD_REGEX = /^(?=.*[A-Za-z])(?=.*\d)(?=.*[^A-Za-z0-9]).{10,}$/;
const PASSWORD_ERROR = 'La contraseña debe tener mínimo 10 caracteres, incluir letras, números y al menos un carácter especial.';

const passwordValida = (password) => typeof password === 'string' && PASSWORD_REGEX.test(password);

module.exports = { PASSWORD_REGEX, PASSWORD_ERROR, passwordValida };
