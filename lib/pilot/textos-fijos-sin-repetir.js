'use strict';

// PORTE DEL PMS (src/modules/supervised-pilot/textos-fijos-sin-repetir.js, misma regla y mismas listas).
// En el webhook se aplica a la respuesta de Cami DESPUÉS del redactor (chat y notas de voz), nunca a un
// texto fijo aprobado palabra por palabra. Si cambias una lista, cámbiala en los dos repos.
//
// TEXTOS FIJOS SIN REPETIR (José Manuel, 2026-11-12: "se repitió" es el error dominante del juez de
// calidad: 18 a 30 % de las conversaciones por semana desde el 12-oct).
//
// Medido en producción (calidad_juez_conversaciones, 3 semanas al 2026-11-12): casi todas las
// repeticiones son TEXTO DEL SISTEMA, no del modelo. El grupo más grande son las condiciones que
// viajan pegadas a cada cotización ("Valor fijo durante tu estadía...", "Si cancelas o no llegas...",
// "El día de tu llegada... pagas el primer mes...", "Precio de lanzamiento..."): cada recotización
// de Cami, cada rescate de 20 h y cada oferta de lista de espera las vuelve a pegar completas.
// Le siguen las frases fijas de "pedir fechas", "lo consulto con el equipo" y similares.
//
// Regla (la aplica queue(), único punto de escritura del outbox al huésped, así cubre chat, notas
// de voz y el WhatsApp de seguimiento de una llamada):
//   - una CONDICIÓN que ya salió IDÉNTICA a esta conversación en las últimas 24 h no se repite;
//     en su lugar va una sola frase corta ("Las demás condiciones son las mismas que te conté.").
//     No cambia ningún precio ni ninguna condición: solo no se repite la misma frase;
//   - una FRASE FIJA con variantes (pedir fechas, consulta al equipo...) que ya salió en 24 h se
//     cambia por una variante que no haya salido; si ya salieron todas, una frase que no pide nada
//     se quita y una pregunta se deja (mejor repetir la pregunta que dejar al huésped sin paso);
//   - las líneas de precio ("LF-210: $3.000.000 al mes · 30 noches", "Precio de lanzamiento: ...") y las opciones de un menú
//     nunca se tocan;
//   - si al quitar no queda ninguna frase con contenido (solo "Gracias."), sale el texto original.
// Funciones puras: el servicio les pasa los textos ya enviados (sin los del mismo evento, para que
// un reintento del mismo turno produzca exactamente el mismo texto).
// Copia de frasesDe del juez del PMS (src/modules/calidad/calidad-reglas.js): misma compactación.
const normalizar = (t) => String(t ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
const compactar = (t) => normalizar(t).replace(/[^a-z0-9ñ ]+/g, " ").replace(/\s+/g, " ").trim();
const OPCION_MENU_JUEZ = /^\s*(\d{1,2}\s*[.)\-:]|[•\-*·]|\d️?⃣)/;
function frasesDe(texto) {
  const frases = [];
  for (const linea of String(texto ?? "").split(/\n+/)) {
    if (OPCION_MENU_JUEZ.test(linea)) continue;
    for (const crudo of linea.split(/(?<=[.!?])\s+/)) {
      const c = compactar(crudo);
      if (c.length >= 20 && c.split(" ").length >= 4) frases.push({ clave: c, original: crudo.trim() });
    }
  }
  return frases;
}

const VENTANA_TEXTO_FIJO_MS = 24 * 60 * 60 * 1000;

// Misma compactación que el juez (calidad-reglas.js), para que lo que aquí se evita sea lo que allá se mide.
const clave = (t) => (frasesDe(t)[0]?.clave ?? null);
const OPCION_MENU = /^\s*(\d{1,2}\s*[.)\-:]|[•\-*·]|\d️?⃣)/;
// Línea de precio o de grupo de precios: nunca se quita (es lo que la persona está pidiendo ver).
const LINEA_PRECIO = /^(lf \d{3,4} |estos (dos|tres|cuatro|\d+) apartaestudios tienen el mismo valor|miu flex |precio de lanzamiento)/;

// Condiciones de pago, cancelación y alcance del precio. Se comparan por la frase completa (con su
// cifra): solo se quita si salió IGUAL; otra cifra u otra condición sí sale.
const CONDICION = /(valor fijo durante tu estadia|no son reembolsables?|no es reembolsable|pagas (el|un|una|la) (primer|valor|anticipo|confirmacion|deposito|separacion)|pagas el valor completo|para separar pagas|para reservar no pagas nada|te la dejamos pre ?confirmada|no pagas nada ni te comprometes|se requiere poliza de arrendamiento|es una tarifa de referencia|todavia no hay dinero real|se te devuelve al check out|se descuenta de tu primer mes|queda como deposito)/;

// TEO-COLA #66 (2026-11-12): tras este filtro el simulador de Cami bajó de 3,25 a 2,58 con más
// "sin siguiente paso" y "no respondió". Tres guardas, sin quitar lo bueno:
//   - una condición que además es el SIGUIENTE PASO (una pregunta, o la oferta "Si te suena, te anoto en
//     la lista de espera: no pagas nada...") no se quita: quitarla deja el mensaje sin paso;
//   - si el huésped PREGUNTA en este turno por pagos, depósito, cancelación o cómo reservar, las
//     condiciones son la respuesta y salen completas aunque ya se hayan dicho;
//   - una frase fija cuyas variantes ya salieron todas se deja (mejor repetir que dejar al huésped sin
//     saber qué sigue); solo una cortesía pura (`cortesia`) se quita.
const ES_PASO = /\?|\b(te anoto|si te suena|si te gusta|si te sirve|si quieres|te parece|me confirmas|me dices|me cuentas)\b/i;
const PIDE_CONDICIONES = /(pag[oaeu]|abon|dep[oó]sit|anticip|separ|reserv|cancel|reembols|devuel|devoluci|condicion|p[oó]liza|confirmaci|wompi|transferencia|consign|garant[ií]a|como funciona|c[oó]mo es el proceso)/i;

// Frase corta que reemplaza las condiciones ya dichas. Tres variantes para que tampoco ella se repita.
const REMITE_CONDICIONES = Object.freeze([
  "Las demás condiciones son las mismas que te conté antes.",
  "Las condiciones de pago no cambian: son las mismas que ya te compartí.",
  "Lo demás queda igual a lo que te expliqué hace un rato."
]);

// Frases fijas con variantes. `clave` = frase compactada exacta; `cortesia`: si se acaban las
// variantes, se quita (no dice qué sigue). Las demás se dejan: son el paso o la pregunta del mensaje.
const V = (frase, variantes, cortesia = false) => ({ clave: clave(frase), variantes, cortesia });
const VARIANTES_FIJAS = Object.freeze([
  V("¿Qué fechas necesitas y para cuántas personas?", [
    "Para cotizarte, dime la fecha de llegada, la de salida (o cuántas noches) y cuántas personas serían; por ejemplo: «del 5 al 20 de diciembre, 2 personas».",
    "¿Me compartes al menos el mes en que llegarías y cuántas personas serían? Con eso te busco opciones."]),
  V("What dates do you need and for how many people?", [
    "To quote, tell me your check-in date, check-out date (or number of nights) and how many people; for example: “December 5 to 20, 2 people”.",
    "Could you share at least the month you would arrive and how many people? With that I can look for options."]),
  V("¿Qué fecha de llegada tienes prevista?", ["¿Para qué día tendrías pensada la llegada?"]),
  V("¿Quieres que te anote en la lista de espera?", ["¿Te anoto en la lista de espera para avisarte si se libera algo?"]),
  V("Eso lo tengo que consultar primero con el equipo, porque necesita una revisión o un permiso especial.", [
    "Esto también lo reviso con el equipo, porque necesita una revisión o un permiso especial."]),
  V("Te confirmo por aquí apenas lo revisen.", ["Apenas me respondan, te escribo por aquí."]),
  V("José Manuel revisará personalmente la solicitud y te responderemos por aquí.", [
    "José Manuel la revisa personalmente; la respuesta te llega por este chat."]),
  V("José Manuel revisará personalmente tu solicitud y te responderemos por aquí.", [
    "José Manuel la revisa personalmente; la respuesta te llega por este chat."]),
  V("Esa pregunta se la paso al equipo para darte la respuesta exacta.", [
    "También le paso esa pregunta al equipo, para responderte con exactitud."]),
  V("Te escriben por aquí apenas puedan 😊", ["El equipo ya tiene tu mensaje y te escribe por aquí."]),
  V("Gracias, ya le pasé esto a nuestro equipo.", ["El equipo ya tiene esto en sus manos."]),
  V("Aquí estoy si necesitas algo de tu estadía.", ["Cualquier cosa de tu estadía, me escribes por aquí."]),
  V("Si te queda alguna duda, escríbeme por aquí y te ayudo.", ["Cualquier duda que te quede, me cuentas por aquí."]),
  V("Gracias por llamar a Miu La Frontera.", ["Gracias de nuevo por tu llamada."], true),
  V("Puedes elegir la que prefieras cuando quieras.", ["Cuando decidas cuál te gusta, me cuentas."])
].filter((x) => x.clave));
const MARCA_REMITE = "\u0000REMITE\u0000";
const VARIANTE_POR_CLAVE = new Map(VARIANTES_FIJAS.map((x) => [x.clave, x]));

/** Claves de frases (como las cuenta el juez) de los textos ya enviados. */
function clavesEnviadas(previos = []) {
  const s = new Set();
  for (const p of previos) for (const f of frasesDe(p)) s.add(f.clave);
  return s;
}

/**
 * Quita o cambia las frases fijas que ya salieron a esta conversación en 24 h.
 * `previos`: textos al huésped ya enviados en la ventana (sin los del mismo evento).
 * `opciones.mensajeHuesped`: lo que el huésped escribió en este turno (si pregunta por pagos o
 * condiciones, las condiciones no se quitan).
 * Devuelve { texto, cambios: [{tipo:'condicion'|'variante'|'quitada', frase}] }.
 */
function sinTextosFijosRepetidos(texto, previos = [], opciones = {}) {
  const original = String(texto ?? "");
  const pideCondiciones = PIDE_CONDICIONES.test(normalizar(opciones?.mensajeHuesped ?? ""));
  if (!original.trim() || !previos.length) return { texto: original, cambios: [] };
  const vistas = clavesEnviadas(previos);
  const usadas = new Set();
  const cambios = [];
  const lineas = original.split("\n").map((linea) => {
    if (!linea.trim() || OPCION_MENU.test(linea)) return linea;
    const partes = linea.split(/(?<=[.!?])\s+/);
    const salen = [];
    for (const crudo of partes) {
      const k = clave(crudo);
      if (!k || LINEA_PRECIO.test(k) || !vistas.has(k)) { salen.push(crudo); if (k) usadas.add(k); continue; }
      if (CONDICION.test(k) && !pideCondiciones && !ES_PASO.test(crudo)) {
        // La frase que remite va donde estaba la primera condición quitada (no después de la pregunta final).
        if (!cambios.some((c) => c.tipo === "condicion")) salen.push(MARCA_REMITE);
        cambios.push({ tipo: "condicion", frase: crudo.trim() });
        continue;
      }
      const v = VARIANTE_POR_CLAVE.get(k);
      if (!v) { salen.push(crudo); continue; }
      const alt = v.variantes.find((x) => { const kx = clave(x); return kx && !vistas.has(kx) && !usadas.has(kx); });
      if (alt) { cambios.push({ tipo: "variante", frase: crudo.trim() }); usadas.add(clave(alt)); salen.push(alt); continue; }
      if (!v.cortesia) { salen.push(crudo); continue; }
      cambios.push({ tipo: "quitada", frase: crudo.trim() });
    }
    // Una línea que quedó vacía por lo quitado desaparece (las líneas en blanco originales se quedan).
    return salen.length ? salen.join(" ").trimEnd() : null;
  });
  if (!cambios.length) return { texto: original, cambios };
  const remite = REMITE_CONDICIONES.find((r) => !vistas.has(clave(r))) ?? "";
  let resultado = lineas.filter((l) => l !== null).join("\n").split(MARCA_REMITE).join(remite);
  // Líneas que quedaron vacías: se colapsan (nunca más de una línea en blanco seguida).
  resultado = resultado.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  // Si solo queda la frase que remite (o nada), mejor el original que un mensaje vacío.
  const sinRemite = REMITE_CONDICIONES.reduce((acc, r) => acc.replace(r, ""), resultado).trim();
  // Lo mismo si solo queda una cortesía ("Gracias."): sin ninguna frase con contenido no se manda.
  if (!sinRemite || !frasesDe(sinRemite).length) return { texto: original, cambios: [] };
  return { texto: resultado, cambios };
}

// Lo que Cami (no una persona) mandó a la conversación en las 24 h anteriores, del transcript que el
// PMS entrega con el turno. Se excluyen los resúmenes de llamadas (no son texto enviado) y los turnos sin fecha.
function textosDeCamiEn24h(transcript = [], ahora = Date.now()) {
  return (Array.isArray(transcript) ? transcript : []).filter((t) => {
    if (!t || t.role !== 'cami' || !t.text) return false;
    if (/^\[Llamada de WhatsApp/.test(String(t.text))) return false;
    const at = new Date(t.at || 0).getTime();
    return at > 0 && ahora - at >= 0 && ahora - at < VENTANA_TEXTO_FIJO_MS;
  }).map((t) => String(t.text));
}

module.exports = { textosDeCamiEn24h, sinTextosFijosRepetidos, clavesEnviadas, frasesDe, REMITE_CONDICIONES, VARIANTES_FIJAS, VENTANA_TEXTO_FIJO_MS };
