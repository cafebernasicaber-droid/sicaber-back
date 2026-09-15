require('dotenv').config();
const { geocodificarDireccion } = require('./src/services/geocoding');

const variantes = [
  'Carrera 11 # 54-61, Interior 101, Medellín',
  'Cra 11 # 54-61, Medellín',
  'Carrera 11 #54-61, Medellín, Antioquia',
  'Calle 54 # 11-61, Medellín',
  'Carrera 11 con Calle 54, Medellín',
];

(async () => {
  for (const d of variantes) {
    console.log('\n──────────────────────────');
    console.log('Dirección:', d);
    try {
      console.log(await geocodificarDireccion(d));
    } catch (e) {
      console.error('Error:', e.message);
    }
  }
})();