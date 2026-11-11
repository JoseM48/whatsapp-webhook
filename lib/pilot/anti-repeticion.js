'use strict';

// CAMI NO REPITE LO MISMO CUANDO NO LE ENTENDIERON (caso Walter, lead 368, 2026-11-11;
// GO de José Manuel al rediseño de comunicaciones, paquete 3 "se equivoca menos").
//
// Walter preguntó tres veces si el valor era por mes o por el año ("ok mes a mes cuanto
// tendria que pagar ??", "estoy hablando pagando mensual", "no el año") y Cami le mandó
// tres veces casi el mismo texto. La regla del lead 131 (m0-closed-pilot.js,
// textoCasiIgual) solo frena una repetición en ráfaga, cuando el huésped todavía no
// había visto el mensaje; aquí el huésped SÍ lo vio y no le sirvió.
//
// Funciones puras. Las usan el redactor (writer.js: regenerar o aclarar) y la prueba del
// examen (examen/afirmaciones.js: "no repite"). Mismo criterio en los dos lados.

const VACIAS = new Set(('de la el los las un una unos unas y o a en con por para que se te me mi tu tus su sus lo le les ' +
  'es son sera seria esta estan esto eso este ese al del como mas muy ya si no hay hoy aqui ahi cuando donde quien ' +
  'the a an and or of to in on for is are be it you your we our this that with').split(/\s+/));

function normalizar(texto) {
  return String(texto || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Palabras de contenido (3+ letras, sin vacías) y cifras completas ("3.100.000" -> "3100000"). */
function palabrasContenido(texto) {
  const crudo = String(texto || '');
  const cifras = (crudo.match(/\d[\d.,]*\d|\d/g) || []).map((c) => c.replace(/[.,]/g, ''));
  const palabras = normalizar(crudo.replace(/\d[\d.,]*\d|\d/g, ' ')).split(' ').filter((w) => w.length >= 3 && !VACIAS.has(w));
  return new Set([...palabras, ...cifras]);
}

/** Jaccard de palabras de contenido (0 a 1). */
function similitud(a, b) {
  const A = palabrasContenido(a), B = palabrasContenido(b);
  if (!A.size || !B.size) return 0;
  let comun = 0;
  for (const w of A) if (B.has(w)) comun += 1;
  return comun / (A.size + B.size - comun);
}

// Umbral medido con el caso Walter: sus tres respuestas repetidas dan 0,69 a 0,86 entre
// sí; una explicación distinta con la misma cifra queda por debajo de 0,45.
const UMBRAL_REPETIDO = 0.6;
// El texto fijo del sistema (respaldo) repite la misma estructura con otras palabras que las del
// redactor: frente a quien no entendió basta 0,45 (Walter: 0,51; respuestas distintas, < 0,42).
const UMBRAL_RESPALDO = 0.45;
/** El texto nuevo dice lo mismo que el anterior (aunque cambien algunas palabras). */
function casiDuplicado(anterior, nuevo, umbral = UMBRAL_REPETIDO) {
  const a = normalizar(anterior), b = normalizar(nuevo);
  if (!a || !b) return false;
  if (a === b) return true;
  // Textos muy cortos ("Con gusto"): solo cuenta si son iguales.
  if (palabrasContenido(anterior).size < 4 || palabrasContenido(nuevo).size < 4) return false;
  return similitud(anterior, nuevo) >= umbral;
}

// Señales de que la persona no entendió o corrige lo que Cami entendió.
const SENALES = [
  /\bno (te |le )?entiend/, /\bno entendi/, /\bno comprendo/, /\bno me (quedo|queda) claro/, /\bcomo asi\b/,
  /\bno es (lo que|eso)\b/, /\beso no (es|fue) lo que\b/, /\bte estoy preguntando\b/, /\bya te pregunte\b/, /\bestoy hablando\b/,
  /\bme refiero\b/, /\bno el ano\b/, /\bno por el ano\b/, /\bpero cuanto\b/, /\bsigo sin\b/, /\bno me respond/,
  /\bwhat do you mean\b/, /\bi (don t|do not) understand\b/, /\bthat s not what\b/, /\bi mean\b/
];
// Palabras del valor o del periodo: la duda del caso Walter (¿al mes o por el año?).
const PERIODO_O_VALOR = /\b(cuanto|cuantos|precio|valor|costo|cuesta|pagar|pago|pagando|mes|meses|mensual|mensuales|ano|anos|anual|total|noche|noches|semana|semanal|how much|price|month|monthly|year)\b/;
/** El mensaje de la persona señala que no entendió o que Cami no le respondió lo que preguntó. */
function senalConfusion(texto) {
  const crudo = String(texto || '');
  if (/^\s*[?¿]+\s*$/.test(crudo)) return true;
  const t = normalizar(crudo);
  if (!t) return false;
  // "??" insistiendo sobre el valor o el periodo (no un "Hola??" ni un "Disponible??").
  if (/\?\s*\?/.test(crudo) && PERIODO_O_VALOR.test(t)) return true;
  if (SENALES.some((re) => re.test(t))) return true;
  // Corrección corta del periodo o del valor: "no, mensual", "no el año", "no, por mes".
  return /^no\b/.test(t) && t.split(' ').length <= 4 && PERIODO_O_VALOR.test(t);
}

/** Mensajes de Cami más recientes del transcript (lo último primero). */
function ultimasDeCami(transcript = [], n = 2) {
  return (Array.isArray(transcript) ? transcript : []).filter((t) => t && t.role !== 'guest' && t.role !== 'human' && String(t.text || '').trim())
    .slice(-n).reverse().map((t) => String(t.text));
}

const CORTESIAS = new Set(['gracias', 'muchas gracias', 'ok', 'okay', 'listo', 'si', 'no', 'vale', 'perfecto', 'dale', 'hola', 'buenas', 'bueno',
  'buenos dias', 'buenas tardes', 'buenas noches', 'hola buenas', 'hola buenos dias', 'hola buenas tardes', 'thanks', 'thank you', 'yes']);
/** La persona repite (casi igual) algo que ya había preguntado en sus últimos mensajes. */
function repitePregunta(texto, transcript = []) {
  const previos = (Array.isArray(transcript) ? transcript : []).filter((t) => t && t.role === 'guest').slice(-4).map((t) => String(t.text || ''));
  const actual = String(texto || '');
  const n = normalizar(actual);
  // Igual a algo que ya escribió ("Por mes" dos veces), salvo cortesías ("gracias", "ok").
  // Un número suelto ("1") es una elección de un menú, no una repregunta.
  if (!n || n.length < 3 || /^\d+$/.test(n) || CORTESIAS.has(n)) return false;
  if (previos.some((p) => normalizar(p) === n)) return true;
  if (palabrasContenido(actual).size < 2) return false;
  return previos.some((p) => palabrasContenido(p).size >= 2 && similitud(p, actual) >= 0.7);
}

/** Estado del turno para el redactor: si la persona no entendió y cuál fue lo último que dijo Cami. */
function estadoRepeticion({ guestText, transcript }) {
  const previas = ultimasDeCami(transcript, 2);
  const confundida = senalConfusion(guestText) || repitePregunta(guestText, transcript);
  return { confundida, previas, ultima: previas[0] || null };
}

/** El texto repite alguno de los últimos mensajes de Cami. */
function repiteAnterior(texto, previas = [], umbral = UMBRAL_REPETIDO) {
  return previas.some((p) => casiDuplicado(p, texto, umbral));
}

// Lo que la persona YA leyó en el último mensaje no se le exige al redactor otra vez cuando no
// entendió (caso Walter: el paquete pedía de nuevo fechas, "tarifa de referencia" y "lista de
// espera", y el validador rechazaba toda explicación corta, así que salía otra vez el mismo
// texto). Solo se relajan las OBLIGACIONES de decir algo (required_facts con patrones que ya se
// cumplen en ese mensaje, y fechas que ya están en él); los permisos de cifras, fechas y
// apartamentos no cambian: el validador del PMS sigue siendo la última palabra.
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
function fechaEnTexto(texto, formatted) {
  const t = normalizar(texto);
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(formatted || ''));
  if (!iso) return Boolean(formatted) && t.includes(normalizar(formatted));
  const dia = Number(iso[3]), mes = MESES[Number(iso[2]) - 1];
  return String(texto || '').includes(formatted) || new RegExp(`(?:^| )${dia} de ${mes}(?: |$)`).test(t);
}
function paqueteSinLoYaDicho(packet, ultima) {
  if (!packet || !ultima) return packet;
  const yaDicho = (f) => {
    const patrones = (f?.patterns || []).map((src) => { try { return new RegExp(src, 'i'); } catch { return null; } }).filter(Boolean);
    return patrones.length > 0 && patrones.some((re) => re.test(String(ultima)));
  };
  return { ...packet,
    required_facts: (packet.required_facts || []).filter((f) => !yaDicho(f)),
    dates: (packet.dates || []).map((d) => (d && d.required !== false && fechaEnTexto(ultima, d.formatted) ? { ...d, required: false } : d)) };
}

// Último recurso cuando ni el redactor ni el texto del sistema salen distintos: una
// pregunta con opciones, sin cifras ni promesas (José Manuel, 2026-11-11: no reenviar lo mismo).
const TEXTO_ACLARAR = {
  es: 'Perdona, creo que no me expliqué bien. ¿Qué parte te aclaro: cuánto pagas y cada cuánto, las fechas o cómo se reserva?',
  en: "Sorry, I don't think I explained it well. What should I clarify: how much you pay and how often, the dates, or how to book?"
};
// Hechos que acompañan una cifra (qué es ese valor): si la respuesta trae una cifra, se exigen
// aunque ya se hayan dicho (revisión independiente 2026-11-11, P2).
const CALIFICA_CIFRA = /(reference|referencia|no_real_money|anticipo|deposit|sin_bloqueo|poliza|policy|separacion|tarifa|price|precio|oferta)/i;
const TIENE_CIFRA = /(?:\$|cop)\s?\d|\b\d{1,3}(?:[.,]\d{3})+\b/i;
/** Paquete con el que se valida: el relajado, salvo los hechos que califican una cifra si el texto trae cifras. */
function paqueteParaValidar(original, relajado, texto) {
  if (!relajado || relajado === original || !TIENE_CIFRA.test(String(texto || ''))) return relajado;
  const ids = new Set((relajado.required_facts || []).map((f) => f.id));
  const vuelven = (original.required_facts || []).filter((f) => !ids.has(f.id) && CALIFICA_CIFRA.test(String(f.id || '')));
  return vuelven.length ? { ...relajado, required_facts: [...(relajado.required_facts || []), ...vuelven] } : relajado;
}
function textoAclarar(idioma) { return idioma === 'en' ? TEXTO_ACLARAR.en : TEXTO_ACLARAR.es; }

module.exports = { normalizar, palabrasContenido, similitud, casiDuplicado, senalConfusion, ultimasDeCami, repitePregunta,
  estadoRepeticion, repiteAnterior, textoAclarar, TEXTO_ACLARAR, UMBRAL_REPETIDO, paqueteSinLoYaDicho, fechaEnTexto, UMBRAL_RESPALDO, paqueteParaValidar };
