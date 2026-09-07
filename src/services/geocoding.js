const GEOAPIFY_URL = 'https://api.geoapify.com/v1/geocode/search';


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

// Comuna 8 -> Local 2 (Villa Lilian) | Comuna 9 -> Local 1 (Tres Esquinas)
const COBERTURA_POR_COMUNA = {
  8: 'Local 2',
  9: 'Local 1',
};

async function determinarSedePorDireccion(direccionTexto) {
  const resultado = await geocodificarDireccion(direccionTexto);

  if (!resultado || resultado.comuna == null) {
    return { sede: null, cubierto: false, motivo: 'no_geocodificada', detalle: resultado };
  }

  const sede = COBERTURA_POR_COMUNA[resultado.comuna] || null;

  if (!sede) {
    return { sede: null, cubierto: false, motivo: 'fuera_de_cobertura', detalle: resultado };
  }

  return { sede, cubierto: true, motivo: null, detalle: resultado };
}

module.exports = { geocodificarDireccion, extraerNumeroComuna, determinarSedePorDireccion };