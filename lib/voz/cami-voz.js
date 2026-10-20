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
//
// PRIMERA LLAMADA REAL (2026-10-19, voz_llamadas 1): check_availability devolvio
// needs_clarification y Cami pidio "el código del apartamento exacto", y luego
// pregunto por "una habitación, estudio o algo más grande". Causas y arreglo:
//   - el esquema de Cami-texto (tipos ["string","null"] y todos los campos
//     obligatorios) esta pensado para salida estricta; la voz no la tiene y el
//     modelo rellenaba apartment_code / nights con lo que no era. La voz usa su
//     propio esquema (solo la llegada es obligatoria; salida o noches; el
//     apartamento se OMITE para buscar en todos) y el webhook normaliza los
//     argumentos al contrato del PMS (normalizarArgsVoz);
//   - el inventario publicado entra en las instrucciones: Cami voz solo
//     describe las unidades con lo que dicen sus fichas, nunca inventa tipos.
// Direccion de José Manuel (2026-10-19): con disponibilidad, nombrar 2 o 3
// opciones y mandar las fotos al chat durante la llamada.

const { toolsForModel } = require('../pilot/llm/tools');

const HERRAMIENTAS_PMS = new Set([
  'check_availability', 'quote_stay', 'get_policy', 'get_public_apartment_attributes', 'search_commercial_knowledge',
]);
// Revision 2026-10-19 (P2-4): a un huesped de Airbnb o con una persona al mando
// no se le cotiza, no se le ofrece disponibilidad ni se le mandan fotos por voz.
const HERRAMIENTAS_COMERCIALES = new Set(['check_availability', 'quote_stay', 'enviar_opciones_al_chat']);

const FECHA = { type: 'string', description: 'Fecha ISO YYYY-MM-DD.' };
const APTO = { type: 'string', description: 'Código del apartamento (por ejemplo LF-510) SOLO si la persona pidió uno concreto. Si no, OMÍTELO: se busca en todos los apartamentos.' };
// Esquemas propios de la voz para las dos herramientas que piden fechas.
const ESQUEMAS_VOZ = {
  check_availability: {
    description: 'Disponibilidad real en TODOS los apartamentos (o en uno si la persona lo pidió). Necesita la llegada y la salida (o las noches); las personas ayudan a filtrar. No pidas código ni tipo de apartamento para consultar.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: { arrival_date: FECHA, departure_date: FECHA, nights: { type: 'integer', minimum: 1 },
        guests: { type: 'integer', minimum: 1 }, apartment_code: APTO },
      required: ['arrival_date'],
    },
  },
  quote_stay: {
    description: 'Precio con la misma autoridad que la propuesta escrita. Necesita la llegada y la salida (o las noches). El precio SIEMPRE sale de aquí.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: { arrival_date: FECHA, departure_date: FECHA, nights: { type: 'integer', minimum: 1 }, apartment_code: APTO },
      required: ['arrival_date'],
    },
  },
};

// Herramientas locales: no salen del webhook (o van a rutas propias del PMS).
const HERRAMIENTAS_LOCALES = [
  {
    type: 'function',
    name: 'enviar_opciones_al_chat',
    description: 'Envía al chat de WhatsApp de esta persona, mientras siguen hablando, las fotos de 1 a 3 apartamentos que check_availability dio como disponibles. Úsala cuando la persona acepte recibirlas.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: { apartment_codes: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 3 } },
      required: ['apartment_codes'],
    },
  },
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
    .map(({ name, description, parameters }) => ({ type: 'function', name, ...(ESQUEMAS_VOZ[name] || { description, parameters }) }));
  const locales = HERRAMIENTAS_LOCALES.filter((t) => !(sinComerciales && HERRAMIENTAS_COMERCIALES.has(t.name)));
  return [...pms, ...locales];
}

// ---------------------------------------------------------------------------
// Argumentos de la voz -> contrato del PMS ({arrival_date, nights, guests,
// apartment_code}). Lo que no se reconoce se descarta (null), nunca se adivina.
// ---------------------------------------------------------------------------
const ISO = /^\d{4}-\d{2}-\d{2}$/;
function fechaIso(v) {
  const s = String(v ?? '').trim();
  if (!ISO.test(s)) return null;
  const d = new Date(`${s}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s ? null : s;
}
function entero(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 && n < 1000 ? n : null;
}
// "LF-510", "lf 510", "510", "el 1208" -> "LF-510"/"LF-1208". "cualquiera",
// "estudio", "" -> null (buscar en todos).
function codigoApartamento(v) {
  const m = /^\s*(?:el\s+)?(?:lf[\s-]?)?(\d{3,4})\s*$/i.exec(String(v ?? ''));
  return m ? `LF-${m[1]}` : null;
}
function nochesEntre(llegada, salida) {
  if (!llegada || !salida) return null;
  const n = Math.round((Date.parse(`${salida}T00:00:00Z`) - Date.parse(`${llegada}T00:00:00Z`)) / 86_400_000);
  return n > 0 ? n : null;
}
function salidaDesde(llegada, noches) {
  if (!llegada || !noches) return null;
  const d = new Date(`${llegada}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + noches);
  return d.toISOString().slice(0, 10);
}
function normalizarArgsVoz(nombre, args = {}) {
  if (nombre !== 'check_availability' && nombre !== 'quote_stay') return args;
  const llegada = fechaIso(args.arrival_date);
  const noches = entero(args.nights) ?? nochesEntre(llegada, fechaIso(args.departure_date));
  const base = { arrival_date: llegada, nights: noches, apartment_code: codigoApartamento(args.apartment_code) };
  return nombre === 'check_availability' ? { ...base, guests: entero(args.guests) } : base;
}

const PRESENTACION = 'Hola, soy Cami, la asistente virtual con inteligencia artificial de Miu La Frontera. '
  + 'Esta llamada se transcribe para atenderte y luego seguir por este chat. '
  + 'Si prefieres hablar con una persona, dímelo. ¿En qué te ayudo?';

// Bloque de inventario publicado (viene del PMS: fichas publicadas, lo mismo
// que lee Cami-texto). Sin inventario no se inventa nada: se remite a las tools.
function bloqueInventario(inventario) {
  const unidades = Array.isArray(inventario?.unidades) ? inventario.unidades : [];
  if (!unidades.length) {
    return 'INVENTARIO: no lo tengo cargado ahora. No describas tipos de apartamento: consulta get_public_apartment_attributes o search_commercial_knowledge.';
  }
  const lineas = unidades.slice(0, 12).map((u) => {
    const partes = [u.titulo, u.resumen,
      u.capacidad ? `hasta ${u.capacidad} personas` : null,
      u.area_m2 ? `unos ${u.area_m2} m²` : null,
      Array.isArray(u.camas) && u.camas.length ? u.camas.join(', ') : null,
      u.balcon === true ? 'con balcón' : u.balcon === false ? 'sin balcón' : null,
      ...(Array.isArray(u.destacados) ? u.destacados : [])].filter(Boolean);
    return `- ${u.codigo}: ${partes.join('; ') || 'sin ficha publicada'}`;
  });
  const edificio = Array.isArray(inventario.edificio) && inventario.edificio.length
    ? `Edificio: ${inventario.edificio.slice(0, 8).join(' ')}` : null;
  return ['INVENTARIO PUBLICADO (lo único que puedes afirmar de las unidades; no hay otros tipos de unidad que estos):',
    ...lineas, edificio].filter(Boolean).join('\n').slice(0, 3500);
}

function instruccionesCamiVoz({ hoy, nombre = null, huespedAirbnb = false, personaAlMando = false, duracionMaxMin = 10, inventario = null }) {
  const comercial = !huespedAirbnb && !personaAlMando;
  const lineas = [
    'Eres Cami, la asistente virtual con inteligencia artificial de Miu La Frontera: apartamentos amoblados para estadías en el edificio La Frontera, Medellín, Colombia.',
    'Hablas por una llamada de WhatsApp. Habla en español colombiano, cálido, natural y MUY breve: una o dos frases por turno, una idea a la vez, sin listas ni símbolos. Si la persona habla otro idioma, contéstale en su idioma.',
    `Fecha de hoy en Bogotá: ${hoy}. Resuelve fechas relativas ("el próximo mes", "el 15") contra esa fecha y confírmalas en voz alta.`,
    'REGLAS QUE NO SE ROMPEN:',
    '- Nunca reservas, apartas, cobras ni das datos de pago o cuentas por teléfono. Si la persona quiere reservar o pagar, dile que le envías la cotización por escrito a este chat para que la confirme.',
    '- Los precios SOLO salen de la herramienta quote_stay. Nunca calcules, redondees de más ni inventes un precio. Di que el valor exacto queda en la cotización escrita.',
    '- Disponibilidad solo con check_availability. Si una unidad está libre pero no se vende por canal directo para esa duración, no digas que no hay disponibilidad.',
    '- Lo que afirmes de un apartamento o del edificio sale del INVENTARIO PUBLICADO de abajo o de get_public_apartment_attributes, get_policy o search_commercial_knowledge. Nunca inventes tipos de unidad (habitaciones, alcobas, tamaños) ni datos. Si un tema no tiene respuesta publicada, di que lo confirmas por escrito.',
    '- No prometas plazos, descuentos ni excepciones. Si la persona pide hablar con alguien, tiene una queja o una emergencia, usa pedir_persona y dile que José Manuel o el equipo le escribe por este chat.',
    '- Si la persona te dice que tiene o tuvo una reserva por Airbnb, no le ofrezcas reservar directo ni le des precios directos: ayúdala con su estadía y, para cambios o pagos de esa reserva, remítela a Airbnb.',
    '- No pidas números de documento, tarjetas ni contraseñas.',
    `- La llamada dura como máximo ${duracionMaxMin} minutos. Cuando la persona se despida o no necesite nada más, despídete y usa terminar_llamada.`,
  ];
  if (comercial) {
    lineas.push(
      'CÓMO ATENDER UNA BÚSQUEDA:',
      '- Pide solo lo que falte: fecha de llegada, fecha de salida o cuántas noches, y cuántas personas. NUNCA pidas código, tipo ni tamaño de apartamento: check_availability busca en todos.',
      '- Con disponibilidad, nombra 2 o 3 opciones en una frase cada una (con lo del inventario publicado) y ofrece enviarle las fotos al chat de WhatsApp ahora mismo.',
      '- Si acepta, usa enviar_opciones_al_chat con esos códigos y dile que puede seguir hablando contigo mientras las ve. Si le queda incómodo hacer las dos cosas, dile que puede colgar, mirar el chat y seguir por ahí escribiendo o con notas de voz, o volver a llamarte.',
      '- Si pregunta el precio, usa quote_stay con las mismas fechas y dilo en una frase.',
    );
  }
  lineas.push('Al final de la llamada se le envía a la persona un mensaje por WhatsApp; puedes decírselo.');
  if (nombre) lineas.push(`La persona se llama ${nombre}; puedes llamarla por su nombre.`);
  if (huespedAirbnb) {
    lineas.push('CONTEXTO: el sistema indica que esta persona es huésped de una reserva de Airbnb vigente o próxima. No le ofrezcas reservar directo ni precios directos. Ayúdala con su estadía (llegada, wifi, normas, problemas) y para cambios o pagos remítela a Airbnb.');
  }
  if (personaAlMando) {
    lineas.push('CONTEXTO: una persona del equipo está atendiendo el caso de este cliente por chat. Escucha, toma nota de lo que necesita con pedir_persona y dile que le responden por este chat. No cotices ni ofrezcas nada nuevo.');
  }
  lineas.push(bloqueInventario(inventario));
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
  HERRAMIENTAS_COMERCIALES, NOMBRES_HERRAMIENTAS, normalizarArgsVoz, codigoApartamento, salidaDesde, bloqueInventario };
