// Geocodificación contra el catastro oficial de Medellín (GeoMedellín),
// capa "NomenclaturaDomiciliaria" — direcciones reales con su CBML
// (Comuna-Barrio-Manzana-Lote); los primeros 2 dígitos del CBML SON el
// número de comuna, directo del catastro, sin adivinar nada.
//
// A diferencia de Geoapify (texto libre), este servicio necesita la
// dirección ya separada en sus partes (tipo de vía, número, cruce, placa)
// — ver parsearDireccionColombiana. Solo sirve para direcciones formales
// con nomenclatura completa (Carrera/Calle + número + # + cruce-placa); no
// reconoce nombres de lugares ni puntos de referencia (para eso sigue
// existiendo la lista de PUNTOS_REFERENCIA_CONOCIDOS y Geoapify, en
// geocoding.js).
const GEOMEDELLIN_URL = 'https://www.medellin.gov.co/servidormapas/rest/services/ServiciosCatastro/ConsultaOperadorCatastral/MapServer/1/query';

const TIPOS_VIA = {
  CALLE: 'CL', CL: 'CL',
  CARRERA: 'CR', CRA: 'CR', CR: 'CR',
  DIAGONAL: 'DG', DG: 'DG',
  TRANSVERSAL: 'TV', TV: 'TV',
  CIRCULAR: 'CQ', CQ: 'CQ',
};

const normalizarTexto = (texto) =>
  String(texto || '')
    .toUpperCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();

// Reconoce direcciones tipo "Carrera 11 # 54-61", "Calle 57B #7-71",
// "Cra 10A # 52 - 44". Devuelve null si el texto no tiene esa forma (ej.
// es el nombre de un lugar, no una dirección con nomenclatura).
const parsearDireccionColombiana = (direccionTexto) => {
  const texto = normalizarTexto(direccionTexto);
  // Ojo: la primera "\s*" (antes "\s+") es a propósito — así reconoce tanto
  // "Carrera 13 # 55-189" (con espacio) como "Cr13#55-189" (sin espacio,
  // muy común cuando la gente escribe rápido desde el celular).
  const regex = /^(CALLE|CL|CARRERA|CRA|CR|DIAGONAL|DG|TRANSVERSAL|TV|CIRCULAR|CQ)\.?\s*(\d+)\s*([A-Z]?)\s*(?:SUR|S)?\.?\s*#\s*(\d+)\s*([A-Z]?)\s*-\s*(\d+)/;
  const match = texto.match(regex);
  if (!match) return null;
  const [, tipoRaw, numeroVia, apendiceVia] = match;
  const numeroCruce = match[4];
  const placa = match[6];
  const tipoVia = TIPOS_VIA[tipoRaw];
  if (!tipoVia) return null;
  return {
    tipo_via: tipoVia,
    numero_via: Number(numeroVia),
    apendice_via: apendiceVia || '',
    numero_cruce: Number(numeroCruce),
    placa,
  };
};

const ejecutarConsulta = async (where) => {
  const url = `${GEOMEDELLIN_URL}?where=${encodeURIComponent(where)}&outFields=cbml,latitud,longitud,direccioncodificada&f=json`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`GeoMedellín respondió ${resp.status}`);
  const data = await resp.json();
  return data?.features || [];
};

const construirWhere = (p, incluirApendice) => {
  let where = `tipo_via='${p.tipo_via}' AND numero_via=${p.numero_via} AND numero_cruce=${p.numero_cruce} AND numero_placa='${p.placa}'`;
  if (incluirApendice && p.apendice_via) where += ` AND apendice_via='${p.apendice_via}'`;
  return where;
};

// Caja geográfica aproximada que cubre Comuna 8 (Villa Hermosa) y Comuna 9
// (Buenos Aires) — con margen. Cualquier resultado de GeoMedellín fuera de
// esta caja se descarta antes de contar comunas: como los números de vía
// se repiten en toda Medellín, la consulta por vía/cruce/placa a veces
// puede coincidir por casualidad con un lote de otra parte de la ciudad
// (ver CAMBIOS.md) — esto evita que ese caso raro se cuele como resultado.
const CAJA_COMUNA_8_9 = { latMin: 6.21, latMax: 6.27, lonMin: -75.565, lonMax: -75.525 };
const dentroDeLaZona = (lat, lon) =>
  lat != null && lon != null &&
  lat >= CAJA_COMUNA_8_9.latMin && lat <= CAJA_COMUNA_8_9.latMax &&
  lon >= CAJA_COMUNA_8_9.lonMin && lon <= CAJA_COMUNA_8_9.lonMax;

// Geocodifica contra el catastro oficial. Devuelve { comuna, formatted,
// lat, lon } o null si la dirección no tiene forma reconocible, si el
// catastro no tiene ningún punto que coincida, o si los únicos puntos
// encontrados quedan fuera de la zona de Comuna 8/9 (se prefiere no
// contestar a arriesgar una coincidencia falsa lejana — Geoapify sigue
// como respaldo en ese caso).
async function geocodificarGeoMedellin(direccionTexto) {
  const parsed = parsearDireccionColombiana(direccionTexto);
  if (!parsed) return null;

  let features = parsed.apendice_via ? await ejecutarConsulta(construirWhere(parsed, true)) : [];
  if (features.length === 0) features = await ejecutarConsulta(construirWhere(parsed, false));
  if (features.length === 0) return null;

  features = features.filter((f) => dentroDeLaZona(f.attributes?.latitud, f.attributes?.longitud));
  if (features.length === 0) return null;

  const conteoComunas = new Map();
  for (const f of features) {
    const cbml = f.attributes?.cbml;
    if (!cbml || cbml.length < 2) continue;
    const comuna = Number(cbml.slice(0, 2));
    if (!Number.isInteger(comuna)) continue;
    conteoComunas.set(comuna, (conteoComunas.get(comuna) || 0) + 1);
  }
  if (conteoComunas.size === 0) return null;
  const comunaMasComun = [...conteoComunas.entries()].sort((a, b) => b[1] - a[1])[0][0];

  const primero = features[0].attributes;
  return {
    comuna: comunaMasComun,
    formatted: primero.direccioncodificada || direccionTexto,
    lat: primero.latitud ?? null,
    lon: primero.longitud ?? null,
    fuente: 'geomedellin',
  };
}

module.exports = { geocodificarGeoMedellin, parsearDireccionColombiana };