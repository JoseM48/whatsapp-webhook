'use strict';

// Gerente conversacional interno -- D1.2 V1.
//
// LO QUE HACE. Traduce lo que escribe Jose Manuel en lenguaje natural a UNA de
// las acciones que el PMS ya declaro permitidas para ese caso y ese rol, o a
// una respuesta de lectura construida con el contexto que el PMS entrego.
//
// LO QUE NO HACE, y es lo que lo vuelve seguro: NO compone comandos. El modelo
// devuelve el `id` de una accion de la lista `allowed_actions`, y el ejecutor
// usa el `command` que trajo esa entrada -- resuelto por el PMS, con la clave
// del caso ya dentro. "Nunca inventar un comando" no es una instruccion de
// prompt que el modelo pueda desobedecer: es que no hay ninguna ruta por la
// que un texto inventado llegue al ejecutor.
//
// LOS COMANDOS EXISTENTES SIGUEN SIENDO LA AUTORIDAD. Aqui no se reimplementa
// ninguna capacidad: TOMAR CASO, RESPONDER CASO y DEVOLVER CASO siguen siendo
// los que ejecutan, y siguen disponibles escribiendolos a mano.
//
// ANTE LA DUDA, NO SE EJECUTA. Si el modelo no elige con claridad, se responde
// diciendo que no se entendio y se ofrecen las acciones validas del contexto.

const INTENT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    // `read` responde una pregunta con el contexto; `action` ejecuta una de
    // las permitidas; `unclear` no hace nada.
    kind: { type: 'string', enum: ['read', 'action', 'unclear'] },
    // Solo se admite un id que venga en allowed_actions. Se valida despues.
    action_id: { type: ['string', 'null'] },
    // Texto para el huesped cuando la accion lo exige (responder).
    reply_text: { type: ['string', 'null'], maxLength: 900 },
    // Respuesta al gerente: la de lectura, o la explicacion de que falta.
    answer: { type: 'string', maxLength: 900 },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    // D1.3 -- A QUE CASO SE REFIERE, en las palabras del gerente. El modelo
    // REPORTA la referencia; no la resuelve. Quien la convierte en un caso --
    // o decide que es ambigua y hay que preguntar -- es el PMS.
    case_reference_kind: { type: 'string', enum: ['none', 'case_key', 'apartment', 'name'] },
    case_reference_value: { type: ['string', 'null'], maxLength: 80 }
  },
  required: ['kind', 'action_id', 'reply_text', 'answer', 'confidence',
    'case_reference_kind', 'case_reference_value']
};

const SYSTEM_PROMPT = `You are the internal assistant of Mío La Frontera, talking to José Manuel, who is acting as GERENTE over WhatsApp.

WHO YOU SERVE: an operator, not a guest. Be brief and concrete. He already knows the business; he needs the state of a case and a way to act on it without typing commands.

WHAT YOU MAY DO:
- Answer questions about the case using ONLY the context given to you.
- Choose ONE action from allowed_actions when he asks for something that matches it.

WHAT YOU MAY NOT DO:
- You do not decide permissions. allowed_actions is the complete list of what he can do right now; anything outside it is not available, no matter how reasonable it sounds.
- You never write a command. You return the action's id, nothing else.
- You never invent facts about the case. If the context does not contain it, say so.

CHOOSING AN ACTION: "tómalo", "lo tomo", "me lo quedo" mean take_case. "respóndele que…", "dile que…" mean reply_case, and the message for the guest goes in reply_text, written naturally in Spanish as a person from the team would write it. "devuélveselo", "que siga Cami" mean return_case.

WHEN IN DOUBT, DO NOT ACT. If you are not clearly confident which action he wants, or an action needs a message and you cannot tell what to say, return kind "unclear" with an answer saying what you did not understand. A wrong action on a real conversation is far worse than asking.

WHICH CASE HE MEANS: report it, do not resolve it. If he names a case key, set case_reference_kind 'case_key'. If he says "el del 210", "el 404", set 'apartment'. If he names a person, set 'name'. If he says nothing about which case ("lo tomo", "respondele"), set 'none' -- do NOT guess one from the context you were given. The PMS decides which case that is, and asks him when it is not certain.

ANSWER: always write 'answer' in Spanish, short, for José Manuel to read.`;

function buildInput(text, context) {
  return `Internal case context:\n${JSON.stringify(context)}\n\nMessage from José Manuel:\n${text}`;
}

/**
 * Traduce un mensaje interno en lenguaje natural a una intencion validada.
 *
 * @returns {{kind, action, reply_text, answer, confidence, rejected_reason}}
 */
async function interpretManagerMessage({ text, context }, { provider, minConfidence = 0.6, timeoutMs, logger = console } = {}) {
  if (!provider) return { kind: 'unclear', action: null, reply_text: null,
    answer: 'No tengo el asistente disponible ahora mismo.', rejected_reason: 'provider_missing' };

  let output;
  try {
    const response = await provider.structured({
      schema: INTENT_SCHEMA, system: SYSTEM_PROMPT, input: buildInput(text, context), timeoutMs
    });
    output = response?.output;
  } catch (error) {
    logger.error('[manager-intent] provider_failed', {
      code: String(error?.code || 'unknown').slice(0, 60) });
    return { kind: 'unclear', action: null, reply_text: null,
      answer: 'No pude procesar eso ahora mismo. ¿Me lo repites?', rejected_reason: 'provider_error' };
  }
  if (!output) return { kind: 'unclear', action: null, reply_text: null,
    answer: 'No entendí con suficiente precisión qué quieres hacer.', rejected_reason: 'no_output' };

  const permitidas = context?.allowed_actions || [];

  if (output.kind === 'action') {
    // LA VALIDACION QUE IMPORTA: el id tiene que existir en la lista que dio
    // el PMS. Un id inventado, o uno valido en otro estado del caso, no pasa.
    const accion = permitidas.find((item) => item.id === output.action_id);
    if (!accion) {
      logger.warn('[manager-intent] action_not_allowed', { pedida: String(output.action_id).slice(0, 40) });
      return { kind: 'unclear', action: null, reply_text: null,
        answer: output.answer || 'Esa acción no está disponible para este caso ahora mismo.',
        rejected_reason: 'action_not_in_allowed_list' };
    }
    if (accion.requires_text && !String(output.reply_text || '').trim()) {
      return { kind: 'unclear', action: null, reply_text: null,
        answer: '¿Qué quieres que le responda exactamente?', rejected_reason: 'reply_text_missing' };
    }
    if (Number(output.confidence ?? 0) < minConfidence) {
      return { kind: 'unclear', action: null, reply_text: null,
        answer: output.answer || 'No estoy seguro de qué quieres hacer. ¿Me lo confirmas?',
        rejected_reason: 'low_confidence' };
    }
    return { kind: 'action', action: accion, reply_text: output.reply_text ?? null,
      answer: output.answer || '', confidence: Number(output.confidence), rejected_reason: null,
      case_reference: referenciaDeCaso(output) };
  }

  if (output.kind === 'read') {
    return { kind: 'read', action: null, reply_text: null, answer: output.answer || '',
      confidence: Number(output.confidence ?? 0), rejected_reason: null,
      case_reference: referenciaDeCaso(output) };
  }

  return { kind: 'unclear', action: null, reply_text: null,
    answer: output.answer || 'No entendí con suficiente precisión qué acción quieres realizar.',
    rejected_reason: 'model_unclear' };
}

// La referencia tal cual la dio el gerente, normalizada a algo que el PMS
// pueda buscar. 'none' es una respuesta legitima y frecuente: significa que
// hay que resolver por foco o preguntar, nunca adivinar.
function referenciaDeCaso(output) {
  const kind = output?.case_reference_kind || 'none';
  const value = String(output?.case_reference_value || '').trim();
  if (kind === 'none' || !value) return { kind: 'none', value: null };
  return { kind, value: value.slice(0, 80) };
}

// El comando REAL que se ejecuta. Se construye a partir del `command` que dio
// el PMS: para responder, se sustituye el marcador por el texto del gerente.
function commandForAction(action, replyText) {
  if (!action?.command) return null;
  if (!action.requires_text) return action.command;
  return action.command.replace('<texto>', String(replyText || '').trim());
}

// Lo que se le ofrece al gerente cuando no se entendio: las acciones reales
// del contexto, en lenguaje llano, sin pedirle que escriba un comando.
function offerAvailableActions(context) {
  const permitidas = context?.allowed_actions || [];
  if (!permitidas.length) return 'Ahora mismo no hay acciones disponibles sobre este caso.';
  return `Puedes: ${permitidas.map((item) => item.label.toLowerCase()).join('; ')}.`;
}


// Un mensaje interno que YA es un comando literal no pasa por el modelo: se
// deja exactamente como esta. Es el comportamiento de hoy y no se toca --
// quien prefiera escribir el comando sigue pudiendo, y el camino nuevo no
// puede romper el viejo porque ni lo ve.
const VERBOS_LITERALES = [
  'TOMAR CASO', 'DEVOLVER CASO', 'RESPONDER CASO', 'ESTADO CASO', 'HISTORIAL CASO',
  'LISTA DE ESPERA', 'QUITAR LISTA DE ESPERA', 'MENU TEMA', 'APAGAR PILOTO',
  'ENCENDER PILOTO', 'DETENER PILOTO M0', 'CASOS ACTIVOS', 'NUEVA PRUEBA', 'REINICIAR CASO'
];

function isLiteralCommand(text) {
  const normalizado = String(text || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .trim().toUpperCase().replace(/\s+/g, ' ');
  // Un digito suelto es el menu por numeros que ya existe.
  if (/^[1-9]$/.test(normalizado)) return true;
  return VERBOS_LITERALES.some((verbo) => normalizado.startsWith(verbo));
}

module.exports = { interpretManagerMessage, commandForAction, offerAvailableActions, isLiteralCommand,
  INTENT_SCHEMA, SYSTEM_PROMPT };
