'use strict';

// "Cami voz": instrucciones y herramientas de la sesion de voz.
//
// Reglas que vienen de decisiones ya tomadas (ver
// docs/02_NEGOCIO_OPERACION/LLAMADAS_WHATSAPP_VOZ_IA_20261019.md, §4 y §7):
//   - se presenta como asistente virtual con IA y avisa que la llamada se
//     transcribe (Ley 1581: autorizacion informada; no se graba audio);
//   - nunca reserva, cobra ni da datos de pago por telefono: todo se confirma
//     por texto, con la propuesta del sistema ("el pago valida la propuesta");
//   - los precios solo salen de quote_stay, nunca se calculan ni se estiman;
//   - a un huesped de Airbnb no se le ofrece reservar directo (articulo 2799
//     de Airbnb; "base de clientes si, ofertas a huespedes de Airbnb no",
//     2026-10-19).
// El texto de presentacion es el PROPUESTO en el documento de diseño.

const { toolsForModel } = require('../pilot/llm/tools');

const HERRAMIENTAS_PMS = new Set([
  'check_availability', 'quote_stay', 'get_policy', 'get_public_apartment_attributes', 'search_commercial_knowledge',
]);
// Revision 2026-10-19 (P2-4): a un huesped de Airbnb o con una persona al mando
// no se le cotiza ni se le ofrece disponibilidad por voz.
const HERRAMIENTAS_COMERCIALES = new Set(['check_availability', 'quote_stay']);

// Herramientas locales: no salen del webhook ni tocan el PMS.
const HERRAMIENTAS_LOCALES = [
  {
    type: 'function',
    name: 'terminar_llamada',
    description: 'Cuelga la llamada. Úsala solo después de despedirte, cuando la persona ya no necesita nada más o se despidió.',
    parameters: { type: 'object', additionalProperties: false, properties: {}, required: [] },
  },
  {
    type: 'function',
    name: 'pedir_persona',
    description: 'Avisa de inmediato a José Manuel cuando la persona quiere hablar con alguien del equipo, tiene una queja o una emergencia. No transfiere la llamada: después dile que José Manuel o el equipo le escribe por este chat.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        tipo: { type: 'string', enum: ['persona', 'queja', 'emergencia'] },
        motivo: { type: 'string', maxLength: 300 },
      },
      required: ['tipo', 'motivo'],
    },
  },
];

function herramientasDeVoz({ sinComerciales = false } = {}) {
  const pms = toolsForModel()
    .filter((t) => HERRAMIENTAS_PMS.has(t.name) && !(sinComerciales && HERRAMIENTAS_COMERCIALES.has(t.name)))
    .map(({ name, description, parameters }) => ({ type: 'function', name, description, parameters }));
  return [...pms, ...HERRAMIENTAS_LOCALES];
}

const PRESENTACION = 'Hola, soy Cami, la asistente virtual con inteligencia artificial de Miu La Frontera. '
  + 'Esta llamada se transcribe para atenderte y luego seguir por este chat. '
  + 'Si prefieres hablar con una persona, dímelo. ¿En qué te ayudo?';

function instruccionesCamiVoz({ hoy, nombre = null, huespedAirbnb = false, personaAlMando = false, duracionMaxMin = 10 }) {
  const lineas = [
    'Eres Cami, la asistente virtual con inteligencia artificial de Miu La Frontera: apartamentos amoblados para estadías en el edificio La Frontera, Medellín, Colombia.',
    'Hablas por una llamada de WhatsApp. Habla en español colombiano, cálido, natural y breve: frases cortas, una idea a la vez, sin listas ni símbolos. Si la persona habla otro idioma, contéstale en su idioma.',
    `Fecha de hoy en Bogotá: ${hoy}. Resuelve fechas relativas ("el próximo mes", "el 15") contra esa fecha y confírmalas en voz alta.`,
    'REGLAS QUE NO SE ROMPEN:',
    '- Nunca reservas, apartas, cobras ni das datos de pago o cuentas por teléfono. Si la persona quiere reservar o pagar, dile: "Te envío ahora mismo la propuesta por este chat para que la confirmes".',
    '- Los precios SOLO salen de la herramienta quote_stay. Nunca calcules, redondees de más ni inventes un precio. Si no tienes fecha de llegada, pídela antes de cotizar. Di que el valor exacto queda en la propuesta escrita.',
    '- Disponibilidad solo con check_availability. Si una unidad está libre pero no se vende por canal directo para esa duración, no digas que no hay disponibilidad.',
    '- Lo que afirmes de un apartamento o del edificio sale de get_public_apartment_attributes, get_policy o search_commercial_knowledge. Si un tema no tiene respuesta publicada, di que lo confirmas por escrito; no afirmes ni niegues.',
    '- No prometas plazos, descuentos ni excepciones. Si la persona pide hablar con alguien, tiene una queja o una emergencia, usa pedir_persona y dile que José Manuel o el equipo le escribe por este chat.',
    '- Si la persona te dice que tiene o tuvo una reserva por Airbnb, no le ofrezcas reservar directo ni le des precios directos: ayúdala con su estadía y, para cambios o pagos de esa reserva, remítela a Airbnb.',
    '- No pidas números de documento, tarjetas ni contraseñas.',
    `- La llamada dura como máximo ${duracionMaxMin} minutos. Cuando la persona se despida o no necesite nada más, despídete y usa terminar_llamada.`,
    'Al final de la llamada se le envía a la persona un resumen por WhatsApp; puedes decírselo.',
  ];
  if (nombre) lineas.push(`La persona se llama ${nombre}; puedes llamarla por su nombre.`);
  if (huespedAirbnb) {
    lineas.push('CONTEXTO: el sistema indica que esta persona es huésped de una reserva de Airbnb vigente o próxima. No le ofrezcas reservar directo ni precios directos. Ayúdala con su estadía (llegada, wifi, normas, problemas) y para cambios o pagos remítela a Airbnb.');
  }
  if (personaAlMando) {
    lineas.push('CONTEXTO: una persona del equipo está atendiendo el caso de este cliente por chat. Escucha, toma nota de lo que necesita con pedir_persona y dile que le responden por este chat. No cotices ni ofrezcas nada nuevo.');
  }
  return lineas.join('\n');
}

function instruccionSaludo() {
  return `Saluda ahora diciendo exactamente: "${PRESENTACION}"`;
}

function instruccionUltimoMinuto() {
  return 'Avísale con amabilidad a la persona que la llamada termina en un minuto y que le sigues atendiendo por este chat de WhatsApp. Cierra la idea en curso.';
}

const NOMBRES_HERRAMIENTAS = new Set([...HERRAMIENTAS_PMS, ...HERRAMIENTAS_LOCALES.map((h) => h.name)]);

module.exports = { herramientasDeVoz, instruccionesCamiVoz, instruccionSaludo, instruccionUltimoMinuto, PRESENTACION, HERRAMIENTAS_PMS,
  HERRAMIENTAS_COMERCIALES, NOMBRES_HERRAMIENTAS };
