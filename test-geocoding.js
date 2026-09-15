require('dotenv').config();
const { determinarSedePorDireccion } = require('./src/services/geocoding');

const direccionesDePrueba = [
  'Calle 8 Sur #35-20, Medellín',           // prueba anterior -> Comuna 15 (fuera de cobertura)
  'Carrera 65 #30-10, Medellín',             // prueba anterior -> Comuna 11 (fuera de cobertura)
  'Calle 10 #43-20, El Poblado, Medellín',   // prueba anterior -> Comuna 14 (fuera de cobertura)
  'Calle 57B, Medellín',                     // prueba anterior -> Comuna 8 (Villa Lilian / Local 2)
  'Estación Alejandro Echeverría, Medellín', // prueba anterior -> no geocodificada
  'Barrio Caicedo, Medellín',                // prueba anterior -> Comuna 9 (Tres Esquinas / Local 1)
  'Carrera 13 #55-189, Medellín',            // prueba anterior -> Comuna 14 (fuera de cobertura)
  'Centro Comercial La Central, Medellín',
  'Carrera 11 # 54-61, Interior 101, Medellín',
  'Institución Educativa Vida para Todos, Medellín',
];

(async () => {
  for (const direccion of direccionesDePrueba) {
    console.log('\n──────────────────────────');
    console.log('Dirección:', direccion);
    try {
      const resultado = await determinarSedePorDireccion(direccion);
      console.log('Resultado:', resultado);
    } catch (e) {
      console.error('Error:', e.message);
    }
  }
})();