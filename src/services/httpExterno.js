// ─────────────────────────────────────────────────────────────────────────
//  Cliente HTTP para servicios EXTERNOS (geocodificación)
// ─────────────────────────────────────────────────────────────────────────
// CAUSA RAÍZ del "la geocodificación funciona local pero no desplegada":
//
//   El `fetch` global de Node NO tiene timeout por defecto. Ninguno. Si el
//   servidor del otro lado acepta la conexión y no contesta nunca (que es
//   exactamente lo que pasa con www.medellin.gov.co desde un datacenter
//   fuera de Colombia: el servidor de catastro responde lentísimo o deja
//   la conexión abierta sin contestar), la promesa NUNCA se resuelve.
//
//   En geocoding.js eso se traducía en que `determinarSedePorDireccion`
//   quedaba colgada para siempre → POST /pedidos y /verificar-cobertura
//   no respondían jamás → el checkout se quedaba "cargando" sin error ni
//   éxito. Local no se notaba: desde una conexión colombiana, el catastro
//   responde en menos de un segundo.
//
// Este módulo pone un techo duro a CADA llamada externa (AbortController),
// reintenta solo lo que tiene sentido reintentar, y clasifica los fallos
// para que quien llama pueda distinguir "el servicio no está disponible"
// de "el servicio contestó que no encontró nada" — dos cosas que antes se
// mezclaban en el mismo catch y producían el mismo mensaje.

// Error tipado: lo que sale de acá siempre trae `tipo`, para decidir sin
// leer strings de mensajes.
//   'timeout'    → se agotó el tiempo de espera
//   'red'        → DNS, conexión rechazada, TLS, socket cortado
//   'http'       → el servidor contestó con un código de error (trae .status)
//   'respuesta'  → contestó 200 pero el cuerpo no es el JSON esperado
class ErrorServicioExterno extends Error {
  constructor(tipo, mensaje, extra = {}) {
    super(mensaje);
    this.name = 'ErrorServicioExterno';
    this.tipo = tipo;
    Object.assign(this, extra);
  }
}

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

// Códigos HTTP que vale la pena reintentar: 429 (nos pasamos de cuota, el
// siguiente intento con espera puede pasar) y los 5xx (fallo temporal del
// otro lado). Un 400/401/404 se reintentaría eternamente sin cambiar nada.
const reintentable = (status) => status === 429 || status === 408 || (status >= 500 && status < 600);

/**
 * GET a un servicio externo con timeout duro, reintentos y parseo de JSON.
 *
 * @param {string} url
 * @param {object} opciones
 *   timeoutMs   → techo por intento (por defecto 6 s)
 *   reintentos  → intentos adicionales tras el primero (por defecto 1)
 *   esperaMs    → espera base entre reintentos, crece al doble cada vez
 *   etiqueta    → nombre del servicio, solo para los logs
 * @returns {Promise<any>} el JSON ya parseado
 * @throws {ErrorServicioExterno}
 */
const obtenerJson = async (url, {
  timeoutMs = 6000,
  reintentos = 1,
  esperaMs = 400,
  etiqueta = 'servicio externo',
  headers = {},
} = {}) => {
  let ultimoError = null;

  for (let intento = 0; intento <= reintentos; intento++) {
    // AbortController es lo que de verdad corta el socket: sin esto, un
    // `Promise.race` con un setTimeout devolvería el control pero dejaría
    // la petición colgada consumiendo un socket del proceso.
    const control = new AbortController();
    const temporizador = setTimeout(() => control.abort(), timeoutMs);
    try {
      const resp = await fetch(url, {
        signal: control.signal,
        headers: {
          // Algunos servicios públicos (el de catastro de Medellín entre
          // ellos) responden distinto —o directamente rechazan— a una
          // petición sin User-Agent.
          'User-Agent': 'SICABER/1.0 (+api)',
          Accept: 'application/json',
          ...headers,
        },
      });
      clearTimeout(temporizador);

      if (!resp.ok) {
        const err = new ErrorServicioExterno('http', `${etiqueta} respondió ${resp.status}`, { status: resp.status });
        if (reintentable(resp.status) && intento < reintentos) {
          ultimoError = err;
          await dormir(esperaMs * (2 ** intento));
          continue;
        }
        throw err;
      }

      const texto = await resp.text();
      try {
        return JSON.parse(texto);
      } catch {
        // Caso real en producción: un portal cautivo, un proxy corporativo
        // o una página de error del propio servicio devuelven HTML con
        // código 200. `resp.json()` habría lanzado un SyntaxError críptico.
        throw new ErrorServicioExterno('respuesta', `${etiqueta} devolvió una respuesta que no es JSON`);
      }
    } catch (e) {
      clearTimeout(temporizador);
      if (e instanceof ErrorServicioExterno) {
        if (e.tipo === 'respuesta' || !reintentable(e.status)) throw e;
        ultimoError = e;
      } else if (e?.name === 'AbortError' || e?.name === 'TimeoutError') {
        ultimoError = new ErrorServicioExterno('timeout', `${etiqueta} no respondió en ${timeoutMs} ms`);
      } else {
        ultimoError = new ErrorServicioExterno('red', `No se pudo contactar a ${etiqueta}: ${e?.cause?.code || e?.code || e?.message}`);
      }
      if (intento < reintentos) {
        await dormir(esperaMs * (2 ** intento));
        continue;
      }
      throw ultimoError;
    }
  }
  throw ultimoError || new ErrorServicioExterno('red', `Fallo desconocido llamando a ${etiqueta}`);
};

// ── Caché en memoria con vencimiento ─────────────────────────────────────
// Las direcciones se repiten muchísimo (un cliente frecuente pide siempre
// a la misma casa; el checkout verifica la cobertura y después vuelve a
// geocodificar al crear el pedido — la MISMA dirección, dos veces seguidas).
// Sin caché eso son dos llamadas externas por pedido, que en el plan
// gratuito de Geoapify se traduce en 429 y en el catastro en latencia.
//
// Es a propósito un Map en memoria del proceso, no Redis: el volumen es
// pequeño, no necesita sobrevivir a un reinicio y no agrega una dependencia
// de infraestructura nueva al despliegue.
const crearCache = ({ ttlMs = 10 * 60 * 1000, maxEntradas = 500 } = {}) => {
  const datos = new Map();
  return {
    obtener(clave) {
      const entrada = datos.get(clave);
      if (!entrada) return undefined;
      if (Date.now() > entrada.vence) { datos.delete(clave); return undefined; }
      // Reinsertar mueve la clave al final: así el descarte por tamaño
      // elimina la MENOS usada recientemente, no la más vieja a secas.
      datos.delete(clave);
      datos.set(clave, entrada);
      return entrada.valor;
    },
    guardar(clave, valor) {
      if (datos.size >= maxEntradas) {
        const primera = datos.keys().next().value;
        if (primera !== undefined) datos.delete(primera);
      }
      datos.set(clave, { valor, vence: Date.now() + ttlMs });
    },
    limpiar() { datos.clear(); },
    get tamano() { return datos.size; },
  };
};

module.exports = { obtenerJson, ErrorServicioExterno, crearCache };
