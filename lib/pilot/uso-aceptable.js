'use strict';

// USO ACEPTABLE (José Manuel, 2026-10-24: "blindarnos para no permitir cosas
// ilegales, con las buenas prácticas de Meta: empieza por la política y el
// filtro de Cami").
//
// La POLÍTICA vive en el PMS como datos (commercial_policies.uso_aceptable_v1,
// migración 930): categorías, textos de Cami, a quién se avisa. Documento:
// docs/02_NEGOCIO_OPERACION/TENGOCAMELLO/POLITICA_USO_ACEPTABLE_20261024.md.
// Aquí solo está lo que el MODELO necesita para clasificar un pedido antes de
// que Cami actúe:
//   - chat y nota de voz: un campo estructurado `acceptable_use` en la
//     interpretación (ai.js y interpretation-schema-v2.js); el PMS decide.
//   - llamada: la herramienta local `evaluar_uso_aceptable` (cami-voz.js), que
//     llama al PMS (/voz/llamada/uso-aceptable) y devuelve qué decirle.
// Paridad de canales (dominio 25): test/paridad-canales.test.js.
//
// El modelo CLASIFICA; no responde ni decide la sanción. "permitido" es el caso
// normal y no viaja al PMS (un PMS anterior, de esquema estricto, no conoce la
// clave).

const DECISIONES = Object.freeze(['permitido', 'restringido', 'prohibido']);

// Claves de categoría: las mismas de uso_aceptable_v1 (PMS). Una clave que el
// PMS no conozca se registra como otro_prohibido / otro_restringido.
const CATEGORIAS_PROHIBIDAS = Object.freeze([
  'armas_explosivos', 'drogas_ilicitas', 'medicamentos_formula', 'tabaco_vapeo', 'alcohol_menores',
  'sexual_adultos_menores', 'fraude_documentos_falsos', 'productos_robados_falsificados',
  'apuestas_ilegales', 'datos_personales_ilegales', 'animales_silvestres', 'venta_animales',
  'violencia_acoso_odio', 'captacion_ilegal_dinero', 'prestamos_rapidos_cobranza', 'citas_multinivel',
  'otro_prohibido'
]);
const CATEGORIAS_RESTRINGIDAS = Object.freeze([
  'quimicos_controlados', 'credito_servicios_financieros', 'empleo', 'vivienda_anuncios',
  'temas_sociales_politicos', 'alcohol', 'salud_suplementos_medicos', 'datos_sensibles',
  'contacto_masivo', 'sorteos_rifas', 'otro_restringido'
]);
const CATEGORIAS = Object.freeze(['ninguna', ...CATEGORIAS_PROHIBIDAS, ...CATEGORIAS_RESTRINGIDAS]);

const acceptableUseSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    decision: { type: 'string', enum: [...DECISIONES] },
    category: { type: 'string', enum: [...CATEGORIAS] },
    // Resumen neutro del pedido (sin nombres, teléfonos, direcciones ni datos
    // de terceros). Solo para el registro auditable; nunca se le muestra al
    // cliente.
    summary: { type: ['string', 'null'], maxLength: 200 }
  },
  required: ['decision', 'category', 'summary']
};

// Instrucción para el intérprete del chat (inglés, como el resto del prompt).
// Químicos: Resolución 0001 de 2015 del CNE (art. 4 listado, art. 6 umbrales),
// verificado el 2026-10-24 (POLITICA_USO_ACEPTABLE_20261024.md).
const INSTRUCCION_CHAT = `ACCEPTABLE USE (policy uso_aceptable_v1, 2026-10-24): before Cami acts on any request (quote, search a provider, schedule, draft an ad or a message, sell something), classify the CURRENT message in acceptable_use. You only classify; the system decides what Cami says.
- "permitido" (category "ninguna"): the normal case. Lodging, prices, dates, availability, the building, a stay, a repair or a home service (plumbing, electricity, cleaning, painting), ordinary legal products and services, a normal ad for a legal business. When in doubt about an ordinary request, choose permitido.
- "prohibido": the person asks Cami to help obtain, sell, promote or arrange something illegal in Colombia or forbidden by the WhatsApp Business Messaging Policy or the Meta Commerce Policies: firearms, ammunition, explosives, weapon parts or traumatic weapons (armas_explosivos); illegal drugs or paraphernalia (drogas_ilicitas); prescription or controlled medicines (medicamentos_formula); tobacco, cigarettes or vapes (tabaco_vapeo); alcohol for minors (alcohol_menores); sexual or adult services, or anything sexual involving minors (sexual_adultos_menores); fake documents, identity theft, scams, money laundering (fraude_documentos_falsos); stolen, counterfeit or pirated goods (productos_robados_falsificados); unlicensed gambling or betting (apuestas_ilegales); buying or selling personal databases, spying on someone or entering someone else's accounts (datos_personales_ilegales); wild or endangered animals or their parts (animales_silvestres); selling live animals other than livestock (venta_animales); threats, harassment, hate or intimidation (violencia_acoso_odio); collecting money from the public with promised returns, pyramids, crypto or fake currency (captacion_ilegal_dinero); payday loans, loans between individuals ("gota a gota") or debt collection (prestamos_rapidos_cobranza); dating services or multi-level marketing (citas_multinivel); anything else clearly illegal (otro_prohibido).
- "restringido": legal only with a permit, a license or special Meta rules, so a person must review it first: chemicals controlled in Colombia by the Consejo Nacional de Estupefacientes (Resolución 0001 de 2015) -- sulfuric acid, hydrochloric (muriatic) acid and potassium permanganate in any amount; caustic soda (sodium hydroxide), acetone, sodium carbonate, ammonia, methanol, toluene, thinner and other solvents; fuels or cement in volume; other hazardous goods (quimicos_controlados). This includes making, buying or selling soap, detergent or cleaning products when they mention caustic soda or another controlled chemical (buying and storing it needs a SICOQ registration). Also: loans, credit, investments or financial products (credito_servicios_financieros); job postings or hiring ads (empleo); ads to rent or sell housing for third parties (vivienda_anuncios -- NOT Miu's own lodging, which is permitido); political, electoral or social-issue ads (temas_sociales_politicos); selling alcohol to adults (alcohol); health or medical products, supplements, over-the-counter medicines, medical or aesthetic treatments with health claims (salud_suplementos_medicos); handling health, biometric or children's data (datos_sensibles); mass messaging or cold contact campaigns (contacto_masivo); raffles, sweepstakes or prize draws (sorteos_rifas); anything else that needs a permit (otro_restringido).
Talking ABOUT a topic is not a request to act ("¿es legal vender soda cáustica?" is a question, permitido). Soap, detergent or cleaning products WITHOUT a controlled chemical (for example with sulfonic acid / LABSA or hypochlorite, which are not on the list) are permitido. summary: a neutral one-line description of what was asked, without names, phone numbers, addresses or third-party data; null when permitido.`;

// Instrucción para la llamada (español, como el resto de cami-voz).
const INSTRUCCION_VOZ = [
  'USO ACEPTABLE (política uso_aceptable_v1): antes de cotizar, buscar proveedor, agendar, redactar un anuncio o ayudar con cualquier pedido que NO sea lo normal (alojamiento, reparaciones, servicios y productos comunes y legales), usa evaluar_uso_aceptable con la decisión que corresponda:',
  '- prohibido: armas, municiones o explosivos; drogas ilegales; medicamentos con fórmula médica; tabaco o vapeadores; alcohol para menores; servicios sexuales o para adultos, o cualquier cosa sexual con menores; documentos falsos, estafas o suplantación; productos robados o falsificados; apuestas sin licencia; comprar o vender bases de datos o espiar a alguien; animales silvestres o venta de animales vivos (salvo ganado); amenazas, acoso u odio; captar dinero del público con rentabilidades prometidas, pirámides o criptomonedas; préstamos gota a gota o entre particulares y cobranza de deudas; citas o multinivel.',
  '- restringido (requiere revisión o permiso): químicos controlados en Colombia (ácido sulfúrico, ácido clorhídrico o muriático y permanganato en cualquier cantidad; soda cáustica, acetona, carbonato de sodio, amoníaco, metanol, tolueno, thinner y otros solventes; combustibles o cemento en cantidad), también cuando es para hacer jabón o detergente con soda cáustica; préstamos, crédito o inversiones; anuncios de empleo; anuncios de vivienda de terceros; anuncios políticos o de temas sociales; venta de alcohol a adultos; productos de salud, suplementos, medicamentos de venta libre o tratamientos con promesas médicas; datos de salud, biométricos o de menores; mensajes masivos; rifas y sorteos.',
  '- Un jabón o detergente sin químicos controlados (por ejemplo con ácido sulfónico o hipoclorito) es permitido. Preguntar SOBRE un tema no es pedir que lo hagas.',
  '- Con prohibido o restringido NO ejecutes el pedido: di con tus palabras y con amabilidad el texto_para_decir que devuelve la herramienta (prohibido: no puedes ayudar con eso; restringido: lo consultas con el equipo y le confirman por el chat) y sigue con lo demás. No sermonees ni acuses.',
].join('\n');

const HERRAMIENTA_VOZ = Object.freeze({
  type: 'function',
  name: 'evaluar_uso_aceptable',
  description: 'Registra un pedido que podría ser prohibido o restringido por la política de uso aceptable ANTES de actuar sobre él (cotizar, buscar proveedor, agendar, redactar anuncio). Devuelve la decisión final y el texto_para_decir. No la uses para pedidos normales (alojamiento, reparaciones, servicios comunes).',
  parameters: {
    type: 'object', additionalProperties: false,
    properties: {
      decision: { type: 'string', enum: ['restringido', 'prohibido'] },
      categoria: { type: 'string', enum: [...CATEGORIAS_PROHIBIDAS, ...CATEGORIAS_RESTRINGIDAS] },
      resumen: { type: 'string', maxLength: 200, description: 'Qué pidió, en una línea neutra, sin nombres, teléfonos ni direcciones.' }
    },
    required: ['decision', 'categoria', 'resumen']
  }
});

const TEL = /\+?\d[\d\s().-]{6,}\d/g;
const CORREO = /[^\s@]+@[^\s@]+\.[^\s@]+/g;
/** Resumen sin teléfonos ni correos, recortado. */
function resumenSeguro(texto, max = 200) {
  const t = String(texto ?? '').replace(CORREO, '[correo]').replace(TEL, '[número]').replace(/\s+/g, ' ').trim();
  return t ? (t.length > max ? `${t.slice(0, max - 1)}…` : t) : null;
}

/**
 * Normaliza lo que dio el modelo. Devuelve null si es "permitido" o inválido
 * (el turno sigue normal); si no, {decision, category, summary[, canal]}. La
 * decisión del modelo manda; una categoría ausente o inválida queda como el
 * genérico del grupo decidido.
 */
function normalizarUsoAceptable(raw, { canal = null } = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const decision = DECISIONES.includes(raw.decision) ? raw.decision : null;
  if (!decision || decision === 'permitido') return null;
  const valida = CATEGORIAS.includes(raw.category) && raw.category !== 'ninguna';
  const category = valida ? raw.category : (decision === 'prohibido' ? 'otro_prohibido' : 'otro_restringido');
  return { decision, category, summary: resumenSeguro(raw.summary), ...(canal ? { canal } : {}) };
}

module.exports = {
  DECISIONES, CATEGORIAS, CATEGORIAS_PROHIBIDAS, CATEGORIAS_RESTRINGIDAS,
  acceptableUseSchema, INSTRUCCION_CHAT, INSTRUCCION_VOZ, HERRAMIENTA_VOZ,
  normalizarUsoAceptable, resumenSeguro
};
