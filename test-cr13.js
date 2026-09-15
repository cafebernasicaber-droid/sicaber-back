require('dotenv').config();
const { determinarSedePorDireccion } = require('./src/services/geocoding');

const direcciones = [
  'Carrera 14B #56-15, Medellín',
  'Cl 71B Cr 29-26 Int 303, Medellín',
];

(async () => {
  for (const d of direcciones) {
    console.log('\n──────────────────────────');
    console.log('Dirección:', d);
    try {
      console.log(await determinarSedePorDireccion(d));
    } catch (e) {
      console.error('Error:', e.message);
    }
  }
})();