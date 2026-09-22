'use strict';

// Contratos de tools -- Bloque B.
//
// SEPARACION INNEGOCIABLE:
//
//   READ TOOLS     -- el LLM puede invocarlas libremente. Son side-effect free:
//                     leen fuentes autoritativas y no escriben nada, no
//                     comprometen inventario, no mueven dinero.
//
//   ACTION COMMANDS -- el LLM NO las invoca. Nunca aparecen en la lista de
//                     tools que viaja a la API. Las propone como intencion y
//                     las ejecuta el motor determinista de pms-lite despues de
//                     una confirmacion semantica. createPreReservation() es el
//                     caso tipico: compromete inventario real.
//
// Ninguna tool implementa logica de negocio: todas envuelven funciones que ya
// existen en pms-lite. El LLM no necesita saber como funciona cada modulo.
//
// Contrato uniforme de respuesta:
//   { status, data, missing, reason, source }
// `status: 'needs_clarification'` es una respuesta legitima y esperada, no un
// error: es como el sistema le dice al LLM "faltan datos, preguntaselos tu".

const TOOL_STATUS = Object.freeze({
  OK: 'ok',
  NEEDS_CLARIFICATION: 'needs_clarification',
  NOT_AUTHORIZED: 'not_authorized',
  UNAVAILABLE: 'unavailable',
  ERROR: 'error'
});

function toolResult(status, { data = null, missing = [], reason = null, source = null } = {}) {
  return { status, data, missing, reason, source };
}

// ---------------------------------------------------------------------------
// READ TOOLS -- expuestas al modelo
// ---------------------------------------------------------------------------

const READ_TOOLS = [
  {
    name: 'resolve_apartment_reference',
    description: 'Resuelve una referencia natural a un apartamento ("el 510", "el del balcón", "el otro que me mostraste") a un código interno. Si la referencia no es inequívoca devuelve needs_clarification con los candidatos: NUNCA adivina.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        raw: { type: 'string', description: 'La expresión literal del huésped.' },
        hint_type: { type: 'string', enum: ['number_fragment', 'attribute', 'anaphora', 'ordinal', 'unknown'] },
        hint_value: { type: ['string', 'null'], description: 'Atributo o fragmento numérico si aplica.' }
      },
      required: ['raw', 'hint_type', 'hint_value']
    },
    pms: 'resolveApartmentReference'
  },
  {
    name: 'check_availability',
    description: 'Consulta disponibilidad real para unas fechas y duración. Requiere fecha de llegada exacta; si falta, devuelve needs_clarification. OJO: `available` y `direct_channel_eligible` son cosas DISTINTAS -- un apartamento puede estar libre y aun asi no venderse por canal directo para esa duracion. No digas que no hay disponibilidad cuando lo que no hay es venta directa.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        arrival_date: { type: ['string', 'null'], description: 'ISO YYYY-MM-DD.' },
        nights: { type: ['integer', 'null'] },
        guests: { type: ['integer', 'null'] },
        apartment_code: { type: ['string', 'null'] }
      },
      required: ['arrival_date', 'nights', 'guests', 'apartment_code']
    },
    pms: 'checkAvailability'
  },
  {
    name: 'quote_stay',
    description: 'Cotiza una estadía con la MISMA autoridad de precio que usa la propuesta real (cascada: estacionalidad del mes, ventana de quema, mínimo mensual). El precio SIEMPRE viene de aquí: el modelo nunca lo calcula ni lo estima. arrival_date es OBLIGATORIA y no puede ser null -- el precio depende del mes, así que sin fecha no hay precio que dar: primero pide la fecha al huésped.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        nights: { type: ['integer', 'null'] },
        arrival_date: { type: ['string', 'null'] },
        apartment_code: { type: ['string', 'null'] }
      },
      required: ['nights', 'arrival_date', 'apartment_code']
    },
    pms: 'quoteStay'
  },
  {
    name: 'get_public_apartment_attributes',
    description: 'Atributos que el bot PUEDE afirmar de un apartamento. Solo devuelve lo publicado y aprobado; si no hay fuente, lo dice en vez de negar.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: { apartment_code: { type: 'string' } },
      required: ['apartment_code']
    },
    pms: 'getPublicApartmentAttributes'
  },
  {
    name: 'get_policy',
    description: 'Política comercial vigente por clave (mascotas, canal, depósito, cancelación…). Autoridad: commercial_policies.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: { policy_key: { type: 'string' } },
      required: ['policy_key']
    },
    pms: 'getPolicy'
  },
  {
    name: 'search_commercial_knowledge',
    description: 'Busca conocimiento aprobado por tema. Si un tema no tiene fuente publicada, devuelve needs_clarification y el bot NO debe afirmar ni negar nada sobre él.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        topics: { type: 'array', items: { type: 'string' }, maxItems: 6 },
        apartment_code: { type: ['string', 'null'] }
      },
      required: ['topics', 'apartment_code']
    },
    pms: 'searchCommercialKnowledge'
  },
  {
    name: 'get_current_proposal',
    description: 'Propuesta vigente del caso, si existe. Sirve para resolver "el otro", "ese" o "el primero que me mandaste".',
    parameters: { type: 'object', additionalProperties: false, properties: {}, required: [] },
    pms: 'getCurrentProposal'
  },
  {
    name: 'request_human_review',
    description: 'Deja registrada una solicitud de revisión humana. NO promete plazo ni responsable, y no resuelve la excepción.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        question: { type: 'string', maxLength: 400 },
        category: { type: 'string', enum: ['exception', 'knowledge_gap', 'explicit_request', 'other'] }
      },
      required: ['question', 'category']
    },
    pms: 'requestHumanReview'
  }
];

// ---------------------------------------------------------------------------
// ACTION COMMANDS -- NUNCA expuestas al modelo
// ---------------------------------------------------------------------------

const ACTION_COMMANDS = [
  {
    name: 'prepare_pre_reservation',
    pms: 'createPreReservation',
    requires_semantic_confirmation: true,
    reason: 'Compromete inventario real. La ejecuta el motor determinista de pms-lite tras confirmación explícita del huésped, nunca el LLM por su cuenta.'
  },
  {
    name: 'send_payment_instructions',
    pms: 'paymentInstructions',
    requires_semantic_confirmation: true,
    reason: 'Dinero real.'
  }
];

const ACTION_NAMES = new Set(ACTION_COMMANDS.map((a) => a.name));

// Lo que viaja a la API. Blindaje: si alguien añade una action a READ_TOOLS
// por error, esto la filtra igual.
// Tools que el PUENTE implementa de verdad (READ_TOOL_HANDLERS en
// conversational-tools.routes.js, lado pms-lite).
//
// ENCONTRADO EL 2026-09-22 SONDEANDO PRODUCCION. Al modelo se le ofrecian ocho
// read tools y el puente solo despachaba cinco: search_commercial_knowledge,
// get_current_proposal y request_human_review no existen alli. El modelo las
// llamaba, recibia 404 y concluia que no podia averiguar algo que si podia --
// gastando ademas una vuelta del lazo.
//
// Ofrecer solo lo que existe es la mitad segura del arreglo. La otra mitad,
// implementar las que falten, es trabajo de PMS y decision de alcance: hasta
// que ocurra, no se le promete al modelo una capacidad que no hay.
const BRIDGE_BACKED = new Set([
  'resolve_apartment_reference', 'check_availability', 'quote_stay',
  'get_policy', 'get_public_apartment_attributes'
]);

function toolsForModel() {
  return READ_TOOLS
    .filter((t) => !ACTION_NAMES.has(t.name) && BRIDGE_BACKED.has(t.name))
    .map(({ name, description, parameters }) => ({ name, description, parameters }));
}

function isReadTool(name) {
  return READ_TOOLS.some((t) => t.name === name) && !ACTION_NAMES.has(name);
}

module.exports = {
  READ_TOOLS, ACTION_COMMANDS, ACTION_NAMES, BRIDGE_BACKED,
  toolsForModel, isReadTool, toolResult, TOOL_STATUS
};
