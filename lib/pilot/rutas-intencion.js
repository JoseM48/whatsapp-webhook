'use strict';

// RUTAS POR INTENCIÓN (José Manuel, 2026-11-08; CAMPANA_POT_20261108/APROBACION.md, puntos
// 5 a 7; paridad de canales, dominio 25). El modelo distingue a un huésped de un
// propietario, de quien quiere comprar o vender un inmueble y de quien quiere ser aliado.
// Solo clasifica: el PMS decide (src/modules/miu-canal/rutas-intencion.service.js).
//   - chat y nota de voz: campo `contact_route` de la interpretación;
//   - llamada: herramienta registrar_ruta_contacto.

const RUTAS = ['owner_listing', 'property_sale', 'ally_interest', 'new_market'];

const contactRouteSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    route: { type: 'string', enum: ['guest', ...RUTAS] },
    barrio: { type: ['string', 'null'], maxLength: 80 },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    summary: { type: ['string', 'null'], maxLength: 200 }
  },
  required: ['route', 'barrio', 'confidence', 'summary']
};

const INSTRUCCION_CHAT = `CONTACT ROUTE (policy miu_canal_v1.rutas_intencion, 2026-11-08): classify who is writing in contact_route, from the CURRENT message and the conversation. You only classify; the system decides what Cami says and never quotes lodging on these routes.
- "guest" (the normal case, and the answer whenever in doubt): anyone looking for, asking about or staying in lodging. "tengo un apartamento reservado", "tengo una reserva", "busco apartamento", "quiero alquilar uno", "quiero arrendar un apto por meses", "necesito un apartamento en El Poblado", "¿cuánto vale el mes?", a guest talking about the apartment where they are staying.
- "owner_listing": the person HAS a property (apartment, apto, apartaestudio, finca, house) and wants us to rent it, manage it, take reservations for it or list it, or asks how that works. Fincas count. "tengo un apto en Laureles, ¿me lo administran?", "tengo la casa-finca para que me ayuden con las reservas y les pago la comisión", "quiero arrendar mi apartamento por meses", "soy propietaria de un apartamento en Envigado", "me interesa lo del diagnóstico para mi apartamento". The property must be THEIRS and offered, not one they want to stay in. barrio: the neighborhood or city if they named it, otherwise null.
- "property_sale": they want to BUY or SELL a property, or invest in one: "quiero vender mi apartamento", "¿venden apartamentos?", "busco comprar un apto en El Poblado". Renting is not buying.
- "ally_interest": they want to be an ally, refer guests or work with us for commission: "quiero ser aliado de Miu y referir clientes", "soy corredor y les puedo mandar clientes". "Me refirió un amigo" or "me recomendaron" is a guest.
- "new_market" (2026-11-09): they ask for lodging, or offer a property, in a city or country where we do not operate: anywhere outside Medellín and the Aburrá Valley (Medellín, Envigado, Sabaneta, Itagüí, Bello, La Estrella, Caldas, Copacabana, Girardota, Barbosa). "busco apartamento en Bogotá", "¿tienen algo en Cartagena?", "do you have anything in Mexico City?". A property in Antioquia stays owner_listing. If they also accept Medellín, it is guest. Where they come from is not where they want to stay: "vivo en Bogotá y necesito un apto por 2 meses" and "I am from Mexico, looking for a place" are guest. barrio: the city or country they ask about.
confidence: how sure you are, 0 to 1. summary: one neutral line without names, phone numbers or addresses; null for guest.`;

const INSTRUCCION_VOZ = [
  'PROPIETARIOS, COMPRA O VENTA Y ALIADOS: si la persona NO busca alojamiento sino que (a) tiene un apartamento o finca SUYO y quiere que lo arrendemos o administremos, (b) quiere comprar o vender un inmueble, o (c) quiere ser aliado o referir clientes, usa registrar_ruta_contacto (owner_listing, property_sale o ally_interest) y NO cotices, no des precios ni ofrezcas apartamentos.',
  '- Dile con calidez que el equipo le escribe por WhatsApp. No des condiciones ni comisiones, ni asesoría legal; no hables del POT ni prometas ingresos. A un aliado no le prometas códigos.',
  '- OTRA CIUDAD U OTRO PAÍS: si pide alojamiento u ofrece un inmueble fuera de Antioquia y del Valle de Aburrá, usa registrar_ruta_contacto con new_market y pon la ciudad o el país en barrio. De dónde viene no cuenta: "vivo en Bogotá y busco en Medellín" es huésped.',
  '- Sigue siendo huésped quien dice "tengo un apartamento reservado", "busco apartamento" o "quiero alquilar uno": atiéndelo como siempre.',
].join('\n');

const HERRAMIENTA_VOZ = Object.freeze({
  type: 'function',
  name: 'registrar_ruta_contacto',
  description: 'Registra que la persona NO busca alojamiento: es propietaria de un inmueble que quiere arrendar o que administremos, quiere comprar o vender un inmueble, quiere ser aliada (el equipo le escribe por WhatsApp), o pide alojamiento u ofrece un inmueble en otra ciudad o país (new_market: se anota). No la uses con huéspedes de Medellín.',
  parameters: {
    type: 'object', additionalProperties: false,
    properties: {
      ruta: { type: 'string', enum: [...RUTAS] },
      barrio: { type: 'string', maxLength: 80, description: 'Barrio o ciudad del inmueble, o la ciudad o país que pide, si lo dijo.' },
      resumen: { type: 'string', maxLength: 400, description: 'Qué quiere, en una línea, sin nombres, teléfonos ni direcciones.' }
    },
    required: ['ruta', 'resumen']
  }
});

/** Lo del modelo, listo para el PMS; null si no es válido. "guest" viaja: el PMS necesita
 *  saber que el modelo sí clasificó, para no contradecirlo con sus reglas. */
function normalizarRutaContacto(raw) {
  if (!raw || typeof raw !== 'object' || !['guest', ...RUTAS].includes(raw.route)) return null;
  const texto = (v, n) => { const t = typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, n) : ''; return t || null; };
  const conf = Number(raw.confidence);
  return { route: raw.route, barrio: texto(raw.barrio, 80), confidence: Number.isFinite(conf) && conf >= 0 && conf <= 1 ? conf : null, summary: texto(raw.summary, 200) };
}

module.exports = { RUTAS, contactRouteSchema, INSTRUCCION_CHAT, INSTRUCCION_VOZ, HERRAMIENTA_VOZ, normalizarRutaContacto };
