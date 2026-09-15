const https = require("https");

const direccion = "Carrera 11 # 54-61, Medellín";

const url =
  "https://www.medellin.gov.co/servidormapas/rest/services/ServiciosGeocodificacion/geocodificacionashape/GPServer";

console.log("──────────────────────────");
console.log("Probando GeoMedellín");
console.log("Dirección:", direccion);
console.log("──────────────────────────");
console.log("\nServicio encontrado:");
console.log(url);

https
  .get(url + "?f=json", (res) => {
    let data = "";

    res.on("data", (chunk) => {
      data += chunk;
    });

    res.on("end", () => {
      try {
        const resultado = JSON.parse(data);

        console.log("\nRespuesta de GeoMedellín:");
        console.dir(resultado, { depth: null });
      } catch (error) {
        console.error("\n❌ No se pudo interpretar la respuesta:");
        console.error(data);
      }
    });
  })
  .on("error", (error) => {
    console.error("\n❌ Error de conexión:");
    console.error(error.message);
  });