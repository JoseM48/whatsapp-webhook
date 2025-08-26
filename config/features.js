// config/features.js
export const FEATURES = {
  '1': true,   // Reservas, disponibilidad y tarifas
  '2': false,  // Anticipo y formas de pago
  '3': false,  // Horarios Check In/Out
  '4': false,  // Ubicación e indicaciones
  '5': false,  // Reglas de la casa
  '6': true,   // Clave WiFi
  '7': true,   // Funcionamiento apartamento
  '8': true    // Hablar con un agente
};

export function enabledList() {
  return Object.entries(FEATURES)
    .filter(([, v]) => !!v)
    .map(([k]) => k)
    .join(', ');
}