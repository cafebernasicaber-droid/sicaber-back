// ─────────────────────────────────────────────────────────────────────────
//  Códigos de verificación de 6 dígitos (registro y recuperación)
// ─────────────────────────────────────────────────────────────────────────
// Antes, el ciclo de vida del código estaba repartido a pedazos dentro de
// routes/auth.js y tenía tres agujeros reales:
//
//   1. NO se invalidaba el código anterior. Cada `INSERT INTO
//      tokens_verificacion` agregaba una fila más, y la consulta de
//      verificación aceptaba CUALQUIER fila con usado=false y no expirada.
//      Resultado: si un usuario pedía el código tres veces, los TRES
//      seguían sirviendo — incluido el primero, el que pudo haberse filtrado
//      en una bandeja compartida o en una captura de pantalla.
//   2. `Math.random()` no es criptográficamente seguro: su secuencia se
//      puede predecir observando suficientes salidas. Para un código que
//      da acceso a una cuenta, eso es un generador equivocado.
//   3. Intentos ILIMITADOS: un código de 6 dígitos son un millón de
//      combinaciones; sin límite de intentos ni vigencia corta, probarlas
//      todas contra el endpoint es perfectamente viable.
//
// Este módulo centraliza el ciclo completo — generar, invalidar los
// anteriores, guardar con vencimiento explícito, controlar el reenvío y
// validar — para que registro, recuperación y reenvío se comporten igual
// y ninguna ruta pueda "olvidarse" de un paso.
const crypto = require('crypto');
const pool = require('../config/db');

// Vigencia del código. Se escribe EXPLÍCITAMENTE en el INSERT y no se
// depende del DEFAULT de la columna: el default solo se aplica a las filas
// creadas después de la migración, así que cambiarlo ahí no habría afectado
// a una base ya creada, y el correo prometería una vigencia distinta a la
// real.
const VIGENCIA_MINUTOS = Number(process.env.CODIGO_VIGENCIA_MINUTOS || 15);
// Espera mínima entre dos envíos al MISMO correo — evita que alguien use
// el botón de "reenviar" como ametralladora de correos (y que Gmail acabe
// bloqueando la cuenta del remitente por envío masivo).
const REENVIO_COOLDOWN_SEGUNDOS = Number(process.env.CODIGO_REENVIO_COOLDOWN_SEG || 60);
// Intentos fallidos permitidos por código antes de invalidarlo. Con 5
// intentos y vigencia de 15 minutos, adivinar 1 de 1.000.000 es inviable.
const MAX_INTENTOS = Number(process.env.CODIGO_MAX_INTENTOS || 5);

const TIPOS_VALIDOS = ['registro', 'recuperacion'];

// crypto.randomInt (no Math.random): el rango 0..999999 se rellena a 6
// dígitos con padStart, así que "000042" es un código válido y el espacio
// de búsqueda es el millón completo, no 900.000 como con el
// `100000 + random*900000` anterior.
const generarCodigo = () => String(crypto.randomInt(0, 1000000)).padStart(6, '0');

const normalizarCorreo = (correo) => String(correo || '').trim().toLowerCase();

// Comparación en tiempo constante. Con un `===` normal, el tiempo de
// respuesta depende de cuántos caracteres coinciden desde el principio —
// una diferencia medible que filtra el código dígito a dígito.
const codigosIguales = (a, b) => {
  const bufA = Buffer.from(String(a || ''), 'utf8');
  const bufB = Buffer.from(String(b || ''), 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
};

// Invalida TODOS los códigos vivos de ese correo+tipo. Se llama siempre
// justo antes de crear uno nuevo: "el último código enviado es el único
// válido" es la regla que espera cualquier usuario, y la que evita que un
// código viejo filtrado siga sirviendo.
const invalidarAnteriores = async (ejecutor, correo, tipo) => {
  const { rowCount } = await ejecutor.query(
    `UPDATE tokens_verificacion
        SET usado = true
      WHERE lower(correo) = lower($1) AND tipo = $2 AND usado = false`,
    [normalizarCorreo(correo), tipo]
  );
  return rowCount;
};

// Segundos que faltan para poder pedir otro código, o 0 si ya se puede.
// Se mide contra el ÚLTIMO código emitido (usado o no): si se midiera solo
// contra los no usados, verificar mal una vez y volver a pedir saltaría el
// límite.
const segundosParaReenviar = async (correo, tipo) => {
  const { rows } = await pool.query(
    `SELECT GREATEST(0, $3 - FLOOR(EXTRACT(EPOCH FROM (NOW() - created_at))))::int AS faltan
       FROM tokens_verificacion
      WHERE lower(correo) = lower($1) AND tipo = $2
      ORDER BY created_at DESC
      LIMIT 1`,
    [normalizarCorreo(correo), tipo, REENVIO_COOLDOWN_SEGUNDOS]
  );
  return rows[0]?.faltan ?? 0;
};

// Genera, invalida los anteriores y guarda el nuevo, TODO en una sola
// transacción: si el INSERT fallara después del UPDATE, el usuario se
// quedaría sin ningún código válido y sin forma de saberlo.
const emitirCodigo = async (correo, tipo) => {
  if (!TIPOS_VALIDOS.includes(tipo)) throw new Error(`Tipo de código no válido: ${tipo}`);
  const correoLimpio = normalizarCorreo(correo);
  const codigo = generarCodigo();

  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');
    const invalidados = await invalidarAnteriores(cliente, correoLimpio, tipo);
    const { rows } = await cliente.query(
      `INSERT INTO tokens_verificacion(correo, token, tipo, usado, intentos, expires_at)
       VALUES ($1, $2, $3, false, 0, NOW() + ($4 || ' minutes')::interval)
       RETURNING id, expires_at`,
      [correoLimpio, codigo, tipo, String(VIGENCIA_MINUTOS)]
    );
    await cliente.query('COMMIT');
    return {
      codigo,
      id: rows[0].id,
      expiraEn: rows[0].expires_at,
      minutos: VIGENCIA_MINUTOS,
      invalidados,
    };
  } catch (e) {
    await cliente.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    cliente.release();
  }
};

// Motivos posibles del fallo, para que la ruta pueda dar un mensaje
// EXACTO (y el frontend distinguir "pedí otro código" de "revisa el
// número que escribiste"):
//   • 'no_solicitado' → nunca se pidió un código, o ya se usó el que había
//   • 'expirado'      → existía pero venció
//   • 'bloqueado'     → se agotaron los intentos de ese código
//   • 'invalido'      → el código no coincide (trae intentosRestantes)
const validarCodigo = async (correo, tipo, codigoRecibido) => {
  const correoLimpio = normalizarCorreo(correo);
  const codigo = String(codigoRecibido ?? '').trim();
  if (!/^\d{6}$/.test(codigo)) {
    // Ni siquiera tiene forma de código: se rechaza sin tocar la base (así
    // un bucle de basura no gasta los intentos del código real del usuario).
    return { ok: false, motivo: 'invalido', intentosRestantes: null, formato: true };
  }

  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');
    // FOR UPDATE: dos peticiones simultáneas con el mismo código no pueden
    // leer ambas "usado=false" y darlo por bueno las dos veces.
    const { rows } = await cliente.query(
      `SELECT id, token, intentos, (expires_at <= NOW()) AS expirado
         FROM tokens_verificacion
        WHERE lower(correo) = lower($1) AND tipo = $2 AND usado = false
        ORDER BY created_at DESC
        LIMIT 1
        FOR UPDATE`,
      [correoLimpio, tipo]
    );
    const fila = rows[0];
    if (!fila) {
      await cliente.query('COMMIT');
      return { ok: false, motivo: 'no_solicitado' };
    }
    if (fila.expirado) {
      // Se marca usado para que no quede ocupando el lugar del próximo.
      await cliente.query('UPDATE tokens_verificacion SET usado = true WHERE id = $1', [fila.id]);
      await cliente.query('COMMIT');
      return { ok: false, motivo: 'expirado' };
    }
    if (fila.intentos >= MAX_INTENTOS) {
      await cliente.query('UPDATE tokens_verificacion SET usado = true WHERE id = $1', [fila.id]);
      await cliente.query('COMMIT');
      return { ok: false, motivo: 'bloqueado' };
    }
    if (!codigosIguales(fila.token, codigo)) {
      const { rows: tras } = await cliente.query(
        `UPDATE tokens_verificacion SET intentos = intentos + 1 WHERE id = $1 RETURNING intentos`,
        [fila.id]
      );
      const intentosRestantes = Math.max(0, MAX_INTENTOS - tras[0].intentos);
      // Al agotarse, el código queda quemado en el acto: no se puede seguir
      // probando ni esperando a que "se libere".
      if (intentosRestantes === 0) {
        await cliente.query('UPDATE tokens_verificacion SET usado = true WHERE id = $1', [fila.id]);
      }
      await cliente.query('COMMIT');
      return { ok: false, motivo: intentosRestantes === 0 ? 'bloqueado' : 'invalido', intentosRestantes };
    }
    // Correcto: se consume inmediatamente (un código sirve UNA sola vez).
    await cliente.query('UPDATE tokens_verificacion SET usado = true WHERE id = $1', [fila.id]);
    await cliente.query('COMMIT');
    return { ok: true, id: fila.id };
  } catch (e) {
    await cliente.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    cliente.release();
  }
};

// Mensajes de cara al usuario, uno por motivo. Centralizados acá para que
// /cliente/verificar y /cliente/reset-password digan exactamente lo mismo
// ante la misma situación.
const MENSAJE_MOTIVO = {
  no_solicitado: 'No hay ningún código pendiente para ese correo. Solicita uno nuevo.',
  expirado:      'El código expiró. Solicita uno nuevo para continuar.',
  bloqueado:     'Se agotaron los intentos para ese código. Solicita uno nuevo.',
  invalido:      'El código no es correcto. Revisa los 6 dígitos e intenta de nuevo.',
};
const mensajeMotivo = (motivo, intentosRestantes) => {
  const base = MENSAJE_MOTIVO[motivo] || MENSAJE_MOTIVO.invalido;
  if (motivo === 'invalido' && Number.isInteger(intentosRestantes)) {
    return `${base} Te quedan ${intentosRestantes} intento${intentosRestantes === 1 ? '' : 's'}.`;
  }
  return base;
};

module.exports = {
  VIGENCIA_MINUTOS,
  REENVIO_COOLDOWN_SEGUNDOS,
  MAX_INTENTOS,
  generarCodigo,
  emitirCodigo,
  invalidarAnteriores,
  segundosParaReenviar,
  validarCodigo,
  mensajeMotivo,
};
