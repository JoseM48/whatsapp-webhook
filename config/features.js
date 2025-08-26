// config/features.js  (CommonJS)
const FEATURES = {
  "1": true,  // Reservas
  "2": true,  // Reconfirmar / pagos
  "3": true,  // Horarios
  "4": true,  // Ubicación
  "5": true,  // Reglas de la casa
  "6": true,  // WiFi
  "7": true,  // Funcionamiento apto
  "8": true,  // Encuesta
  "9": true   // Otras preguntas
};

function enabledList() {
  return Object.keys(FEATURES)
    .filter(k => FEATURES[k])
    .sort((a,b) => Number(a) - Number(b))
    .join(', ');
}

module.exports = { FEATURES, enabledList };
