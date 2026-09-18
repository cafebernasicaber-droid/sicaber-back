// ─────────────────────────────────────────────────────────────────────────
//  Geocodificación de direcciones + cobertura de domicilios (comuna 8 y 9)
// ─────────────────────────────────────────────────────────────────────────
// Tres bugs reales de PRODUCCIÓN que corrige este archivo (todos invisibles
// en local, que es justamente por lo que se colaron):
//
//   1. CUELGUE INFINITO. Las llamadas salían con el `fetch` global pelado,
//      que no tiene timeout. Cuando el catastro de Medellín o Geoapify
//      aceptan la conexión y no contestan (lo normal desde un datacenter
//      fuera de Colombia), la promesa nunca se resolvía y el checkout
//      quedaba "cargando" para siempre. Ahora TODA llamada externa pasa
//      por services/httpExterno.js, con techo de tiempo y reintentos.
//
//   2. RESPUESTA QUE NO CORRESPONDE A LA DIRECCIÓN CONSULTADA. La consulta
//      a Geoapify usaba `bias=proximity` + `limit=1`. "bias" es solo una
//      PREFERENCIA, no un filtro: si la dirección no se reconoce, Geoapify
//      igual devuelve algo — el centroide de la ciudad, un municipio
//      cualquiera de Colombia, una vía con número parecido en otra comuna —
//      y con `limit=1` ese "algo" se tomaba como si fuera la dirección
//      pedida, con su comuna y todo. Ahora se filtra por un rectángulo real
//      de Medellín, se piden varios candidatos y CADA UNO se verifica
//      contra lo que se pidió (vía, placa, ciudad, tipo de resultado y
//      confianza); si ninguno corresponde de verdad, se devuelve "no
//      encontrada" en vez de un resultado inventado.
//
//   3. COMUNA NO DETECTADA. La comuna solo se leía de `suburb`/`district`
//      esperando el texto "Comuna 8". En producción, OpenStreetMap suele
//      devolver ahí el nombre del BARRIO ("Enciso", "Loreto"), así que
//      extraerNumeroComuna daba null y toda dirección terminaba como
//      'no_geocodificada' → el cliente tenía que elegir el local a mano en
//      cada pedido. Ahora se revisan más campos y, como último recurso, se
//      traduce el barrio a su comuna (lista oficial, ver más abajo).
const { obtenerJson, ErrorServicioExterno, crearCache } = require('./httpExterno');
const { geocodificarGeoMedellin } = require('./geomedellin');

const GEOAPIFY_URL = 'https://api.geoapify.com/v1/geocode/search';

// Comuna 8 -> Local Villa Liliam | Comuna 9 -> Local 3 Esquinas
// (nombres reales de la tabla "locales" — "Local 1"/"Local 2" son códigos
// OBSOLETOS que el propio sistema está retirando, ver LOCALES_OBSOLETOS en
// routes/index.js y la migración de locales en config/db.js).
const COBERTURA_POR_COMUNA = {
  8: 'Local Villa Liliam',
  9: 'Local 3 Esquinas',
};

// Coordenadas reales de los dos locales (ver CAMBIOS.md) — se usan solo
// para la nota informativa de "el otro local te queda más cerca", NUNCA
// para decidir la sede real del pedido (esa decisión siempre es por
// comuna, la regla acordada con la instructora).
const COORDENADAS_LOCAL = {
  'Local 3 Esquinas':  { lat: 6.2280265, lon: -75.5434224 },   // Cra 10A #52-44
  'Local Villa Liliam': { lat: 6.2476027, lon: -75.5514397 },  // Calle 57B #7-71
};

// Rectángulo que cubre el perímetro urbano de Medellín. Se usa como FILTRO
// DURO en Geoapify (no como sugerencia): sin él, "Calle 57B #7-71" a secas
// puede resolverse en Bogotá, Cali o cualquier municipio con esa
// nomenclatura, y ese resultado se tomaba como bueno.
const CAJA_MEDELLIN = { latMin: 6.13, latMax: 6.40, lonMin: -75.72, lonMax: -75.45 };
// Caja más estrecha, solo comunas 8 y 9 (con margen). Se usa para validar
// el respaldo por nombre de barrio: un barrio solo cuenta si además el
// punto cae de verdad en esta zona.
const CAJA_COMUNA_8_9 = { latMin: 6.21, latMax: 6.27, lonMin: -75.565, lonMax: -75.525 };

const dentroDe = (caja, lat, lon) =>
  lat != null && lon != null &&
  Number(lat) >= caja.latMin && Number(lat) <= caja.latMax &&
  Number(lon) >= caja.lonMin && Number(lon) <= caja.lonMax;

// Distancia aproximada en línea recta (km) entre dos puntos — suficiente
// para comparar "cuál local queda más cerca", no para navegación real.
const distanciaKm = (lat1, lon1, lat2, lon2) => {
  const dLat = (lat2 - lat1) * 111;
  const dLon = (lon2 - lon1) * 111 * Math.cos(((lat1 + lat2) / 2) * Math.PI / 180);
  return Math.sqrt(dLat * dLat + dLon * dLon);
};

// Si tenemos coordenadas de la dirección del cliente, calcula cuál de los
// dos locales queda más cerca en línea recta. Devuelve null si no hay
// coordenadas disponibles (ej. viene de un punto de referencia conocido
// sin lat/lon, o no se pudo geocodificar).
const localMasCercanoPorDistancia = (lat, lon) => {
  if (lat == null || lon == null) return null;
  const distancias = Object.entries(COORDENADAS_LOCAL).map(([sede, c]) => ({
    sede, km: distanciaKm(Number(lat), Number(lon), c.lat, c.lon),
  }));
  distancias.sort((a, b) => a.km - b.km);
  return distancias[0]; // { sede, km } del más cercano
};

// Puntos de referencia conocidos (estaciones de Tranvía/Metrocable cerca de
// Comuna 8 y 9) que Geoapify/OpenStreetMap no siempre ubica bien o no
// reconoce. Comuna confirmada a mano contra fuentes oficiales (Alcaldía de
// Medellín / Metro de Medellín) — ver CAMBIOS.md.
const PUNTOS_REFERENCIA_CONOCIDOS = [
  { comuna: 9, variantes: ['alejandro echavarria', 'alejandro echeverria', 'alejandro echavarría', 'alejandro echeverría'] },
  { comuna: 9, variantes: ['estacion oriente', 'estación oriente'] },
  { comuna: 8, variantes: ['las torres'] },
  { comuna: 8, variantes: ['villa sierra'] },
];

// Barrios oficiales de las dos comunas con cobertura (Fichas de
// Caracterización de la Alcaldía de Medellín). Es el ÚLTIMO recurso para
// deducir la comuna cuando el geocodificador devuelve el nombre del barrio
// en vez del número de comuna — que en producción es el caso más frecuente,
// porque OpenStreetMap etiqueta los "suburb" de Medellín con el nombre del
// barrio, no con "Comuna N".
//
// ⚠️ Solo se aplica cuando el punto geocodificado cae DENTRO de
// CAJA_COMUNA_8_9. Sin ese candado, un barrio homónimo de otra parte de la
// ciudad (ej. "San Antonio", que también es una estación del metro en La
// Candelaria) podría dar cobertura a una dirección que no la tiene.
const BARRIOS_POR_COMUNA = {
  8: [
    'villa hermosa', 'la mansion', 'san miguel', 'la ladera', 'batallon girardot',
    'llanaditas', 'los mangos', 'enciso', 'sucre', 'el pinal', 'trece de noviembre',
    '13 de noviembre', 'la libertad', 'villatina', 'san antonio', 'las estancias',
    'villa turbay', 'la sierra', 'santa lucia', 'villa lilliam', 'villa liliam',
  ],
  9: [
    'juan pablo ii', 'barrios de jesus', 'bombona no 2', 'bombona n 2', 'bombona 2',
    'los cerros el vergel', 'el vergel', 'alejandro echavarria', 'barrio caicedo',
    'caicedo', 'buenos aires', 'miraflores', 'cataluna', 'la milagrosa', 'gerona',
    'el salvador', 'loreto', 'asomadera', 'ocho de marzo', '8 de marzo',
  ],
};

const normalizarTexto = (texto) =>
  String(texto || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');

const comunaPorPuntoReferencia = (direccionTexto) => {
  const normalizado = normalizarTexto(direccionTexto);
  if (!normalizado) return null;
  for (const punto of PUNTOS_REFERENCIA_CONOCIDOS) {
    if (punto.variantes.some((variante) => normalizado.includes(normalizarTexto(variante)))) {
      return punto.comuna;
    }
  }
  return null;
};

// Busca el nombre de barrio en los campos ESPECÍFICOS del resultado
// (suburb, district, neighbourhood, quarter) — nunca en la dirección
// completa, donde "san antonio" podría venir del nombre de un negocio o de
// otra parte del texto y significar cualquier cosa.
const comunaPorNombreBarrio = (camposBarrio) => {
  const textos = camposBarrio.filter(Boolean).map(normalizarTexto);
  if (textos.length === 0) return null;
  for (const [comuna, barrios] of Object.entries(BARRIOS_POR_COMUNA)) {
    for (const barrio of barrios) {
      if (textos.some((t) => t === barrio || t.includes(barrio))) return Number(comuna);
    }
  }
  return null;
};

function extraerNumeroComuna(texto) {
  if (!texto) return null;
  const t = String(texto).trim();

  if (/^\d+$/.test(t)) return Number(t);
  const match = t.match(/comuna\s*(?:n[°º.]?\s*)?(\d+)/i);
  return match ? Number(match[1]) : null;
}

// ── Preparación del texto que se le manda a Geoapify ─────────────────────
// Geoapify entiende mucho mejor la nomenclatura colombiana escrita
// completa. La gente escribe "Cra 10A #52-44" o "cl57b#7-71"; esto lo
// expande a "Carrera 10A 52-44" y agrega ciudad/departamento/país, que es
// lo que faltaba para que el resultado fuera el correcto y no un homónimo
// en otra ciudad.
// Un ÚNICO patrón con alternación, aplicado en una sola pasada. Hacerlo con
// varios .replace() encadenados producía un error real: "Cra 10A" quedaba
// en "Carrera 10A" tras la primera regla y la siguiente (\bcarr\b) volvía a
// morder el "Carr" de esa palabra ya traducida, dejando "Carrera era 10A".
// Con una sola pasada el texto reemplazado nunca se vuelve a examinar.
//
// El `(?=\d)` final es igual de importante: exige que después de la
// abreviatura venga un número. Así "Cl" solo se expande en "Cl 57" (una
// vía) y nunca dentro de un nombre propio o del nombre de un negocio.
// Sin `\b` de cierre a propósito: "Cr13#55-189" (todo pegado, como lo
// escribe medio mundo desde el celular — el mismo caso que ya contempla
// parsearDireccionColombiana en geomedellin.js) no tiene frontera de
// palabra entre la "r" y el "1". El lookahead `(?=\d)` cumple ese papel sin
// exigir el espacio.
const RE_VIA_ABREVIADA = /\b(carreras|carrera|carr|cra|cr|kra|kr|calles|calle|cll|cl|diagonal|diag|dg|transversal|transv|tv|circulares|circular|circ|cq)\.?\s*(?=\d)/gi;
const MAPA_VIA = {
  carreras: 'Carrera', carrera: 'Carrera', carr: 'Carrera', cra: 'Carrera', cr: 'Carrera', kra: 'Carrera', kr: 'Carrera',
  calles: 'Calle', calle: 'Calle', cll: 'Calle', cl: 'Calle',
  diagonal: 'Diagonal', diag: 'Diagonal', dg: 'Diagonal',
  transversal: 'Transversal', transv: 'Transversal', tv: 'Transversal',
  circulares: 'Circular', circular: 'Circular', circ: 'Circular', cq: 'Circular',
};

const prepararTextoParaGeoapify = (direccionTexto) => {
  let texto = String(direccionTexto || '').trim();
  texto = texto.replace(RE_VIA_ABREVIADA, (_, abrev) => `${MAPA_VIA[String(abrev).toLowerCase()]} `);
  // "#" y "No." no aportan nada al buscador y a veces lo confunden.
  texto = texto.replace(/\s*#\s*/g, ' ').replace(/\bn[o°º]\.?\s*/gi, ' ').replace(/\s+/g, ' ').trim();
  const normalizado = normalizarTexto(texto);
  if (!normalizado.includes('medellin')) texto += ', Medellín';
  if (!normalizado.includes('antioquia')) texto += ', Antioquia';
  if (!normalizado.includes('colombia')) texto += ', Colombia';
  return texto;
};

// Extrae de lo que ESCRIBIÓ el usuario los datos verificables: tipo de vía,
// número de vía y placa. Sirve para comprobar que el resultado devuelto
// corresponde de verdad a esa dirección y no a otra cosa.
const RE_NOMENCLATURA = /\b(calle|cl|carrera|cra|cr|kr|diagonal|dg|transversal|tv|circular|cq)\.?\s*(\d+)\s*([a-z]?)\b/i;
const RE_PLACA = /#\s*(\d+)\s*[a-z]?\s*-\s*(\d+)/i;

const partesDeLaDireccion = (direccionTexto) => {
  const texto = normalizarTexto(direccionTexto);
  const via = texto.match(RE_NOMENCLATURA);
  const placa = texto.match(RE_PLACA);
  return {
    tieneNomenclatura: !!via,
    numeroVia: via ? via[2] : null,
    apendiceVia: via ? (via[3] || '') : '',
    numeroCruce: placa ? placa[1] : null,
    placa: placa ? placa[2] : null,
  };
};

// Tipos de resultado que NO son una dirección: si el usuario escribió una
// dirección con nomenclatura y Geoapify contesta con esto, es su forma de
// decir "no la encontré, te doy lo más parecido" — y tomarlo como buena
// era exactamente el bug 2 de la cabecera.
const TIPOS_DEMASIADO_GENERICOS = new Set(['country', 'state', 'county', 'city', 'postcode', 'region']);

// Puntúa qué tan bien un resultado de Geoapify corresponde a lo pedido.
// Devuelve null si directamente NO corresponde (y entonces se descarta).
const puntuarCandidato = (props, partes) => {
  const lat = props.lat, lon = props.lon;
  // Fuera de Medellín: descartado sin más. Es un candado redundante con el
  // filtro `rect` de la consulta, a propósito — el filtro depende de que
  // Geoapify lo respete, esto no depende de nadie.
  if (!dentroDe(CAJA_MEDELLIN, lat, lon)) return null;

  const ciudad = normalizarTexto(props.city || props.county || '');
  if (ciudad && !ciudad.includes('medellin')) return null;

  const tipo = String(props.result_type || '').toLowerCase();
  if (partes.tieneNomenclatura && TIPOS_DEMASIADO_GENERICOS.has(tipo)) return null;

  let puntos = 0;
  // La confianza que reporta el propio Geoapify (0..1) pesa, pero no
  // decide sola: se combina con las coincidencias verificables de abajo.
  puntos += Number(props.rank?.confidence || 0) * 10;
  if (tipo === 'building' || tipo === 'amenity') puntos += 4;
  if (tipo === 'street') puntos += 2;

  // Coincidencia real de la vía: "Carrera 10A" pedida vs "Carrera 10A"
  // devuelta. Es la comprobación que de verdad ata el resultado al texto.
  const calle = normalizarTexto(props.street || props.address_line1 || '');
  if (partes.numeroVia) {
    const patronVia = new RegExp(`\\b${partes.numeroVia}${partes.apendiceVia ? `\\s*${partes.apendiceVia}` : ''}\\b`, 'i');
    if (patronVia.test(calle)) puntos += 6;
  }
  // Placa (el número después del guion) contra el housenumber devuelto.
  if (partes.placa && props.housenumber) {
    const numeroCasa = normalizarTexto(props.housenumber);
    if (numeroCasa.includes(partes.placa)) puntos += 6;
    // Geoapify a veces devuelve la placa completa "52-44".
    if (partes.numeroCruce && numeroCasa.includes(`${partes.numeroCruce}-${partes.placa}`)) puntos += 3;
  }
  return puntos;
};

// Lee la comuna de TODOS los campos donde puede venir, en orden de
// fiabilidad, y cae al nombre del barrio como último recurso.
const comunaDelResultado = (props) => {
  const camposBarrio = [props.suburb, props.district, props.city_district, props.neighbourhood, props.quarter];
  // 1) Un número de comuna explícito en cualquiera de esos campos.
  for (const campo of [...camposBarrio, props.address_line2, props.formatted]) {
    const n = extraerNumeroComuna(campo);
    if (n != null) return { comuna: n, via: 'numero' };
  }
  // 2) Nombre de barrio conocido — SOLO si el punto cae en la zona 8/9
  //    (ver la advertencia en BARRIOS_POR_COMUNA).
  if (dentroDe(CAJA_COMUNA_8_9, props.lat, props.lon)) {
    const porBarrio = comunaPorNombreBarrio(camposBarrio);
    if (porBarrio != null) return { comuna: porBarrio, via: 'barrio' };
  }
  return { comuna: null, via: null };
};

// Caché compartida de geocodificación: el checkout consulta la cobertura y
// enseguida crea el pedido con la MISMA dirección — sin esto son dos
// llamadas externas (y dos oportunidades de fallar) por cada pedido.
const cacheGeocodificacion = crearCache({ ttlMs: 30 * 60 * 1000, maxEntradas: 500 });
const claveCache = (texto) => normalizarTexto(texto).replace(/\s+/g, ' ').trim();

const TIMEOUT_GEOAPIFY_MS = Number(process.env.GEOCODING_TIMEOUT_MS || 6000);

/**
 * Geocodifica con Geoapify. Devuelve null si NINGÚN candidato corresponde
 * de verdad a la dirección pedida (que es distinto de fallar: si el
 * servicio no responde, lanza ErrorServicioExterno).
 */
async function geocodificarDireccion(direccionTexto) {
  const apiKey = process.env.GEOAPIFY_API_KEY;
  if (!apiKey) {
    // Causa número uno de "funciona local y no desplegado": la variable
    // quedó solo en el .env del computador. Se lanza un error TIPADO para
    // que la ruta responda algo accionable en vez de un 500 genérico.
    throw new ErrorServicioExterno('configuracion', 'GEOAPIFY_API_KEY no está configurada en el entorno del servidor');
  }
  const texto = String(direccionTexto || '').trim();
  if (!texto) return null;

  const partes = partesDeLaDireccion(texto);
  const consulta = prepararTextoParaGeoapify(texto);

  const parametros = new URLSearchParams({
    text: consulta,
    // Filtro DURO por rectángulo de Medellín (formato lon1,lat1,lon2,lat2)
    // — reemplaza al `bias` de antes, que era solo una preferencia.
    filter: `rect:${CAJA_MEDELLIN.lonMin},${CAJA_MEDELLIN.latMin},${CAJA_MEDELLIN.lonMax},${CAJA_MEDELLIN.latMax}`,
    bias: 'proximity:-75.5470,6.2380', // centro aproximado de las comunas 8 y 9
    lang: 'es',
    // Varios candidatos, no uno: con limit=1 se aceptaba a ciegas lo
    // primero que devolviera, aunque no tuviera nada que ver.
    limit: '5',
    format: 'geojson',
    apiKey,
  });

  const data = await obtenerJson(`${GEOAPIFY_URL}?${parametros.toString()}`, {
    timeoutMs: TIMEOUT_GEOAPIFY_MS,
    reintentos: 1,
    etiqueta: 'Geoapify',
  });

  const candidatos = Array.isArray(data?.features) ? data.features : [];
  if (candidatos.length === 0) return null;

  let mejor = null;
  for (const feature of candidatos) {
    const props = feature?.properties || {};
    const puntos = puntuarCandidato(props, partes);
    if (puntos == null) continue;
    if (!mejor || puntos > mejor.puntos) mejor = { props, puntos };
  }
  // Ningún candidato corresponde a lo que se pidió → "no encontrada".
  // Antes, en este mismo caso, se devolvía el primero de la lista.
  if (!mejor) return null;

  const props = mejor.props;
  const { comuna, via } = comunaDelResultado(props);

  return {
    comuna,
    formatted: props.formatted || null,
    lat: props.lat ?? null,
    lon: props.lon ?? null,
    fuente: 'geoapify',
    confianza: Number(props.rank?.confidence || 0),
    comunaSegun: via,
  };
}

// Nota informativa (nunca cambia la sede real): si tenemos coordenadas y el
// local más cercano en línea recta NO es el mismo que el asignado por
// comuna, se agrega un aviso — útil en zonas límite entre Comuna 8 y 9,
// donde la comuna administrativa y la cercanía real pueden no coincidir.
const construirAvisoProximidad = (sedeAsignada, lat, lon) => {
  const cercano = localMasCercanoPorDistancia(lat, lon);
  if (!cercano || cercano.sede === sedeAsignada) return null;
  return {
    localMasCercano: cercano.sede,
    distanciaKm: Math.round(cercano.km * 10) / 10,
  };
};

/**
 * Resuelve la sede que atiende una dirección.
 *
 * NUNCA LANZA. Siempre devuelve un objeto con "motivo", y es el `motivo`
 * el que distingue los casos — antes, un fallo del servicio externo
 * (timeout, cuota agotada, API key faltante) subía como excepción y la
 * ruta lo convertía en un 502 que dejaba al cliente sin poder pedir,
 * indistinguible de "tu dirección está fuera de cobertura".
 *
 *   cubierto:true                   → hay sede asignada
 *   motivo:'fuera_de_cobertura'     → se ubicó y NO es comuna 8/9 (rechazo firme)
 *   motivo:'no_geocodificada'       → no se pudo ubicar (pedir confirmación manual)
 *   motivo:'servicio_no_disponible' → el geocodificador falló (confirmación manual)
 */
async function determinarSedePorDireccion(direccionTexto) {
  const texto = String(direccionTexto || '').trim();

  // Paso 1: ¿la dirección menciona un punto de referencia conocido?
  const comunaConocida = comunaPorPuntoReferencia(texto);
  if (comunaConocida != null) {
    const sede = COBERTURA_POR_COMUNA[comunaConocida] || null;
    return {
      sede,
      cubierto: !!sede,
      motivo: sede ? null : 'fuera_de_cobertura',
      detalle: { comuna: comunaConocida, formatted: `Punto de referencia conocido (Comuna ${comunaConocida})`, lat: null, lon: null, fuente: 'punto_referencia' },
      avisoProximidad: null, // sin coordenadas propias, no se puede comparar distancia
    };
  }

  const clave = claveCache(texto);
  const enCache = clave ? cacheGeocodificacion.obtener(clave) : undefined;
  if (enCache !== undefined) return enCache;

  // Paso 2: catastro oficial de Medellín — más preciso que Geoapify para
  // direcciones formales (calle/carrera + número), porque la comuna viene
  // directo del CBML, no de una interpretación del mapa. Solo aplica si el
  // texto tiene forma de dirección con nomenclatura completa (ver
  // parsearDireccionColombiana); si no, o si falla la consulta (red,
  // timeout, formato inesperado), sigue con Geoapify sin bloquear al
  // usuario.
  let resultado = null;
  let falloServicio = null;
  try {
    resultado = await geocodificarGeoMedellin(texto);
  } catch (e) {
    // GeoMedellín no disponible ahora mismo: se anota y se sigue con el
    // respaldo. Solo si Geoapify TAMBIÉN falla se reporta como caída.
    falloServicio = e;
    resultado = null;
  }

  // Paso 3: sin resultado de GeoMedellín (no aplicaba, o no encontró nada),
  // se prueba con Geoapify.
  if (!resultado) {
    try {
      resultado = await geocodificarDireccion(texto);
      falloServicio = null; // Geoapify sí contestó: el fallo anterior da igual
    } catch (e) {
      falloServicio = e;
      resultado = null;
    }
  }

  // Los dos servicios fallaron: NO es "fuera de cobertura" ni "dirección
  // inexistente", es que no pudimos verificar. Se trata como el caso de
  // confirmación manual para no dejar al cliente sin poder pedir por una
  // caída que no es suya — pero se marca con su propio motivo para que
  // quede claro en la respuesta y en los logs.
  if (!resultado && falloServicio) {
    console.error(`🌎 Geocodificación no disponible para "${texto}": ${falloServicio.tipo || 'error'} — ${falloServicio.message}`);
    return {
      sede: null,
      cubierto: false,
      motivo: 'servicio_no_disponible',
      requiereSeleccionManual: true,
      detalle: null,
      avisoProximidad: null,
    };
  }

  let respuesta;
  if (!resultado || resultado.comuna == null) {
    respuesta = {
      sede: null, cubierto: false, motivo: 'no_geocodificada',
      requiereSeleccionManual: true, detalle: resultado, avisoProximidad: null,
    };
  } else {
    const sede = COBERTURA_POR_COMUNA[resultado.comuna] || null;
    respuesta = sede
      ? {
        sede, cubierto: true, motivo: null, detalle: resultado,
        avisoProximidad: construirAvisoProximidad(sede, resultado.lat, resultado.lon),
      }
      : { sede: null, cubierto: false, motivo: 'fuera_de_cobertura', detalle: resultado, avisoProximidad: null };
  }

  // Solo se cachean las respuestas CONCLUYENTES. Un 'servicio_no_disponible'
  // no se guarda nunca (ya se devolvió antes de llegar acá) y un
  // 'no_geocodificada' se guarda poco tiempo, porque puede deberse a una
  // indisponibilidad parcial y no a que la dirección no exista.
  if (clave) cacheGeocodificacion.guardar(clave, respuesta);
  return respuesta;
}

module.exports = {
  geocodificarDireccion,
  extraerNumeroComuna,
  determinarSedePorDireccion,
  // Exportados para los tests y para el diagnóstico de producción.
  COBERTURA_POR_COMUNA,
  cacheGeocodificacion,
  prepararTextoParaGeoapify,
  partesDeLaDireccion,
  puntuarCandidato,
  comunaDelResultado,
};
