const https = require('https');

const where =
  "numero_via=57 AND apendice_via='B'";

const url =
  'https://www.medellin.gov.co/servidormapas/rest/services/ServiciosCatastro/ConsultaOperadorCatastral/MapServer/1/query' +
  `?where=${encodeURIComponent(where)}` +
  '&outFields=tipo_via,numero_via,apendice_via,tipo_cruce,numero_cruce,apendice_cruce,numero_placa,interior,placa,cbml,direccionencasillada,direccioncodificada,latitud,longitud' +
  '&returnGeometry=false' +
  '&resultRecordCount=1000' +
  '&f=json';

console.log('────────────────────────────────────');
console.log('Buscando todas las CL 57B');
console.log('────────────────────────────────────');

https.get(url, (res) => {
  let data = '';

  res.on('data', (chunk) => {
    data += chunk;
  });

  res.on('end', () => {
    try {
      const resultado = JSON.parse(data);

      if (resultado.error) {
        console.error('❌ Error:');
        console.dir(resultado.error, { depth: null });
        return;
      }

      const features = resultado.features || [];

      console.log('Total de registros:', features.length);

      console.log('\nBuscando coincidencias relacionadas con CR 7 / placa 71...\n');

      const coincidencias = features.filter((feature) => {
        const a = feature.attributes;

        return (
          Number(a.numero_cruce) === 7 ||
          String(a.numero_placa || '') === '71'
        );
      });

      if (coincidencias.length === 0) {
        console.log('❌ No se encontró ninguna coincidencia.');
        return;
      }

      for (const feature of coincidencias) {
        const a = feature.attributes;

        console.dir({
          cbml: a.cbml,
          tipo_via: a.tipo_via,
          numero_via: a.numero_via,
          apendice_via: a.apendice_via,
          tipo_cruce: a.tipo_cruce,
          numero_cruce: a.numero_cruce,
          apendice_cruce: a.apendice_cruce,
          numero_placa: a.numero_placa,
          interior: a.interior,
          placa: a.placa,
          direccionencasillada: a.direccionencasillada,
          direccioncodificada: a.direccioncodificada,
          latitud: a.latitud,
          longitud: a.longitud
        }, { depth: null });
      }
    } catch (error) {
      console.error('❌ Error interpretando respuesta:');
      console.error(error.message);
    }
  });
}).on('error', (error) => {
  console.error('❌ Error de conexión:');
  console.error(error.message);
});