require('dotenv').config();
const { determinarSedePorDireccion } = require('./src/services/geocoding');

const direcciones = [
  { texto: 'Carrera 10A #52-44, Medellín', esperado: 'Local 1 (Tres Esquinas) - Comuna 9' },
  { texto: 'Calle 57B #7-71, Medellín', esperado: 'Local 2 (Villa Lilian) - Comuna 8' },
];

(async () => {
  for (const { texto, esperado } of direcciones) {
    console.log('\n──────────────────────────');
    console.log('Dirección:', texto);
    console.log('Se espera:', esperado);
    try {
      const resultado = await determinarSedePorDireccion(texto);
      console.log('Resultado:', resultado);
    } catch (e) {
      console.error('Error:', e.message);
    }
  }
})();