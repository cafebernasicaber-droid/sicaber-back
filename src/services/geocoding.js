const GEOAPIFY_URL = 'https://api.geoapify.com/v1/geocode/search';
const { geocodificarGeoMedellin } = require('./geomedellin');

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
    sede, km: distanciaKm(lat, lon, c.lat, c.lon),
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

const normalizarTexto = (texto) =>
  String(texto || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');

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

function extraerNumeroComuna(texto) {
  if (!texto) return null;
  const t = String(texto).trim();

  if (/^\d+$/.test(t)) return Number(t);
  const match = t.match(/comuna\s*(\d+)/i);
  return match ? Number(match[1]) : null;
}

async function geocodificarDireccion(direccionTexto) {
  const apiKey = process.env.GEOAPIFY_API_KEY;
  if (!apiKey) {
    throw new Error('GEOAPIFY_API_KEY no está configurada en el .env');
  }
  const texto = (direccionTexto || '').trim();
  if (!texto) return null;

  const url = `${GEOAPIFY_URL}?text=${encodeURIComponent(texto)}&filter=countrycode:co&bias=proximity:-75.5812,6.2308&limit=1&apiKey=${apiKey}`;

  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`Geoapify respondió ${resp.status} al geocodificar la dirección`);
  }
  const data = await resp.json();
  const feature = data?.features?.[0];
  if (!feature) return null;

  const props = feature.properties || {};
  const comuna = extraerNumeroComuna(props.suburb) ?? extraerNumeroComuna(props.district);

  return {
    comuna,
    formatted: props.formatted || null,
    lat: props.lat ?? null,
    lon: props.lon ?? null,
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

async function determinarSedePorDireccion(direccionTexto) {
  // Paso 1: ¿la dirección menciona un punto de referencia conocido?
  const comunaConocida = comunaPorPuntoReferencia(direccionTexto);
  if (comunaConocida != null) {
    const sede = COBERTURA_POR_COMUNA[comunaConocida] || null;
    return {
      sede,
      cubierto: !!sede,
      motivo: sede ? null : 'fuera_de_cobertura',
      detalle: { comuna: comunaConocida, formatted: `Punto de referencia conocido (Comuna ${comunaConocida})`, lat: null, lon: null },
      avisoProximidad: null, // sin coordenadas propias, no se puede comparar distancia
    };
  }

  // Paso 2: catastro oficial de Medellín — más preciso que Geoapify para
  // direcciones formales (calle/carrera + número), porque la comuna viene
  // directo del CBML, no de una interpretación del mapa. Solo aplica si el
  // texto tiene forma de dirección con nomenclatura completa (ver
  // parsearDireccionColombiana); si no, o si falla la consulta (red,
  // formato inesperado), sigue con Geoapify sin bloquear al usuario.
  let resultado = null;
  try {
    resultado = await geocodificarGeoMedellin(direccionTexto);
  } catch (e) {
    resultado = null; // GeoMedellín no disponible ahora mismo: seguimos con el respaldo
  }

  // Paso 3: sin resultado de GeoMedellín (no aplicaba, o no encontró nada),
  // se prueba con Geoapify — mismo comportamiento que ya funcionaba antes.
  if (!resultado) {
    resultado = await geocodificarDireccion(direccionTexto);
  }

  if (!resultado || resultado.comuna == null) {
    return { sede: null, cubierto: false, motivo: 'no_geocodificada', detalle: resultado, avisoProximidad: null };
  }

  const sede = COBERTURA_POR_COMUNA[resultado.comuna] || null;

  if (!sede) {
    return { sede: null, cubierto: false, motivo: 'fuera_de_cobertura', detalle: resultado, avisoProximidad: null };
  }

  const avisoProximidad = construirAvisoProximidad(sede, resultado.lat, resultado.lon);
  return { sede, cubierto: true, motivo: null, detalle: resultado, avisoProximidad };
}

module.exports = { geocodificarDireccion, extraerNumeroComuna, determinarSedePorDireccion };