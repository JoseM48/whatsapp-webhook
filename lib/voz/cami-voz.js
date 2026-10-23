'use strict';

// "Cami voz": instrucciones y herramientas de la sesion de voz.
//
// Reglas que vienen de decisiones ya tomadas (ver
// docs/02_NEGOCIO_OPERACION/LLAMADAS_WHATSAPP_VOZ_IA_20261019.md, §4 y §7):
//   - se presenta como asistente virtual con IA y avisa que la llamada se
//     transcribe (Ley 1581: autorizacion informada; no se graba audio);
//   - nunca reserva, cobra ni da datos de pago por telefono: todo se confirma
//     por texto, con la propuesta del sistema ("el pago valida la propuesta");
//   - los precios solo salen de quote_stay (o, fuera del horizonte, de la
//     tarifa ESTIMADA que devuelve la herramienta), nunca se calculan;
//   - LLAMADA REAL 2026-10-23 (voz_llamadas 8, 1-10 de enero): con
//     outside_direct_quote_horizon Cami dijo "no puedo mostrar disponibilidad"
//     e invento "a partir del 1 de diciembre ya puedo revisar fechas". Ahora
//     usa el mensaje de la herramienta (tarifa estimada + lista de espera), no
//     afirma fechas "desde" que no vengan de una herramienta y puede anotar en
//     la lista de espera (anotar_lista_espera, mismo mecanismo del chat);
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
const HERRAMIENTAS_COMERCIALES = new Set(['check_availability', 'quote_stay', 'enviar_opciones_al_chat', 'anotar_lista_espera']);

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
    description: 'Envía al chat de WhatsApp de esta persona, mientras siguen hablando, una ficha y las fotos de 1 a 3 apartamentos que check_availability dio como disponibles. Devuelve el orden en que le llegan (para "el primero", "el segundo").',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: { apartment_codes: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 3 } },
      required: ['apartment_codes'],
    },
  },
  {
    // Cami de voz = Cami de chat (José Manuel, 2026-10-23): fuera del horizonte
    // anota en la lista de espera con el MISMO mecanismo del chat (PMS).
    type: 'function',
    name: 'anotar_lista_espera',
    description: 'Anota a la persona en la lista de espera para unas fechas FUERA del horizonte (cuando check_availability o quote_stay devolvieron outside_direct_quote_horizon) y SOLO después de que la persona dijo que sí quiere. Sin pago ni compromiso. Devuelve el mensaje para confirmarlo.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: { arrival_date: FECHA, departure_date: FECHA, nights: { type: 'integer', minimum: 1 }, guests: { type: 'integer', minimum: 1 } },
      required: ['arrival_date'],
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
  if (nombre !== 'check_availability' && nombre !== 'quote_stay' && nombre !== 'anotar_lista_espera') return args;
  const llegada = fechaIso(args.arrival_date);
  const noches = entero(args.nights) ?? nochesEntre(llegada, fechaIso(args.departure_date));
  if (nombre === 'anotar_lista_espera') return { arrival_date: llegada, nights: noches, guests: entero(args.guests) };
  const base = { arrival_date: llegada, nights: noches, apartment_code: codigoApartamento(args.apartment_code) };
  return nombre === 'check_availability' ? { ...base, guests: entero(args.guests) } : base;
}

// Saludo (José Manuel, 2026-10-19): calido y alegre, paisa, corto. Sigue
// diciendo que es asistente virtual y que la llamada se transcribe (Ley 1581).
const PRESENTACION = '¡Hola! Qué bueno que llamas a Miu La Frontera. Te habla Cami, la asistente virtual. '
  + 'Te cuento que la llamada se transcribe para seguirte ayudando por el chat. ¿En qué te puedo ayudar?';

// La marca es Miu La Frontera (se pronuncia "miu"); fichas viejas pueden decir "Mío".
const corregirMarca = (t) => String(t ?? '').replace(/\bM[ií]o(?=\s+La\s+Frontera)/g, 'Miu');
// En voz: "el 510", nunca "LF-510".
function comoDecirlo(codigo) {
  const m = /^LF-(\d{3,4})$/.exec(String(codigo || ''));
  return m ? `el ${m[1]}` : String(codigo || '');
}

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
      ...(Array.isArray(u.destacados) ? u.destacados : [])].filter(Boolean).map(corregirMarca);
    return `- ${comoDecirlo(u.codigo)} (código ${u.codigo}): ${partes.join('; ') || 'sin ficha publicada'}`;
  });
  const edificio = Array.isArray(inventario.edificio) && inventario.edificio.length
    ? `Edificio: ${inventario.edificio.slice(0, 8).map(corregirMarca).join(' ')}` : null;
  return ['INVENTARIO PUBLICADO (lo único que puedes afirmar de las unidades; no hay otros tipos de unidad que estos):',
    ...lineas, edificio].filter(Boolean).join('\n').slice(0, 3500);
}

// La marca no es un nombre (llamada 2026-10-23: "Con gusto, Mío"; perfil
// "Mío La Frontera"). El filtro autoritativo es el del PMS (nombre-huesped.js,
// PALABRAS_NEGOCIO); esta es la misma lista como segunda barrera en la voz.
const PALABRAS_MARCA = new Set(['mio', 'miu', 'frontera', 'lofts', 'versadaa']);
const RELLENO_MARCA = new Set(['la', 'el', 'de', 'del']);
// Solo la primera palabra o el perfil entero ("Ana Frontera" sigue siendo nombre).
function esNombreDeMarca(nombre) {
  const palabras = String(nombre ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .split(/[^a-z]+/).filter(Boolean);
  if (!palabras.length) return false;
  return PALABRAS_MARCA.has(palabras[0]) || palabras.every((p) => PALABRAS_MARCA.has(p) || RELLENO_MARCA.has(p));
}

// ---------------------------------------------------------------------------
// PERFIL DE ALIADO (José Manuel, 2026-10-23; PMS migración 907): si quien llama
// es un aliado registrado, Cami NO cotiza: lo saluda por su nombre y conduce la
// entrevista de descubrimiento con la guía que manda el PMS (preguntas como
// datos, voz_guias_entrevista). La llamada la inicia el aliado.
// ---------------------------------------------------------------------------
const recortarTexto = (t, n) => { const s = String(t ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };

/** Contexto de aliado que llega del PMS, saneado (o null si no sirve). */
function aliadoDesdeInicio(x) {
  if (!x || x.perfil !== 'aliado' || x.no_cotizar !== true) return null;
  const g = x.guia && typeof x.guia === 'object' ? x.guia : null;
  const secciones = (Array.isArray(g?.secciones) ? g.secciones : []).slice(0, 10)
    .filter((sec) => sec && /^[a-z0-9_]{2,60}$/.test(String(sec.clave ?? '')))
    .map((sec) => ({ clave: sec.clave, titulo: recortarTexto(sec.titulo || sec.clave, 120),
      minutos: Number.isFinite(Number(sec.minutos)) ? Number(sec.minutos) : null, nota: sec.nota ? recortarTexto(sec.nota, 300) : null,
      preguntas: (Array.isArray(sec.preguntas) ? sec.preguntas : []).map((q) => recortarTexto(q, 400)).filter(Boolean).slice(0, 10) }));
  if (!secciones.length) return null;
  const lista = (xs, n, max) => (Array.isArray(xs) ? xs : []).map((v) => recortarTexto(v, max)).filter(Boolean).slice(0, n);
  return {
    aliadoId: Number(x.aliado_id) || null,
    nombre: x.nombre_saludo ? recortarTexto(x.nombre_saludo, 40) : null,
    entrevistaId: x.entrevista_id == null ? null : Number(x.entrevista_id),
    agendada: Boolean(x.entrevista_id),
    duracionMaxMin: Number(x.duracion_max_min) || null,
    guia: { clave: String(g.clave || ''), version: Number(g.version) || null, titulo: recortarTexto(g.titulo || '', 200),
      objetivo: g.objetivo ? recortarTexto(g.objetivo, 500) : null, principio: g.principio ? recortarTexto(g.principio, 300) : null,
      apertura: g.apertura ? recortarTexto(g.apertura, 400) : null, cierre: g.cierre ? recortarTexto(g.cierre, 400) : null,
      reglas: lista(g.reglas, 8, 300), secciones },
  };
}

function bloqueGuia(guia) {
  const l = [`GUÍA DE LA ENTREVISTA: ${guia.titulo || 'descubrimiento'}.`];
  if (guia.objetivo) l.push(`Objetivo (para ti, no lo leas tal cual): ${guia.objetivo}`);
  if (guia.principio) l.push(`Idea de fondo: ${guia.principio}`);
  if (guia.apertura) l.push(`Apertura: ${guia.apertura}`);
  guia.secciones.forEach((sec, i) => {
    l.push(`${i + 1}. ${sec.titulo}${sec.minutos ? ` (unos ${sec.minutos} min)` : ''}${sec.nota ? `. ${sec.nota}` : ''}`);
    for (const q of sec.preguntas) l.push(`   - ${q}`);
  });
  if (guia.cierre) l.push(`Cierre: ${guia.cierre}`);
  for (const r of guia.reglas) l.push(`- ${r}`);
  return l.join('\n').slice(0, 6000);
}

function instruccionesAliadoVoz({ hoy, aliado, duracionMaxMin }) {
  const nombre = aliado.nombre && !esNombreDeMarca(aliado.nombre) ? aliado.nombre : null;
  return [
    'Eres Cami, la asistente virtual con inteligencia artificial de Miu La Frontera (apartamentos amoblados en el edificio La Frontera, Medellín).',
    `Quien llama es una persona ALIADA de Miu (aliado o aliada)${nombre ? `: se llama ${nombre}; háblale por su nombre` : ''}. NO es un huésped ni un cliente que busca apartamento.`,
    aliado.agendada ? 'Llama para la entrevista que tenía agendada con Miu: es esta conversación.' : 'No tenía una entrevista agendada: si tiene tiempo ahora, conduce la entrevista; si no, pregúntale cuándo le queda bien y dile que José Manuel le escribe para agendar.',
    'PERSONALIDAD Y VOZ: cálida, alegre, positiva y curiosa, con la amabilidad paisa de Medellín y español colombiano natural. Escucha más de lo que hablas. Turnos MUY cortos: una o dos frases y UNA sola pregunta a la vez, sin listas ni símbolos. Reconoce lo que te cuenta con una frase breve antes de la siguiente pregunta.',
    'MARCA: se llama Miu La Frontera y se pronuncia "miu". Nunca digas "Mío".',
    `Fecha de hoy en Bogotá: ${hoy}.`,
    'Si la persona habla antes de que la saludes, en tu primera respuesta salúdala por su nombre, preséntate como la asistente virtual de Miu, di que la llamada se transcribe y sigue con la entrevista.',
    'REGLAS QUE NO SE ROMPEN:',
    '- NO cotices, no des precios de alojamiento, no ofrezcas apartamentos ni disponibilidad. Si pregunta por alojamiento, dile que con gusto se lo ven por el chat de WhatsApp y vuelve a la entrevista.',
    '- No prometas nada: ni precios, ni comisiones, ni plazos, ni servicios. Las opciones se exploran como ideas; José Manuel le propone después.',
    '- No pidas números de documento, cuentas, contraseñas ni datos personales de sus clientes.',
    '- Sigue la guía en orden, pero con naturalidad: si ya contestó algo, no lo vuelvas a preguntar; si una pregunta no aplica, sáltala. Si se va por las ramas, escúchala y vuelve con suavidad.',
    '- Si quiere parar o no tiene tiempo, respétalo: pregúntale cuándo puede seguir y dile que José Manuel le escribe.',
    '- Si pide hablar con alguien del equipo, tiene una queja o una emergencia, usa pedir_persona y dile que José Manuel le escribe por este chat.',
    '- AVISOS DEL CHAT: si recibes un mensaje que empieza por "AVISO DEL CHAT", es algo que la persona acaba de enviar al WhatsApp; úsalo con naturalidad y no leas datos de documentos ni comprobantes.',
    `- La llamada dura como máximo ${duracionMaxMin} minutos: administra el tiempo para llegar al cierre.`,
    bloqueGuia(aliado.guia),
    'DESPEDIDA: al terminar, resume en una frase lo que acordaron (siguiente paso y fecha), dile que José Manuel le escribe por el chat de WhatsApp, agradécele con cariño y usa terminar_llamada.',
  ].join('\n');
}

function instruccionesCamiVoz({ hoy, nombre = null, huespedAirbnb = false, personaAlMando = false, propietariaOnboarding = false, duracionMaxMin = 10, inventario = null, aliado = null }) {
  if (aliado) return instruccionesAliadoVoz({ hoy, aliado, duracionMaxMin });
  const comercial = !huespedAirbnb && !personaAlMando && !propietariaOnboarding;
  const lineas = [
    'Eres Cami, la asistente virtual con inteligencia artificial de Miu La Frontera: apartamentos amoblados para estadías en el edificio La Frontera, Medellín, Colombia.',
    'PERSONALIDAD Y VOZ: cálida, alegre, positiva y expresiva, con la amabilidad paisa de Medellín y español colombiano natural. Sonríe al hablar. Turnos MUY cortos: una o dos frases, una idea a la vez, sin listas ni símbolos. Si la persona habla otro idioma, contéstale en su idioma.',
    'MARCA: se llama Miu La Frontera y se pronuncia "miu". Nunca digas "Mío". No llames a la persona por el nombre de la marca: si no sabes su nombre, no uses ninguno.',
    `Fecha de hoy en Bogotá: ${hoy}. Resuelve fechas relativas ("el próximo mes", "el 15") contra esa fecha.`,
    'Si la persona habla antes de que la saludes, en tu primera respuesta salúdala y preséntate como la asistente virtual de Miu La Frontera, di que la llamada se transcribe y atiende lo que pidió.',
    'No tienes memoria de llamadas anteriores: no digas que algo "ya se envió antes" salvo que lo diga una herramienta en esta llamada.',
    'REGLAS QUE NO SE ROMPEN:',
    '- Nunca reservas, apartas, cobras ni das datos de pago o cuentas por teléfono.',
    '- Los precios SOLO salen de las herramientas: quote_stay o, fuera del horizonte, la tarifa_estimada que devuelven check_availability o quote_stay. Nunca calcules, redondees de más ni inventes un precio.',
    '- FECHAS FUERA DEL HORIZONTE (la herramienta devuelve outside_direct_quote_horizon): di el mensaje_para_el_huesped de la herramienta con tus palabras, sin cambiar cifras; aclara que la tarifa es ESTIMADA porque faltan meses y que la final se confirma más cerca de la llegada (puede tener revisión de precio); ofrece la lista de espera, sin pago ni compromiso. Si dice que sí, usa anotar_lista_espera con sus fechas y personas y confirma con lo que devuelva; si no quedó anotado, dile que el equipo se lo confirma por el chat de WhatsApp. Nunca digas que no hay disponibilidad ni que no puedes darle precio.',
    '- NUNCA afirmes una fecha "desde la cual" hay disponibilidad, se puede reservar o se abren fechas, salvo que venga literal de una herramienta. precios_revisados_hasta (o max_direct_quote_until) NO es una fecha desde la cual se abra algo: no la conviertas en "a partir del…".',
    '- Durante la llamada NO prometas enviar una cotización o propuesta escrita: no se envía ninguna mientras hablan. La cotización por escrito llega cuando la persona responde en el chat; dilo solo al despedirte.',
    '- Disponibilidad solo con check_availability. Si una unidad está libre pero no se vende por canal directo para esa duración, no digas que no hay disponibilidad.',
    '- Lo que afirmes de un apartamento o del edificio sale del INVENTARIO PUBLICADO de abajo o de get_public_apartment_attributes, get_policy o search_commercial_knowledge. Nunca inventes tipos de unidad (habitaciones, alcobas, tamaños) ni datos. Si un tema no tiene respuesta publicada, di que lo confirmas por el chat.',
    '- No prometas plazos, descuentos ni excepciones. Si la persona pide hablar con alguien, tiene una queja o una emergencia, usa pedir_persona y dile que José Manuel o el equipo le escribe por este chat.',
    '- Si la persona te dice que tiene o tuvo una reserva por Airbnb, no le ofrezcas reservar directo ni le des precios directos: ayúdala con su estadía y, para cambios o pagos de esa reserva, remítela a Airbnb.',
    '- No pidas números de documento, tarjetas ni contraseñas.',
    // CAMI LEE IMÁGENES (2026-10-23; paridad dominio 25): en llamada no hay
    // imágenes, pero si la persona manda una al chat mientras hablan, el
    // sistema le pasa a Cami un AVISO DEL CHAT con lo que se leyó.
    '- AVISOS DEL CHAT: si recibes un mensaje que empieza por "AVISO DEL CHAT", es algo que la persona acaba de enviar al WhatsApp mientras hablan. Úsalo con naturalidad (por ejemplo, las fechas o personas de un pantallazo) sin leerlo palabra por palabra. Si dice que es un documento de identidad o un comprobante, no le leas ni le pidas datos de él.',
    '- Al nombrar un apartamento di "el 510", "el 1109": nunca digas "LF" ni "ele efe".',
    '- No pidas confirmaciones innecesarias ("¿te parece bien?", "¿confirmamos las fechas?"): si ya tienes el dato, avanza.',
    `- La llamada dura como máximo ${duracionMaxMin} minutos.`,
  ];
  if (comercial) {
    lineas.push(
      'CÓMO ATENDER UNA BÚSQUEDA:',
      '- Pide solo lo que falte: fecha de llegada, fecha de salida o cuántas noches, y cuántas personas. NUNCA pidas código, tipo ni tamaño de apartamento: check_availability busca en todos.',
      '- Con fechas y personas, usa PRIMERO check_availability (en todos). No des precio si no lo preguntan; quote_stay solo si la persona pregunta el precio (y solo después de check_availability), y dilo en una frase.',
      '- Si hay disponibilidad, no leas códigos ni listas: di algo como "¡Tengo varias opciones para esas fechas! Ya te mando tres al WhatsApp para que las veas" y usa enviar_opciones_al_chat con hasta tres de las disponibles.',
      '- Después de enviarlas di UNA sola frase corta que diga EXACTAMENTE lo que devolvió la herramienta (enviadas_ahora y total_enviadas_ahora; nunca afirmes un número distinto) y quédate en silencio esperando a la persona. No repitas que las enviaste ni rellenes. Si no salió nada nuevo, no digas que enviaste fotos.',
      '- Cuando la persona hable de "el primero", "el segundo" o "el último", usa el orden que devolvió enviar_opciones_al_chat y contesta natural: "el 1109, el del ventanal…".',
      '- Si le queda incómodo hablar y mirar al tiempo, dile que puede colgar, mirar el chat y seguir por ahí escribiendo o con notas de voz, o volver a llamarte.',
    );
  }
  lineas.push(propietariaOnboarding
    ? 'DESPEDIDA: cuando se despida o no necesite nada más, despídete con alegría y dile que seguimos con sus preguntas por el chat de WhatsApp, a su ritmo. Luego usa terminar_llamada.'
    : 'DESPEDIDA: cuando la persona se despida o no necesite nada más, despídete con alegría y en una o dos frases dile que le dejas una nota en el chat y que puede responder ahí escribiendo o con una nota de voz (si quiere la cotización por escrito, se la envías por ahí), o volver a llamar. Luego usa terminar_llamada.',
  );
  if (nombre && !esNombreDeMarca(nombre)) lineas.push(`La persona se llama ${nombre}; puedes llamarla por su nombre.`);
  if (huespedAirbnb) {
    lineas.push('CONTEXTO: el sistema indica que esta persona es huésped de una reserva de Airbnb vigente o próxima. No le ofrezcas reservar directo ni precios directos. Ayúdala con su estadía (llegada, wifi, normas, problemas) y para cambios o pagos remítela a Airbnb.');
  }
  // ONBOARDING DE PROPIETARIAS (José Manuel, 2026-10-23; paridad dominio 25):
  // el PMS marca el número en /voz/llamada/inicio (propietaria_onboarding).
  if (propietariaOnboarding) {
    lineas.push('CONTEXTO: esta persona es PROPIETARIA de un apartamento de Miu Canal y está en su onboarding con Miu (no es huésped). Reconócela como propietaria y trátala con mucha calidez. NO cotices, no des precios, no ofrezcas apartamentos ni disponibilidad. Dile que sus preguntas del onboarding siguen por el chat de WhatsApp, a su ritmo, y que nada se cambia en su anuncio hasta que apruebe la propuesta por correo. Si pregunta algo, respóndele solo con lo publicado (search_commercial_knowledge o get_policy); si no está publicado o pide algo más, usa pedir_persona y dile que José Manuel le responde por el chat.');
  }
  if (personaAlMando) {
    lineas.push('CONTEXTO: una persona del equipo está atendiendo el caso de este cliente por chat. Escucha, toma nota de lo que necesita con pedir_persona y dile que le responden por este chat. No cotices ni ofrezcas nada nuevo.');
  }
  lineas.push(bloqueInventario(inventario));
  return lineas.join('\n');
}

// CAMI LEE IMÁGENES (2026-10-23): aviso que entra a la llamada cuando la persona
// manda una imagen al chat mientras habla con Cami. Misma guarda que el chat: de
// un documento de identidad o un comprobante no llega ningún dato, solo qué es.
function avisoImagenEnChat({ categoria, lectura = null } = {}) {
  const base = 'AVISO DEL CHAT: mientras hablan, la persona envió una imagen al WhatsApp.';
  if (categoria === 'solicitud' && lectura) return `${base} Lo que se lee en ella: ${String(lectura).slice(0, 700)}`;
  if (categoria === 'documento_identidad') return `${base} Parece un documento de identidad: no se leyó ni se guardó ningún dato de él. No le pidas ni le leas datos del documento; el registro se hace por el chat cuando corresponda.`;
  if (categoria === 'comprobante_pago') return `${base} Parece un comprobante de pago: lo revisa administración por el chat. No confirmes el pago por teléfono.`;
  return `${base} No trae datos de la reserva o no se pudo leer. Si viene al caso, pregúntale qué quería mostrarte.`;
}

function presentacionAliado(aliado) {
  const nombre = aliado?.nombre && !esNombreDeMarca(aliado.nombre) ? aliado.nombre : null;
  return `¡Hola${nombre ? `, ${nombre}` : ''}! Qué alegría que llamas. Te habla Cami, la asistente virtual de Miu La Frontera. `
    + 'Te cuento que la llamada se transcribe para que José Manuel tenga todo lo que hablemos. '
    + (aliado?.agendada ? '¿Empezamos con nuestra conversación?' : '¿Tienes unos minutos para conversar de tu negocio?');
}

function instruccionSaludo(aliado = null) {
  return `Saluda ahora con alegría, diciendo exactamente: "${aliado ? presentacionAliado(aliado) : PRESENTACION}"`;
}

function instruccionUltimoMinuto(aliado = null) {
  if (aliado) return 'Avísale con cariño que nos queda un minuto. Si aún no acordaron un siguiente paso y una fecha, acuérdalos ahora en una frase; agradécele y despídete.';
  return 'Avísale con cariño a la persona que la llamada termina en un minuto y que puede seguir por el chat de WhatsApp, escribiendo o con una nota de voz, o volver a llamar. Cierra la idea en curso.';
}

// Entrevista de aliado: a 5 minutos del final, ir hacia el cierre.
function instruccionCincoMinutos() {
  return 'Quedan unos cinco minutos de llamada. Sin decirlo de golpe, ve cerrando: si no han hablado de cómo la apoyamos, toca ese punto brevemente y luego acuerda el siguiente paso y una fecha.';
}

const NOMBRES_HERRAMIENTAS = new Set([...HERRAMIENTAS_PMS, ...HERRAMIENTAS_LOCALES.map((h) => h.name)]);

module.exports = { herramientasDeVoz, instruccionesCamiVoz, instruccionSaludo, avisoImagenEnChat, instruccionUltimoMinuto, instruccionCincoMinutos,
  aliadoDesdeInicio, presentacionAliado, bloqueGuia, PRESENTACION, HERRAMIENTAS_PMS,
  HERRAMIENTAS_COMERCIALES, NOMBRES_HERRAMIENTAS, normalizarArgsVoz, esNombreDeMarca, PALABRAS_MARCA, codigoApartamento, salidaDesde, bloqueInventario, comoDecirlo, corregirMarca };
