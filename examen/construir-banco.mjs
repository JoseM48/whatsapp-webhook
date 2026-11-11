// Construye examen/banco-oro.json desde las extracciones de producción (solo lectura; consultas en
// examen/README.md). Uso: EXAMEN_PMS_DIR=<checkout del PMS> EXAMEN_RAW_DIR=<carpeta con raw-*.json>
//   node examen/construir-banco.mjs examen/banco-oro.json
// Los raw-*.json NO se versionan (traen la conversación sin anonimizar).
// Anonimiza: redactPii del PMS (teléfonos, documentos, correos, cuentas) + nombres -> solo el primer nombre.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const PMS = process.env.EXAMEN_PMS_DIR || "../pms-lite";
const { redactPii } = await import(pathToFileURL(path.join(PMS, "src/modules/agent-gateway/pii-redaction.js")).href);
const AQUI = process.env.EXAMEN_RAW_DIR || ".";
const leer = (f) => JSON.parse(fs.readFileSync(path.join(AQUI, f), "utf8"))[0].json_agg;
const filas = [...leer("raw-cami.json"), ...leer("raw-amplio.json")];

// Apellidos y nombres propios fuera de la lista de leads que aparecen en textos.
// Apellidos y datos privados que no están en leads (p. ej. de prospectos): lista LOCAL, no versionada.
// EXAMEN_PRIVADO=<archivo .json con [["texto", "reemplazo"], ...]>
const EXTRA = process.env.EXAMEN_PRIVADO ? JSON.parse(fs.readFileSync(process.env.EXAMEN_PRIVADO, "utf8")) : [];
function anonimo(texto, nombres) {
  let t = redactPii(String(texto ?? ""));
  for (const n of nombres) {
    const partes = String(n || "").trim().split(/\s+/).filter(Boolean);
    for (const ap of partes.slice(1)) if (ap.length >= 3) t = t.replace(new RegExp(`\\b${ap.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g"), "").replace(/ {2,}/g, " ");
  }
  for (const [a, b] of EXTRA) t = t.split(a).join(b);
  return t.replace(/ +([,.!?])/g, "$1");
}
function anonimoProfundo(v, nombres) {
  if (typeof v === "string") return anonimo(v, nombres);
  if (Array.isArray(v)) return v.map((x) => anonimoProfundo(x, nombres));
  if (v && typeof v === "object") {
    const o = {};
    for (const [k, x] of Object.entries(v)) {
      if (["phone", "phone_hash", "telefono", "lead_id", "case_id", "email"].includes(k)) continue;
      o[k] = k === "guest_name" && typeof x === "string" ? x.trim().split(/\s+/)[0] : anonimoProfundo(x, nombres);
    }
    return o;
  }
  return v;
}

// ---------------------------------------------------------------------------
// Afirmaciones por caso. Las comunes (sin_cifras_inventadas, no_mecanica_interna y
// no_repite) se agregan a todos los casos de Cami salvo que el caso diga lo contrario.
// ---------------------------------------------------------------------------
const PREG = { pregunta: true };
const A = {
  // Firma no_sabia:other (7 registros; 12 turnos reales con el tema "other").
  3429: { g: "error:no_sabia:other", a: { contiene_alguno: ["prorroga", "extender", "ampliar", "renovar"] } },
  3604: { g: "error:no_sabia:other", a: { idioma: "en", espera: true } },
  3656: { g: "error:no_sabia:other", a: { contiene_alguno: ["netflix", "smart tv", "chromecast"] } },
  3843: { g: "error:no_sabia:other", a: { espera: true } },
  4595: { g: "error:no_sabia:other", a: { contiene_alguno: ["cedula", "pasaporte", "identificacion"] } },
  4653: { g: "error:no_sabia:other", a: { espera: true } },
  4951: { g: "error:no_sabia:other", a: { contiene_alguno: ["laureles"], contiene_alguno_2: ["poblado"] } },
  5152: { g: "error:no_sabia:other", a: { no_contiene: ["no quedo registrada una reserva", "no es una reserva", "no tienes reserva", "no tienes una reserva"] },
    nota: "Nunca negar la reserva: puede estar por Airbnb u otro número (validador niega_reserva)." },
  5153: { g: "error:no_sabia:other", a: { no_contiene: ["tampoco es una reserva", "no es una reserva", "no tienes reserva"] },
    nota: "Nunca negar la reserva." },
  5499: { g: "error:no_sabia:other", a: { idioma: "en", contiene_alguno: ["cami", "virtual", "assistant"], no_espera: true },
    pendiente: "Arreglo en el PMS (tema 'identidad' sin brecha): el paquete grabado es el de antes del arreglo y aún exige el aviso de brecha. Lo cubre la prueba del PMS temas-conocimiento.test.js." },
  5609: { g: "error:no_sabia:other", a: { contiene_alguno: ["cedula", "pasaporte"] },
    pendiente: "El validador del PMS frena la mención de la oferta de lanzamiento como excepción aprobada y sale el texto de brecha. Revisar el paquete o el validador (PMS)." },
  5838: { g: "error:no_sabia:other / juan", a: { no_espera: true },
    pendiente: "Brecha de PMS: 'Por favor' con tema 'other' y una consulta abierta. El paquete grabado exige el aviso de brecha; se corrige en el PMS (ver informe)." },
  // Juan (lead 192): "¿cuánto debo?"
  5836: { g: "juan", a: { no_contiene: ["buscas alojamiento", "quieres hacer una pregunta sobre alguno de nuestros apartamentos"] },
    pendiente: "Decisión del PMS (huésped en estadía recibe la pregunta genérica de alojamiento)." },
  5837: { g: "juan", a: { no_cotiza: true } },
  // Owner de finca (lead 334) -> propietario, no huésped.
  4768: { g: "astrid/propietarios", a: { no_contiene: ["que fechas necesitas"] },
    pendiente: "Ruteo de propietario en el PMS (primer contacto): el paquete pide fechas." },
  4769: { g: "astrid/propietarios", a: { contiene_alguno: ["colaboracion", "propietari", "ofreciendo", "ofrecer", "administr", "alquil"], no_cotiza: true } },
  4786: { g: "astrid/propietarios", a: { no_cotiza: true } },
  // Astrid (lead 359)
  5468: { g: "astrid/propietarios", a: { responde: true, no_contiene: ["que fecha de llegada"] },
    nota: "En producción no salió nada (respuesta anulada)." },
  5469: { g: "astrid/propietarios", a: { no_contiene: ["que fechas necesitas", "que fecha de llegada"], contiene_alguno: ["astrid"] },
    pendiente: "Decisión del PMS (CLARIFICAR pide fechas a quien solo dio su nombre); el redactor sigue el paquete." },
  // Nick (lead 285): perro + disponibilidad
  5496: { g: "nick", a: { idioma: "en", contiene_alguno: ["30 nights", "30 or more", "30+"] } },
  5497: { g: "nick", a: { contiene_alguno: ["1109"] } },
  5498: { g: "nick", a: { contiene_alguno: ["30 noches"], no_contiene: ["si puedes llevar", "si puedes traer"] } },
  // Lead 357: bucle de confirmación de fechas
  5360: { g: "fechas", a: { ...PREG, no_contiene: ["1 de enero", "2027-01-01"] }, nota: "No proponer un día que el huésped no dijo.",
    pendiente: "Decisión del PMS: interpretó \"enero\" como el 1 de enero y pide confirmarlo (CONFIRMAR DATO). El redactor no puede quitar la fecha obligatoria." },
  5367: { g: "fechas", a: { no_contiene: ["2027-01-01", "1 de enero"] }, nota: "Bucle: volvía a confirmar el 1 de enero, que el huésped nunca dijo.",
    pendiente: "Decisión del PMS: vuelve a pedir confirmar el 1 de enero (CONFIRMAR DATO). Bucle de confirmación de fechas, del lado del PMS." },
  5369: { g: "fechas", a: { contiene_alguno: ["18 de enero"] } },
  5370: { g: "fechas", a: { contiene_alguno: ["15 de enero"] } },
  5852: { g: "fechas", a: { contiene_alguno: ["visita"] } },
  5853: { g: "fechas", a: { contiene_alguno: ["check-in", "llegada", "3:00"] } },
  5855: { g: "fechas", a: { no_cotiza: true } },
  // Lead 295: "Por mes" repetido (firma no_sabia:h4219014785: misma pregunta 2 veces)
  5760: { g: "error:no_sabia:h4219014785", a: { contiene_alguno: ["cedula", "pasaporte"] } },
  5763: { g: "mensual_vs_total", a: { periodo_claro: true } },
  5774: { g: "error:no_sabia:h4219014785", a: { ...PREG } },
  5775: { g: "error:no_sabia:h4219014785", a: { ...PREG } },
  5777: { g: "error:no_sabia:h4219014785", a: { ...PREG } },
  // Walter (lead 368)
  5753: { g: "walter", a: { contiene_alguno: ["ayudar", "ayudo"], no_contiene: ["que fechas necesitas"] } },
  5754: { g: "walter", a: { ...PREG } },
  5756: { g: "walter", a: { ...PREG } },
  5761: { g: "walter", a: { ...PREG } },
  5762: { g: "walter / error:no_sabia:h4219014785", a: { ...PREG } },
  5764: { g: "walter", a: {} },
  5765: { g: "walter", a: { ...PREG } },
  5766: { g: "walter", a: { ...PREG } },
  5769: { g: "walter", a: { ...PREG, no_contiene: ["1 de febrero"] } },
  5770: { g: "walter / mensual_vs_total", a: { periodo_claro: true, contiene_alguno: ["al mes", "mensual", "cada mes"] } },
  5771: { g: "walter", a: { responde: true }, nota: "En producción la respuesta quedó anulada (defecto 1.5 del diagnóstico): el cliente no recibió nada." },
  5791: { g: "walter / mensual_vs_total", a: { periodo_claro: true, contiene_alguno: ["cada mes", "al mes", "mensual", "mes a mes"] } },
  5794: { g: "walter / mensual_vs_total", a: { contiene_alguno: ["cada mes", "mes a mes", "mensual"],
    contiene_alguno_2: ["no pagas el ano", "no tienes que pagar el ano", "no el ano", "no es el valor del ano", "no es por el ano", "por adelantado", "no es anual", "no pagas todo el ano", "no es el total del ano", "no se paga el ano", "de una sola vez", "de una vez", "no todo el ano", "no el ano completo", "no tienes que pagarlo completo", "no pagarias el ano", "no pagarias los"] },
    nota: "El huésped no entendió si el valor era por mes o por el año: hay que decirlo explícito." },
  5795: { g: "walter / mensual_vs_total", a: { contiene_alguno: ["cada mes", "mes a mes", "mensual", "al mes"],
    contiene_alguno_2: ["no pagas el ano", "no tienes que pagar el ano", "no el ano", "no es el valor del ano", "no es por el ano", "por adelantado", "no es anual", "no pagas todo el ano", "no es el total del ano", "no se paga el ano", "de una sola vez", "de una vez", "no todo el ano", "no el ano completo", "no tienes que pagarlo completo", "no pagarias el ano", "no pagarias los"] } },
  5859: { g: "walter / mensual_vs_total", a: { periodo_claro: true } },
  5861: { g: "walter", a: { ...PREG, no_contiene: ["descuento"] } },
  5862: { g: "walter", a: { no_contiene: ["descuento"] } },
  5863: { g: "walter", a: {} },
  // Muestra amplia (una acción distinta por caso)
  4379: { g: "amplio", a: { ...PREG, no_contiene: ["descuento"] } },
  4648: { g: "amplio", a: { no_cotiza: true } },
  4748: { g: "amplio", a: {} },
  4842: { g: "amplio", a: { ...PREG, no_contiene: ["descuento"] } },
  4894: { g: "amplio", a: { contiene_alguno: ["lista de espera", "lo mas pronto", "mas pronto"] } },
  5352: { g: "amplio", a: { no_contiene: ["descuento"] } },
  5353: { g: "amplio", a: { contiene_alguno: ["30 noches", "un mes"] } },
  5474: { g: "amplio", a: { contiene_alguno: ["1109"] } },
  5480: { g: "amplio", a: {} },
  5531: { g: "amplio", a: { no_contiene: ["reserva confirmada", "quedo confirmada", "ya esta confirmada"] } },
  5532: { g: "amplio", a: {} },
  5544: { g: "amplio", a: { ...PREG } },
  5571: { g: "amplio", a: { contiene_alguno: ["poblado"] } },
  5588: { g: "fechas", a: { ...PREG } },
  5604: { g: "amplio", a: {} },
  5665: { g: "mensual_vs_total", a: { periodo_claro: true } },
  5705: { g: "amplio", a: { ...PREG } },
  5846: { g: "amplio", a: { no_cotiza: true } }
};

const casos = [];
for (const f of filas) {
  const def = A[f.event_id];
  if (!def) throw new Error(`sin anotación: ${f.event_id}`);
  const nombres = [f.nombre].filter(Boolean);
  const antes = (f.antes || []).map((x) => ({ r: x.r, t: anonimo(x.t, nombres) })).filter((x) => x.t && !/^\[M0_[A-Z_]+:/.test(x.t) || x.r === "guest");
  const real = (f.real || []).filter((r) => r.status === "submitted" && ["text", "buttons"].includes(r.kind)).map((r) => anonimo(r.text, nombres));
  const realAnulado = (f.real || []).some((r) => r.status !== "submitted");
  casos.push({
    id: `E${f.event_id}`, capa: "cami", grupo: def.g, origen: { tipo: "produccion", evento: f.event_id, lead: f.lead_id, fecha: String(f.at).slice(0, 10) },
    hoy: String(f.at).slice(0, 10),
    texto: anonimo(f.mensaje, nombres),
    antes: antes.map((x) => ({ role: x.r === "guest" ? "guest" : "cami", text: x.t })),
    interpretacion: anonimoProfundo(f.interpretation || {}, nombres),
    paquete: anonimoProfundo(f.packet, nombres),
    real, real_anulado: realAnulado && !real.length,
    afirmaciones: def.a, ...(def.nota ? { nota: def.nota } : {}), ...(def.pendiente ? { pendiente: def.pendiente } : {})
  });
}

// Patrón reportado por José ("Hola Claro"): no se encontró la fila en BD; caso construido.
const base5480 = casos.find((c) => c.id === "E5480");
casos.push({
  id: "P1", capa: "cami", grupo: "saludo", origen: { tipo: "patron_reportado", nota: "José, 2026-11-11: Cami saludó 'Hola Claro'. No se encontró la fila; se reproduce el patrón." },
  hoy: "2026-11-11", texto: "Claro",
  antes: [{ role: "guest", text: "Hola, quiero información de los apartaestudios" },
    { role: "cami", text: "¡Hola! Soy Cami, la asistente virtual de José Manuel, anfitrión de Miu La Frontera. ¿Te cuento cómo funcionan las estadías por meses?" }],
  interpretacion: { intent: "lodging_question", language: "es", knowledge_topics: [] },
  paquete: { packet_version: 2, action: "CLARIFICAR SOLICITUD", action_result: { action: "CLARIFICAR SOLICITUD", summary: "Se pidieron los datos que faltan." },
    deterministic_text: "Perfecto. ¿Qué fecha de llegada tienes prevista y para cuántas personas sería?", guest_name: null, first_contact: false,
    facts: [], numbers: [], dates: [], apartments: [], required_facts: [], suggested_goals: ["arrival", "guests"], notes: [], forbidden_claims: [],
    allowed_moves: ["ask_one"], accepts: base5480?.paquete?.accepts ?? {}, presentation: { mode: "none" }, ui: {} },
  real: [], real_anulado: false,
  afirmaciones: { no_contiene: ["hola claro", "hola, claro"], ...PREG }
});
casos.push({
  id: "P2", capa: "cami", grupo: "saludo", origen: { tipo: "patron_reportado", nota: "Variante: 'Hola' + 'Claro' en dos mensajes." },
  hoy: "2026-11-11", texto: "Hola claro que si",
  antes: [{ role: "cami", text: "¿Te gustaría que te muestre las opciones para tus fechas?" }],
  interpretacion: { intent: "lodging_question", language: "es", knowledge_topics: [] },
  paquete: { packet_version: 2, action: "CLARIFICAR SOLICITUD", action_result: { action: "CLARIFICAR SOLICITUD", summary: "Se pidieron los datos que faltan." },
    deterministic_text: "Perfecto. ¿Qué fecha de llegada tienes prevista y para cuántas personas sería?", guest_name: null, first_contact: false,
    facts: [], numbers: [], dates: [], apartments: [], required_facts: [], suggested_goals: ["arrival", "guests"], notes: [], forbidden_claims: [],
    allowed_moves: ["ask_one"], accepts: base5480?.paquete?.accepts ?? {}, presentation: { mode: "none" }, ui: {} },
  real: [], real_anulado: false,
  afirmaciones: { no_contiene: ["hola claro", "hola, claro"], ...PREG }
});

// ---------------------------------------------------------------------------
// Casos de la cadena (mini Teo / Teo de guardia): una firma de cami_errores por caso.
// No pasan por el redactor de Cami: los corre el ejecutor del PMS (examen del banco).
// ---------------------------------------------------------------------------
const cad = (id, firma, errores, texto, esperado, nota, extra = {}) => ({ id, capa: "cadena", grupo: `error:${firma}`, firma, errores, texto, esperado, nota, ...extra });
const RESP = ["responder"], RESP_O_TEO = ["responder", "escalar_a_teo"];
casos.push(
  cad("C1", "no_sabia:h8ca93ae168", [6], "(Un propietario de Miu Canal mandó fotos después del registro)", { decision: RESP, no_debe_contener: ["no tienes reserva"] },
    "Agradecer las fotos y dar un solo paso siguiente. Falla real: el pendiente no traía la conversación ni la ficha.", { negocio: "miubica", ambito: "prospecto" }),
  cad("C2", "no_sabia:h015cde90a2", [17], "Queda en conquistadores Medellín", { decision: RESP, no_debe_contener: ["no recibimos"] },
    "Oferta Co-anfitrión nacional (GO 2026-11-11): se reciben propiedades fuera de La Frontera. Seguir con una sola pregunta.", { lead: 359, ambito: "propietaria" }),
  cad("C3", "no_sabia:validador:confianza_baja", [137], "1 y 2", { decision: RESP_O_TEO },
    "Respuesta numérica a una pregunta de opciones de la ficha (modalidad): leerla como elección de las opciones 1 y 2.", { negocio: "miubica", ambito: "prospecto" }),
  cad("C4", "promesa_sin_permiso:validador:requiere_jose", [147], "También los requisitos que piden y como es el trámite?", { decision: RESP_O_TEO, no_debe_contener: ["descuento"] },
    "Requisitos (cédula o pasaporte) y pasos. Sin cifras que no estén aprobadas.", { lead: 88 }),
  cad("C5", "no_sabia:validador_guardia:confianza_baja", [203, 204, 211], "Todas han sido entre mediana y larga estancia", { decision: RESP_O_TEO },
    "Propietario contando su historia de reservas: acusar recibo y seguir el registro.", { lead: 334 }),
  cad("C6", "otro:validador_guardia:plazo_prohibido", [205], "(audio) hay veces que son cuatro horas cuando el apartamento es grande y está sucio; a veces varios días de ocho horas",
    { decision: RESP_O_TEO, no_debe_contener: ["en 10 minutos", "en una hora"] }, "Equipo/limpieza contando tiempos: no prometer plazos.", { lead: 332, ambito: "equipo" }),
  cad("C7", "no_sabia:h0a1ae8cc31", [417, 459], "Hola Teo, buenos días", { decision: RESP },
    "Propietaria saluda después del registro: saludar y preguntar en qué se le ayuda (de usted, palabras sencillas).", { negocio: "miubica", ambito: "prospecto" }),
  cad("C8", "no_sabia:h4f62063774", [480], "Dónde están ubicados", { decision: RESP },
    "Prospecto de propietario pregunta la ubicación: responder con lo aprobado (El Poblado, Medellín) sin datos privados.", { negocio: "miubica", ambito: "prospecto" }),
  cad("C9", "no_sabia:h7d45eb69ce", [551], "Carrera [direccion]", { decision: RESP },
    "Propietaria da la dirección pedida: agradecer y pasar a la siguiente pregunta del registro.", { lead: 359, ambito: "propietaria" }),
  cad("C10", "no_sabia:h28ca4bda59", [599], "(mandó un archivo)", { decision: RESP_O_TEO },
    "Archivo de un cliente corporativo: acusar recibo; si es un pago, decir que Administración lo verifica.", { lead: 223 }),
  cad("C11", "no_sabia:h977936b295", [617, 757], "Gracias", { decision: RESP, no_debe_contener: ["no tengo confirmado"] },
    "Cortesía: responder corto. Falla real: el modelo del mini Teo respondía error 400 (api:400) desde el 2026-11-11 12:00 UTC.", { lead: 192 }),
  cad("C12", "no_sabia:h17e00c5fa5", [618], "Es un apartaestudio", { decision: RESP }, "Dato del registro de la propietaria: agradecer y seguir.", { lead: 359, ambito: "propietaria" }),
  cad("C13", "no_sabia:h99f2d273f4", [628], "(mandó un archivo que no se pudo abrir)", { decision: RESP_O_TEO },
    "Propietaria manda fotos y una sale sin soporte: pedir que la reenvíe como foto.", { negocio: "miubica", ambito: "prospecto" }),
  cad("C14", "no_sabia:h586e8fc602", [640], "Que se debe entonces en total?", { decision: RESP_O_TEO, no_debe_contener: ["no tienes reserva"] },
    "Saldo exacto de Cartera (arreglo ef1a0cd en producción): nunca inventar el total.", { lead: 192 }),
  cad("C15", "no_sabia:hd35a1a66b6", [653], "Para hacer el pago de una", { decision: RESP_O_TEO },
    "Quiere pagar ya: dar el medio de pago aprobado o decir que el enlace sale por este chat.", { lead: 192 }),
  cad("C16", "no_sabia:h4219014785", [709, 724], "Por mes", { decision: RESP_O_TEO },
    "Cami repitió la misma pregunta 2 veces: cambiar de enfoque (ejemplo de respuesta corta u opciones). Lo cubre también el redactor (E5775, E5777, E5762).", { lead: 295 }),
  cad("C17", "no_sabia:h000423da0f", [758], "ACEPTO", { decision: RESP },
    "La propietaria acepta los términos del registro: confirmar y dar el siguiente paso.", { negocio: "miubica", ambito: "prospecto" }),
  cad("C18", "no_sabia:h5082c786c4", [871], "Tienes algo desde mañana hasta el 25? No tiene que ser la frontera", { decision: RESP_O_TEO },
    "Pregunta de disponibilidad con la conversación tomada: no debe esperar a una persona; buscar disponibilidad o mensaje de espera.", { lead: 285 }),
  cad("C19", "no_sabia:other", [1, 2, 3, 4, 5, 146, 752], "Is this José saying this or AI?", { decision: RESP, no_debe_contener: ["lo confirmo", "i will confirm", "i ll confirm"] },
    "Pregunta de identidad: decir que es Cami, la asistente virtual. No es una brecha.", { lead: 285 })
);

for (const c of casos) if (c.capa === "cadena") c.texto = anonimo(c.texto, []);

// ---------------------------------------------------------------------------
// FOTO DEL CONOCIMIENTO (lo que el PMS agrega al paquete en agregarConocimientoGeneral y que
// la BD no guarda): hechos del edificio, FAQ publicada, dirección y oferta de lanzamiento,
// tal como están publicados al construir el banco.
// ---------------------------------------------------------------------------
const crudo = JSON.parse(fs.readFileSync(path.join(AQUI, "raw-conocimiento.json"), "utf8"))[0].json_build_object;
const { textoConocimientoCancelacion } = await import(pathToFileURL(path.join(PMS, "src/modules/commercial-workflow/cancelacion.js")).href);
const { textoOfertaGeneral, fechasDeLaOferta } = await import(pathToFileURL(path.join(PMS, "src/modules/revenue-engine/oferta-lanzamiento.js")).href);
const building_facts = [...new Set((crudo.edificios || []).flat().filter(Boolean).map((t) => redactPii(t)))];
const faq = []; let address_data = null; let plantillaCancelacion = null;
for (const f of crudo.faq || []) {
  for (const [topic, text] of Object.entries(f.c || {})) {
    if (topic === "guia_del_sector" && crudo.politicas?.guia_huesped_v1?.habilitada !== true) continue;
    if (typeof text === "string" && text.trim()) faq.push({ topic, text: redactPii(text) });
  }
  if (!address_data && f.c?.address_data) address_data = f.c.address_data;
  if (!plantillaCancelacion && f.c?.cancellation && typeof f.c.cancellation === "object") plantillaCancelacion = f.c.cancellation;
}
const pol = crudo.politicas?.cancelacion_v1;
if (plantillaCancelacion && pol?.habilitada) {
  const t = textoConocimientoCancelacion(plantillaCancelacion, pol, { anticipo: 600000, limpieza: 136000 });
  if (t) faq.push({ topic: "cancellation", text: t });
}
const ofertaCfg = { ...crudo.politicas.oferta_lanzamiento_v1, vigente_hasta_dia: String(crudo.politicas.oferta_lanzamiento_v1.vigente_hasta).slice(0, 10) };
const oferta = { topic: "oferta_lanzamiento", text: textoOfertaGeneral(ofertaCfg), authorized_dates: fechasDeLaOferta(ofertaCfg) };
const conocimiento = { tomado: new Date().toISOString().slice(0, 10), building_facts, faq,
  direccion: { aproximada: address_data?.approximate_es ?? null, exacta: address_data?.exact_es ?? null }, oferta };
// Por caso: qué parte del conocimiento recibió (la dirección exacta solo si ese día se dio; la oferta
// no va a huéspedes en estadía ni a textos fijos).
const EN_ESTADIA = new Set([192, 223]);
for (const c of casos) {
  if (c.capa !== "cami") continue;
  const realTxt = (c.real || []).join(" ");
  c.conocimiento = { direccion: /Cra 41 AA/.test(realTxt) ? "exacta" : "aproximada",
    oferta: !c.paquete?.fixed_text && !EN_ESTADIA.has(c.origen?.lead) && !(c.paquete?.facts || []).some((f) => f?.topic === "oferta_lanzamiento") };
}

const salida = { version: 1, generado: new Date().toISOString().slice(0, 10), conocimiento,
  fuente: "BD de producción, solo lectura (Render MCP), eventos COMMERCIAL_INBOUND con authorized_response_packet; cami_errores al 2026-11-11.",
  privacidad: "Sin teléfonos, documentos, correos ni cuentas (redactPii del PMS); solo primer nombre.",
  casos };
const destino = process.argv[2];
fs.writeFileSync(destino, JSON.stringify(salida, null, 1));
const n = (k) => casos.filter((c) => c.capa === k).length;
console.log(`casos=${casos.length} cami=${n("cami")} cadena=${n("cadena")} pendientes=${casos.filter((c) => c.pendiente).length} bytes=${fs.statSync(destino).size}`);
