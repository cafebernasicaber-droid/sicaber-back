// ─────────────────────────────────────────────────────────────────────────
//  Lectura y validación de comprobantes de pago (Bancolombia, Nequi,
//  Daviplata y cualquier otro formato) — hecha por el BACKEND
// ─────────────────────────────────────────────────────────────────────────
// QUÉ ESTABA MAL ANTES (no es una mejora teórica, era un hueco real):
//
//   El backend no validaba NADA del comprobante. La columna
//   `pedidos.comprobante_ocr` guardaba, literal, lo que el navegador del
//   cliente decía haber leído de la imagen — y el propio comentario de la
//   migración lo reconocía: "es PURAMENTE INFORMATIVO... la decisión de
//   aprobar o rechazar el pago es 100% manual". Dicho de otro modo: quien
//   afirmaba que el comprobante era por $45.000 era el cliente, desde su
//   navegador. Con las herramientas de desarrollo abiertas, cualquiera
//   podía mandar `{ montoDetectado: 45000, coincide: true }` junto a una
//   foto de un gato, y el pedido entraba a la cola de verificación igual
//   que uno legítimo.
//
//   Además el lector del frontend estaba hecho para UN solo diseño de
//   comprobante: cambiaba la app del banco, o llegaba uno de otra entidad,
//   y dejaba de leer.
//
// QUÉ HACE ESTE MÓDULO:
//   • Extrae del TEXTO del comprobante los tres datos que importan —
//     VALOR pagado, ENTIDAD y REFERENCIA — sin depender del diseño: no
//     busca posiciones ni colores, busca patrones de dinero y etiquetas
//     ("valor", "total", "enviaste", "monto") que existen en todos los
//     comprobantes colombianos, y cae a heurísticas generales cuando la
//     entidad no se reconoce.
//   • Compara el valor contra el total REAL del pedido calculado por el
//     servidor, y emite un veredicto.
//   • Cuando no puede determinar el valor con seguridad, lo dice
//     (ilegible/incompleto) y NUNCA da por bueno el comprobante: lo manda
//     a revisión manual, que es el comportamiento seguro.
//
// DE DÓNDE SALE EL TEXTO (ver obtenerTexto más abajo):
//   1. OCR propio del servidor, si está habilitado (OCR_BACKEND=tesseract).
//      Es el modo más fuerte: el cliente no participa en absoluto.
//   2. El texto crudo que manda el frontend (`comprobante_texto` o el
//      texto dentro de `comprobante_ocr`). El backend lo VUELVE A ANALIZAR
//      por su cuenta — nunca acepta el veredicto del cliente, solo usa su
//      texto como materia prima.
//   3. Sin texto → 'ilegible' → revisión manual. Jamás aprobación automática.

// ── Normalización de texto ───────────────────────────────────────────────
// Se conservan los saltos de línea a propósito: casi todos los
// comprobantes ponen la etiqueta y su valor en la MISMA línea ("Valor
// $45.000"), y esa cercanía es la señal más fiable para saber cuál de
// todos los números de la imagen es el monto pagado.
const normalizar = (texto) => String(texto || '')
  .normalize('NFD')
  .replace(/[̀-ͯ]/g, '')
  .toLowerCase()
  .replace(/[ \t ]+/g, ' ')
  .replace(/\r/g, '');

// ── Entidades reconocidas ────────────────────────────────────────────────
// La lista NO es un requisito para validar: si ninguna coincide, la
// entidad queda como 'otra' y el resto del análisis funciona igual. Sirve
// para el registro, para la detección de comprobantes repetidos y para dar
// mensajes más claros.
const ENTIDADES = [
  { clave: 'nequi',        patrones: ['nequi'] },
  { clave: 'bancolombia',  patrones: ['bancolombia', 'sucursal virtual', 'llave bancolombia', 'grupo bancolombia'] },
  { clave: 'daviplata',    patrones: ['daviplata', 'davivienda'] },
  { clave: 'transfiya',    patrones: ['transfiya'] },
  { clave: 'movii',        patrones: ['movii'] },
  { clave: 'bbva',         patrones: ['bbva'] },
  { clave: 'banco_bogota', patrones: ['banco de bogota'] },
  { clave: 'pse',          patrones: ['pse', 'achcolombia'] },
];

const detectarEntidad = (texto) => {
  for (const entidad of ENTIDADES) {
    if (entidad.patrones.some((p) => texto.includes(p))) return entidad.clave;
  }
  return 'otra';
};

// ── Dinero ───────────────────────────────────────────────────────────────
// Convierte "45.000", "$ 45.000,00", "COP 45,000.00" o "45000" al número
// de pesos que representan.
//
// La regla clave para Colombia: un único separador seguido de EXACTAMENTE
// tres dígitos son miles ("45.000" = 45000), no decimales. Interpretarlo
// al revés convertiría un pago de $45.000 en uno de $45 — justo la clase
// de error que haría rechazar comprobantes buenos.
const parsearMonto = (crudo) => {
  let s = String(crudo).replace(/[^\d.,]/g, '');
  if (!s) return null;
  const tienePunto = s.includes('.');
  const tieneComa = s.includes(',');

  if (tienePunto && tieneComa) {
    // Conviven los dos: el que aparece de ÚLTIMO es el decimal. Cubre
    // "45.000,00" (Colombia) y "45,000.00" (formato anglosajón, que
    // aparece cuando el teléfono está configurado en inglés).
    const decimal = s.lastIndexOf('.') > s.lastIndexOf(',') ? '.' : ',';
    const miles = decimal === '.' ? ',' : '.';
    s = s.split(miles).join('').replace(decimal, '.');
  } else if (tienePunto || tieneComa) {
    const sep = tienePunto ? '.' : ',';
    const partes = s.split(sep);
    if (partes.length > 2) {
      s = partes.join(''); // "12.345.678" → separadores de miles
    } else if (partes[1].length === 3) {
      s = partes.join(''); // "45.000" → 45000 (convención colombiana)
    } else {
      s = `${partes[0]}.${partes[1]}`; // "45,50" → 45.5
    }
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

// Cualquier cosa con pinta de cifra monetaria. El símbolo/moneda y los
// separadores se capturan aparte porque son señales de confianza: un
// número con "$" delante es muchísimo más probable que sea el monto que
// una tira de dígitos suelta (que suele ser una referencia o un teléfono).
const RE_DINERO = /(\$|cop|col\$|usd)?\s*(\d{1,3}(?:[.,]\d{3})+(?:[.,]\d{1,2})?|\d{1,9}(?:[.,]\d{1,2})?)/gi;

// Etiquetas que, en la misma línea, identifican al monto pagado. Cubren
// las tres entidades principales y los formatos genéricos:
//   Bancolombia → "Valor", "Valor total", "Total"
//   Nequi       → "Enviaste", "Le enviaste", "Monto"
//   Daviplata   → "Valor enviado", "Pagaste"
const ETIQUETAS_VALOR = [
  'valor total', 'valor enviado', 'valor transferido', 'valor a pagar', 'valor pagado',
  'total pagado', 'total transferido', 'monto total', 'importe total',
  'valor', 'monto', 'importe', 'total',
  'enviaste', 'le enviaste', 'enviado', 'pagaste', 'transferiste', 'recibiste',
];

// Líneas cuyo número NUNCA es el monto: son referencias, cuentas,
// teléfonos o documentos. Sin este filtro, "Cuenta 45000123" podía
// interpretarse como un pago de $45.000.123.
const ETIQUETAS_NO_VALOR = [
  'referencia', 'aprobacion', 'autorizacion', 'comprobante no', 'comprobante n',
  'numero de comprobante', 'transaccion', 'cus', 'celular', 'telefono', 'movil',
  'cuenta', 'producto origen', 'producto destino', 'documento', 'cedula', 'nit',
  'fecha', 'hora', 'codigo', 'id ',
];

// Rango plausible para un pedido de cafetería. Un "monto" de $12 o de
// $900.000.000 no es el total de un café: casi siempre es un número de
// otra cosa que se coló. Se usa solo para descartar candidatos, nunca para
// rechazar un comprobante.
const MONTO_MINIMO = 500;
const MONTO_MAXIMO = 50000000;

const contieneAlguna = (linea, lista) => lista.find((e) => linea.includes(e)) || null;

// Recorre línea por línea y arma la lista de candidatos a "monto pagado",
// cada uno con las señales que permiten ordenarlos por confianza.
const extraerCandidatos = (texto) => {
  const candidatos = [];
  const lineas = texto.split('\n');

  lineas.forEach((lineaCruda, numeroLinea) => {
    const linea = lineaCruda.trim();
    if (!linea) return;
    const etiquetaNoValor = contieneAlguna(linea, ETIQUETAS_NO_VALOR);
    const etiquetaValor = contieneAlguna(linea, ETIQUETAS_VALOR);

    for (const match of linea.matchAll(RE_DINERO)) {
      const moneda = match[1] || '';
      const numero = match[2];
      const valor = parsearMonto(numero);
      if (valor == null) continue;

      const conSimbolo = /\$|cop|col\$/i.test(moneda);
      const conSeparador = /[.,]/.test(numero);

      // Descartes duros.
      if (valor < MONTO_MINIMO || valor > MONTO_MAXIMO) continue;
      // Un número en una línea de "referencia"/"cuenta" solo se considera
      // si viene con símbolo de moneda explícito (hay comprobantes que
      // ponen "Cuenta ... $45.000" en el mismo renglón).
      if (etiquetaNoValor && !conSimbolo) continue;
      // Un número pelado, sin símbolo ni separadores ni etiqueta de valor,
      // no es evidencia de nada (es la tira de dígitos de una referencia).
      if (!conSimbolo && !conSeparador && !etiquetaValor) continue;

      // Puntuación: cuanto más explícita la señal, más confianza.
      let puntos = 0;
      if (etiquetaValor) puntos += etiquetaValor.startsWith('valor') || etiquetaValor.includes('total') ? 6 : 5;
      if (conSimbolo) puntos += 4;
      if (conSeparador) puntos += 2;
      if (etiquetaNoValor) puntos -= 3;
      // Los comprobantes suelen mostrar el monto arriba del todo.
      if (numeroLinea < 6) puntos += 1;

      candidatos.push({ valor, puntos, etiqueta: etiquetaValor, conSimbolo, conSeparador, linea, numeroLinea });
    }
  });

  candidatos.sort((a, b) => b.puntos - a.puntos || b.valor - a.valor);
  return candidatos;
};

// ── Referencia / número de aprobación ────────────────────────────────────
// Segunda barrera (además del hash de la imagen) contra reutilizar un
// comprobante: recortar o volver a comprimir el pantallazo cambia el hash,
// pero no cambia el número de aprobación del banco.
const RE_REFERENCIA = [
  /(?:numero de aprobacion|n[°ºo.]*\s*de aprobacion|aprobacion)\s*[:#]?\s*([a-z0-9-]{4,30})/i,
  /(?:numero de comprobante|comprobante)\s*(?:n[°ºo.]*)?\s*[:#]?\s*([a-z0-9-]{4,30})/i,
  /(?:numero de referencia|referencia)\s*[:#]?\s*([a-z0-9-]{4,30})/i,
  /(?:id de la transaccion|id transaccion|transaccion)\s*[:#]?\s*([a-z0-9-]{4,30})/i,
  /(?:cus)\s*[:#]?\s*([a-z0-9-]{4,30})/i,
  /(?:autorizacion)\s*[:#]?\s*([a-z0-9-]{4,30})/i,
];

const extraerReferencia = (texto) => {
  for (const re of RE_REFERENCIA) {
    const m = texto.match(re);
    // Se exige al menos un dígito: un "Referencia: pendiente" no es una
    // referencia, y usarla para detectar duplicados haría chocar entre sí
    // a comprobantes que no tienen nada que ver.
    if (m && m[1] && /\d/.test(m[1])) return m[1].toUpperCase().slice(0, 80);
  }
  return null;
};

// ── Fecha ────────────────────────────────────────────────────────────────
const MESES = {
  ene: 1, feb: 2, mar: 3, abr: 4, may: 5, jun: 6,
  jul: 7, ago: 8, sep: 9, oct: 10, nov: 11, dic: 12,
};
const extraerFecha = (texto) => {
  // "17/09/2026", "17-09-2026", "2026-09-17"
  const iso = texto.match(/\b(20\d{2})[-/](\d{1,2})[-/](\d{1,2})\b/);
  if (iso) return `${iso[1]}-${String(iso[2]).padStart(2, '0')}-${String(iso[3]).padStart(2, '0')}`;
  const dmy = texto.match(/\b(\d{1,2})[-/](\d{1,2})[-/](20\d{2})\b/);
  if (dmy) return `${dmy[3]}-${String(dmy[2]).padStart(2, '0')}-${String(dmy[1]).padStart(2, '0')}`;
  // "17 de septiembre de 2026" / "17 sep 2026"
  const texto_es = texto.match(/\b(\d{1,2})\s*(?:de\s*)?(ene|feb|mar|abr|may|jun|jul|ago|sep|oct|nov|dic)[a-z]*\s*(?:de\s*)?(20\d{2})\b/);
  if (texto_es) {
    const mes = MESES[texto_es[2]];
    return `${texto_es[3]}-${String(mes).padStart(2, '0')}-${String(texto_es[1]).padStart(2, '0')}`;
  }
  return null;
};

// Señales de que el texto SÍ viene de un comprobante de pago y no de una
// foto cualquiera. No se usa para rechazar (un comprobante raro podría no
// traer ninguna), sino para bajar la confianza y pedir revisión humana.
const SENALES_COMPROBANTE = [
  'transferencia', 'transferiste', 'enviaste', 'pago', 'pagaste', 'comprobante',
  'exitosa', 'exitoso', 'aprobada', 'aprobado', 'recibo', 'valor', 'monto', 'total',
];

/**
 * Analiza el TEXTO de un comprobante y extrae los datos verificables.
 * No decide nada sobre el pedido — eso lo hace validarComprobante.
 */
const analizarTexto = (textoCrudo) => {
  const texto = normalizar(textoCrudo);
  if (!texto.trim()) {
    return { legible: false, motivo: 'sin_texto', entidad: null, valor: null, referencia: null, fecha: null, confianza: 0, candidatos: [] };
  }

  const entidad = detectarEntidad(texto);
  const candidatos = extraerCandidatos(texto);
  const referencia = extraerReferencia(texto);
  const fecha = extraerFecha(texto);
  const senales = SENALES_COMPROBANTE.filter((s) => texto.includes(s));

  if (candidatos.length === 0) {
    // Hay texto, pero ninguna cifra reconocible como monto: comprobante
    // ilegible, recortado o que no es un comprobante.
    return {
      legible: false, motivo: 'valor_no_encontrado',
      entidad, valor: null, referencia, fecha,
      confianza: 0, candidatos: [], senales: senales.length,
    };
  }

  const mejor = candidatos[0];
  // Empate real entre dos montos DISTINTOS con la misma puntuación: no se
  // elige al azar. Se marca como ambiguo y va a revisión manual.
  const empatados = candidatos.filter((c) => c.puntos === mejor.puntos && c.valor !== mejor.valor);
  const ambiguo = empatados.length > 0;

  // Confianza 0..1, combinando la calidad de la señal del monto con el
  // contexto general del documento.
  let confianza = Math.min(1, mejor.puntos / 12);
  if (senales.length >= 2) confianza = Math.min(1, confianza + 0.15);
  if (entidad !== 'otra') confianza = Math.min(1, confianza + 0.1);
  if (ambiguo) confianza = Math.min(confianza, 0.45);

  return {
    legible: !ambiguo,
    motivo: ambiguo ? 'valor_ambiguo' : null,
    entidad,
    valor: mejor.valor,
    etiquetaValor: mejor.etiqueta,
    referencia,
    fecha,
    confianza: Math.round(confianza * 100) / 100,
    senales: senales.length,
    // Se guardan los candidatos (pocos y pequeños) para que un cajero
    // pueda entender POR QUÉ el sistema leyó un valor y no otro.
    candidatos: candidatos.slice(0, 5).map((c) => ({ valor: c.valor, etiqueta: c.etiqueta, puntos: c.puntos })),
  };
};

// ── De dónde sale el texto ───────────────────────────────────────────────
// Rebusca el texto crudo dentro de lo que haya mandado el frontend, sin
// aceptar NINGUNA conclusión suya (montoDetectado, coincide, valido...):
// solo se toma el texto, y el veredicto lo saca este módulo.
const CAMPOS_TEXTO = ['texto', 'text', 'raw', 'rawText', 'textoCompleto', 'contenido', 'ocrText', 'fullText'];

const textoDelCliente = (ocrCliente) => {
  if (!ocrCliente) return null;
  if (typeof ocrCliente === 'string') return ocrCliente;
  if (typeof ocrCliente !== 'object') return null;
  for (const campo of CAMPOS_TEXTO) {
    const v = ocrCliente[campo];
    if (typeof v === 'string' && v.trim()) return v;
  }
  // Algunos lectores devuelven las líneas sueltas en un arreglo.
  for (const campo of ['lineas', 'lines', 'words', 'palabras']) {
    const v = ocrCliente[campo];
    if (Array.isArray(v) && v.length) {
      const partes = v.map((x) => (typeof x === 'string' ? x : (x?.text || x?.texto || ''))).filter(Boolean);
      if (partes.length) return partes.join('\n');
    }
  }
  return null;
};

// OCR EN EL SERVIDOR — opcional y perezoso.
//
// Está apagado por defecto (OCR_BACKEND debe valer 'tesseract' para
// encenderlo) y la dependencia se carga solo cuando se usa, por dos
// razones concretas de despliegue: tesseract.js pesa ~50 MB instalado y
// descarga sus datos de idioma de una CDN la primera vez que corre. En un
// plan gratuito con poca memoria y salida de red restringida, encenderlo
// sin querer reintroduciría exactamente el problema que vinimos a
// arreglar (procesos colgados). Cuando SÍ está encendido, el texto del
// cliente se ignora por completo y la lectura es 100% del servidor.
const OCR_BACKEND = String(process.env.OCR_BACKEND || '').toLowerCase();
const OCR_TIMEOUT_MS = Number(process.env.OCR_TIMEOUT_MS || 20000);
const ocrDisponible = () => OCR_BACKEND === 'tesseract';

const ocrEnServidor = async (imagenBase64) => {
  if (!ocrDisponible() || !imagenBase64) return null;
  let Tesseract;
  try {
    // eslint-disable-next-line global-require
    Tesseract = require('tesseract.js');
  } catch {
    console.warn('🔍 OCR_BACKEND=tesseract pero tesseract.js no está instalado — se usará el texto del cliente.');
    return null;
  }
  // Mismo criterio que el correo y la geocodificación: techo de tiempo
  // duro, para que un OCR lento no deje la petición colgada.
  const conTimeout = new Promise((_, rechazar) =>
    setTimeout(() => rechazar(new Error('OCR superó el tiempo máximo')), OCR_TIMEOUT_MS));
  try {
    const resultado = await Promise.race([
      Tesseract.recognize(imagenBase64, 'spa+eng'),
      conTimeout,
    ]);
    return resultado?.data?.text || null;
  } catch (e) {
    console.error('🔍 OCR del servidor falló:', e.message);
    return null;
  }
};

const obtenerTexto = async ({ imagenBase64, ocrCliente, textoPlano }) => {
  const propio = await ocrEnServidor(imagenBase64);
  if (propio && propio.trim()) return { texto: propio, fuente: 'ocr_servidor' };
  const delCliente = textoPlano || textoDelCliente(ocrCliente);
  if (delCliente && String(delCliente).trim()) return { texto: String(delCliente), fuente: 'texto_cliente' };
  return { texto: null, fuente: null };
};

// ── Veredicto ────────────────────────────────────────────────────────────
// Estados posibles (clave estable, el frontend puede mapearla a su UI):
//   'valido'            → el valor leído coincide con el total del pedido
//   'valor_no_coincide' → se leyó el valor y NO coincide → rechazo
//   'ilegible'          → no se pudo leer el valor → revisión manual
//   'sin_comprobante'   → no llegó imagen ni texto
const TOLERANCIA_PESOS = Number(process.env.COMPROBANTE_TOLERANCIA_PESOS || 0);
// Por debajo de esta confianza no se afirma nada automáticamente, aunque
// el número haya coincidido: se deja en revisión manual.
const CONFIANZA_MINIMA = Number(process.env.COMPROBANTE_CONFIANZA_MINIMA || 0.5);

const pesos = (n) => Math.round(Number(n) || 0);

/**
 * Valida un comprobante contra el total REAL del pedido.
 *
 * @param {object} p
 *   imagenBase64 → la imagen tal como llega (para el OCR del servidor y el hash)
 *   ocrCliente   → lo que mandó el frontend (solo se le saca el TEXTO)
 *   textoPlano   → texto del comprobante, si el cliente lo manda aparte
 *   total        → total del pedido calculado por el SERVIDOR (no el del body)
 * @returns {Promise<object>} veredicto completo, listo para guardar en
 *          pedidos.comprobante_validacion
 */
const validarComprobante = async ({ imagenBase64, ocrCliente, textoPlano, total }) => {
  const totalEsperado = pesos(total);

  if (!imagenBase64 && !textoPlano && !ocrCliente) {
    return {
      ok: false, estado: 'sin_comprobante', requiereRevisionManual: true,
      mensaje: 'No se recibió ningún comprobante de pago.',
      totalEsperado, valor: null, entidad: null, referencia: null, fecha: null,
      confianza: 0, fuenteTexto: null, analizadoEn: new Date().toISOString(),
    };
  }

  const { texto, fuente } = await obtenerTexto({ imagenBase64, ocrCliente, textoPlano });

  if (!texto) {
    // Hay imagen pero nadie pudo convertirla en texto. NO se aprueba: se
    // manda a revisión humana, que es lo seguro. Antes, este caso entraba
    // exactamente igual que uno validado.
    return {
      ok: false, estado: 'ilegible', motivo: 'sin_texto', requiereRevisionManual: true,
      mensaje: 'No pudimos leer el comprobante automáticamente. Un cajero lo revisará antes de confirmar tu pago.',
      totalEsperado, valor: null, entidad: null, referencia: null, fecha: null,
      confianza: 0, fuenteTexto: null, analizadoEn: new Date().toISOString(),
    };
  }

  const analisis = analizarTexto(texto);
  const base = {
    totalEsperado,
    entidad: analisis.entidad,
    valor: analisis.valor,
    referencia: analisis.referencia,
    fecha: analisis.fecha,
    confianza: analisis.confianza,
    fuenteTexto: fuente,
    candidatos: analisis.candidatos,
    analizadoEn: new Date().toISOString(),
  };

  if (analisis.valor == null) {
    return {
      ...base, ok: false, estado: 'ilegible', motivo: analisis.motivo || 'valor_no_encontrado',
      requiereRevisionManual: true,
      mensaje: 'No pudimos identificar el valor pagado en el comprobante. Asegúrate de que se vea completo y sin recortar; un cajero lo revisará.',
    };
  }

  const diferencia = pesos(analisis.valor) - totalEsperado;

  // El valor NO coincide: rechazo, y no depende de la confianza. Si se leyó
  // un número claro y es otro, el comprobante no es de esta compra.
  if (Math.abs(diferencia) > TOLERANCIA_PESOS) {
    return {
      ...base, ok: false, estado: 'valor_no_coincide', motivo: 'valor_distinto',
      diferencia,
      requiereRevisionManual: false,
      mensaje: `El comprobante es por $${pesos(analisis.valor).toLocaleString('es-CO')} y el total de tu pedido es $${totalEsperado.toLocaleString('es-CO')}. Sube el comprobante del pago correcto.`,
    };
  }

  // Coincide, pero la lectura fue dudosa (texto ambiguo, poca señal):
  // tampoco se aprueba solo. El número correcto puede aparecer por
  // casualidad en una imagen que no es el comprobante de este pedido.
  if (analisis.confianza < CONFIANZA_MINIMA || !analisis.legible) {
    return {
      ...base, ok: false, estado: 'ilegible', motivo: analisis.motivo || 'confianza_baja',
      diferencia,
      requiereRevisionManual: true,
      mensaje: 'El comprobante coincide con el valor del pedido, pero la lectura no fue clara. Un cajero lo revisará antes de confirmar tu pago.',
    };
  }

  return {
    ...base, ok: true, estado: 'valido', motivo: null, diferencia: 0,
    requiereRevisionManual: false,
    mensaje: `Comprobante verificado por $${totalEsperado.toLocaleString('es-CO')}.`,
  };
};

module.exports = {
  validarComprobante,
  analizarTexto,
  parsearMonto,
  detectarEntidad,
  extraerReferencia,
  extraerFecha,
  extraerCandidatos,
  normalizar,
  ocrDisponible,
  CONFIANZA_MINIMA,
};
