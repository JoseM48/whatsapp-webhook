'use strict';

// Revision de conversaciones 2026-10-05 (V4): WhatsApp marca la negrita con UN
// asterisco (*x*); el Markdown de dos (**x**) que a veces escribe el redactor
// se ve con asteriscos sueltos (outbox 1557, lead 111: "**COP 3.197.000**").
// Se convierte justo antes de enviar al huesped. Solo toca pares completos en
// una misma linea; un asterisco suelto o un "*x*" ya correcto quedan igual.
function negritaWhatsApp(texto) {
  if (typeof texto !== 'string' || !texto) return texto;
  return texto.replace(/\*\*([^*\n]+?)\*\*/g, '*$1*');
}

module.exports = { negritaWhatsApp };
