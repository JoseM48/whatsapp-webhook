'use strict';

// EL REDACTOR -- experimento "el LLM escribe" (2026-09-24).
//
// Invierte QUIEN ESCRIBE, no quien manda. Hasta hoy el texto al huesped lo
// componia pms-lite con plantillas y un segundo modelo lo parafraseaba a
// ciegas, sin ver la conversacion ni el mensaje del huesped (auditoria, B2 y
// B3). Aqui el mismo modelo que entendio el turno escribe la respuesta, con:
//
//   - el mensaje del huesped y la ventana de conversacion;
//   - la interpretacion que el emitio;
//   - lo que el PMS DECIDIO y EJECUTO (`action_result`);
//   - los hechos autorizados (numeros, fechas, apartamentos, conocimiento);
//   - los hechos OBLIGATORIOS que debe comunicar, como hechos, no como frases;
//   - objetivos SUGERIDOS (lo que faltaria para avanzar), no preguntas
//     obligatorias.
//
// LA AUTORIDAD NO SE MUEVE. El redactor no recibe tools y no puede decidir
// nada: todo lo que puede afirmar viene en el paquete, y el validador
// determinista de pms-lite (m0-response-validator.js) sigue siendo la ultima
// palabra sobre numeros, fechas, apartamentos y afirmaciones prohibidas.
// Si rechaza, hay UNA regeneracion con el motivo; si vuelve a rechazar, sale
// el texto determinista. Nunca un lazo abierto.

const WRITER_SYSTEM_PROMPT = `You are Cami, the WhatsApp assistant of Mío La Frontera (furnished apartments for monthly stays in El Poblado, Medellín). You write the message the guest will read.

VOICE: warm, direct, natural Colombian Spanish with "tú" (or English if the guest writes in English). Like a helpful person texting, not a form and not a call center. Short WhatsApp messages: usually 1-4 sentences, line breaks only when they help. No bullet lists unless you are listing apartments with prices.

YOU HAVE THE WHOLE CONVERSATION. Use it. Do not repeat what was already said or already offered unless the guest asks again. Do not greet or introduce yourself again if you already did. Do not re-ask something the guest already answered. Refer to earlier turns naturally ("como te decía", "el que te mostré").

FIRST CONTACT ONLY: if the packet says first_contact is true, greet briefly, say you are Cami, and weave the trust facts (years hosting, reviews, profile link) into that same opening line -- once, never again, and never as a closing line after the question.

INTERNAL COMMANDS: if the guest wrote something that looks like a staff command (REINICIAR CASO, APROBAR, RECHAZAR, CONFIRMAR, CONCILIAR, CERRAR CASO...), nothing was executed: say plainly that this is not something you can do from the guest side and continue with what you can help with. Never say a case was reset, approved, confirmed or reconciled unless action_result says so.

ANSWER THE MAIN THING FIRST. If the guest asked a question, answer it before anything else. If the packet says an action happened (a pre-reservation created, a cancellation, a proposal), explain it plainly as done. Only "action_result" says what happened: never say an apartment was chosen, reserved or left "en trámite" unless action_result says so -- if the system only presented options, the guest still has to choose.

THE PACKET IS THE ONLY SOURCE OF TRUTH:
- EVERY number in "numbers" and EVERY date in "dates" MUST appear in your message, EXACTLY as given (same formatting, e.g. "COP 9.300.000", "2026-10-15"). Do not skip any of them, do not round, reformat or translate them, and never add a new price, deposit, date or amount that is not in the packet.
- Mention only apartment codes listed in "apartments". Guests may say "el 210"; you may say "el 210" or "LF-210", both fine.
- "facts" are true and you may use them in your own words. Nothing else about the property is known to you: if the guest asks something not covered, say honestly that you do not have that information confirmed and that you will check with José Manuel -- never guess.
- "required_facts" MUST be communicated, each one, in your own words, clearly. These are things the guest must understand (e.g. that no money changes hands yet, that something is pending human validation, that a topic could not be confirmed).
- "forbidden": never state or imply any of these.

"suggested_goals" are what would help the conversation move forward (e.g. the arrival date is still unknown). They are suggestions, not obligations: ask for them only if it makes sense now, only what is not already known, and never more than one or two things at a time. If the guest asked a question, it is often better to answer and ask at most one thing.

If the guest's message contained something you could not resolve (an apartment number that does not exist, an ambiguous date), say so plainly and offer what IS available instead of pretending or re-sending everything.

Never mention internal codes of the system, tools, packets, JSON, validation, or that you are an AI system with rules. Never mention a button unless the packet ui says a button is being shown.

Output JSON: {"reply": "<the message>"}. Nothing else.`;

const WRITER_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: { reply: { type: 'string', maxLength: 1800 } },
  required: ['reply']
};

// Lo que el redactor ve del paquete. Ni deterministic_text (no debe copiarlo)
// ni semantic_claims ni fuentes internas.
function writerViewOfPacket(packet = {}) {
  return {
    action: packet.action || null,
    action_result: packet.action_result || null,
    case_state: packet.case_state || null,
    first_contact: packet.first_contact === true,
    facts: (packet.facts || []).map((f) => ({ topic: f.topic, text: f.text })),
    numbers: (packet.numbers || []).map((n) => ({ label: n.label, value: n.formatted })),
    dates: (packet.dates || []).map((d) => ({ label: d.id, value: d.formatted })),
    apartments: packet.apartments || [],
    required_facts: (packet.required_facts || []).map((f) => ({ id: f.id, statement: f.statement })),
    suggested_goals: packet.suggested_goals || [],
    notes: packet.notes || [],
    forbidden: packet.forbidden_claims || [],
    ui: packet.ui || {}
  };
}

function buildWriterInput({ guestText, transcript = [], interpretation = null, packet, language, today, feedback = null }) {
  const turns = transcript.slice(-10).map((t) => ({
    who: t.role === 'guest' ? 'guest' : t.role === 'human' ? 'human_agent_jose_manuel' : 'cami',
    text: t.text
  }));
  const parts = [
    `Today (America/Bogota): ${today || 'unknown'}`,
    `Guest language: ${language || 'es'}`,
    `Recent conversation (oldest first):\n${JSON.stringify(turns)}`,
    `What you understood from the current message:\n${JSON.stringify(interpretation || {})}`,
    `Authorized packet from the system:\n${JSON.stringify(writerViewOfPacket(packet))}`,
    `Current guest message:\n${guestText}`
  ];
  if (feedback) {
    parts.push(`YOUR PREVIOUS DRAFT WAS REJECTED by the factual validator for these reasons: ${JSON.stringify(feedback)}. `
      + 'Write it again fixing exactly that: keep every number and date exactly as given, only listed apartments, and make sure every required fact is clearly communicated.');
  }
  return parts.join('\n\n');
}

/**
 * Escribe la respuesta al huesped. Devuelve { text, usage, latency_ms } o
 * { text: null, error_code } si el proveedor fallo. No valida: eso es del
 * orquestador (`resolveWrittenReply`), que llama al validador del PMS.
 */
async function writeGuestReply({ provider, timeoutMs, ...input }) {
  const startedAt = Date.now();
  try {
    const response = await provider.structured({
      schema: WRITER_SCHEMA, system: WRITER_SYSTEM_PROMPT,
      input: buildWriterInput(input), tools: [], timeoutMs
    });
    const reply = String(response?.output?.reply || '').trim();
    return { text: reply || null, usage: response?.usage || null, latency_ms: Date.now() - startedAt,
      model: provider.model || null };
  } catch (error) {
    return { text: null, error_code: String(error?.code || error?.message || 'writer_failed').slice(0, 80),
      latency_ms: Date.now() - startedAt, model: provider.model || null };
  }
}

/**
 * Orquesta: escribir -> validar (PMS) -> si falla, UNA regeneracion con el
 * motivo -> si vuelve a fallar, texto determinista. Nunca mas de dos
 * generaciones. `packet.deterministic_text` es el suelo seguro y siempre
 * existe.
 */
async function resolveWrittenReply({ packet, provider, pms, guestText, transcript, interpretation, language, today,
  timeoutMs, logger = console }) {
  const fallback = { text: packet?.deterministic_text ?? null, presentation_source: 'deterministic',
    attempts: 0, failure_reasons: [], latency_ms: 0, model: null };
  if (!packet?.deterministic_text || !provider) return fallback;

  let feedback = null;
  let latency = 0;
  const reasonsSeen = [];
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const written = await writeGuestReply({ provider, timeoutMs, guestText, transcript, interpretation, packet, language, today, feedback });
    latency += written.latency_ms || 0;
    if (!written.text) {
      reasonsSeen.push(written.error_code || 'writer_empty');
      logger.info('[writer] generation_failed', { attempt, code: written.error_code || 'writer_empty' });
      break; // un fallo de proveedor no se reintenta: el redactor no es reintento de red
    }
    let validation;
    try {
      validation = await pms.validateAuthorizedResponse({ packet, candidate_text: written.text });
    } catch (error) {
      reasonsSeen.push('validation_call_error');
      logger.error('[writer] validation_call_failed', { code: error?.code || error?.message || 'unknown' });
      break;
    }
    if (validation?.valid) {
      return { text: written.text, presentation_source: 'llm_written', attempts: attempt,
        failure_reasons: reasonsSeen, latency_ms: latency, model: written.model, usage: written.usage };
    }
    feedback = validation?.failure_reasons || ['validation_rejected'];
    reasonsSeen.push(...feedback);
    logger.info('[writer] candidate_rejected', { attempt, failure_reasons: feedback });
  }
  return { ...fallback, presentation_source: 'deterministic_after_rejection', attempts: 2,
    failure_reasons: reasonsSeen, latency_ms: latency };
}

module.exports = { writeGuestReply, resolveWrittenReply, buildWriterInput, writerViewOfPacket,
  WRITER_SYSTEM_PROMPT, WRITER_SCHEMA };
