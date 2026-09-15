const { geocodificarGeoMedellin } = require('./src/services/geomedellin');

async function probar() {
  const direcciones = [
    'Carrera 11 # 54-61, Medellín',
    'Calle 57B # 7-71, Medellín',
    'Carrera 10A # 52-44, Medellín'
  ];

  for (const direccion of direcciones) {
    console.log('\n────────────────────────────────────');
    console.log('Dirección:', direccion);
    console.log('────────────────────────────────────');

    try {
      const resultado = await geocodificarGeoMedellin(direccion);

      if (!resultado) {
        console.log('❌ No se encontró la dirección');
      } else {
        console.log('✅ Resultado:');
        console.dir(resultado, { depth: null });
      }
    } catch (error) {
      console.error('❌ Error:');
      console.error(error.message);
    }
  }
}

probar();