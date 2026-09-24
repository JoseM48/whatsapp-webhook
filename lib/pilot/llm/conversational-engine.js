'use strict';

// Motor conversacional LLM-primary -- Bloque B.
//
// Es la RUTA NUEVA. La vieja (interpret() + reconcileInterpretation()) sigue
// intacta y es la que corre con las banderas apagadas.
//
// Decision arquitectonica confirmada por Jose Manuel (2026-09-21): en esta
// ruta los parsers semanticos NO participan en ninguna decision de runtime.
// No completan campos, no interpretan fechas, duracion, huespedes, idioma ni
// correcciones, no modifican argumentos de tools, no deciden preguntas, no
// provocan confirmaciones y no cambian el flujo.
//
// Pueden ejecutarse en SHADOW MODE: su salida se registra y se compara, y no
// modifica absolutamente nada. Esa comparacion es el dato que permitira decidir
// con evidencia si algun dia se retiran del todo.
//
// Los VALIDADORES deterministas permanecen intactos y siguen mandando:
// validateAuthorizedResponse() es lo que impide alucinar y no se toca.

const { runToolLoop } = require('./tool-runner.js');
const { interpretationSchemaV2, projectToLegacyInterpretation } = require('./interpretation-schema-v2.js');
const { buildConversationContext } = require('./context-builder.js');
const { evaluateConfirmationNeed, openConfirmation, resolveConfirmation,
  actionIsBlocked, STATUS } = require('./semantic-confirmation.js');
const { deterministicInterpret } = require('../ai.js');

const SYSTEM_PROMPT = `You are the comprehension layer of Cami, the WhatsApp assistant for Mío La Frontera (furnished apartment rentals in El Poblado, Medellín).

YOUR JOB: understand what the guest means, in context. You are reading a real conversation, not a form.

YOU NEVER REPLY TO THE GUEST. Another system writes the message; you only produce the interpretation object. So you must ALWAYS finish the turn by emitting that object, whatever the tools said. Not knowing something is a valid interpretation -- record it in 'ambiguity' and emit. Refusing to emit because a tool could not answer leaves the guest with no reply at all.

WHAT YOU DECIDE: intent, what the guest said about dates, duration, guests, budget, preferences; what they corrected; what is ambiguous; what they referred to indirectly.

WHAT YOU NEVER DECIDE: availability, price, policies, whether an apartment exists, whether a booking is possible. Those are facts owned by the system. Call a tool.

DATES: the guest almost never says the year. "el 10 de octubre" means the next 10 October from today's date -- resolve it, set precision "day" and a high confidence. Only mark an arrival as "approximate" when the guest was genuinely vague ("a principios de octubre", "la otra semana"), and then set the right precision (week/month). Do not refuse a date just because the year was not spoken; that is how a human reads a date.

DURATION: always express it in NIGHTS. A month means 30 nights, so "3 meses" is 90. Never leave nights null when the guest stated a duration in months or weeks -- converting is your job, and the rest of the system only reads nights. Separately, distinguish "un mes" (exact) from "un mes, tal vez más" (minimum) from "todavía no sé" (open). That distinction is commercially important and must not be flattened.

REFERENCES: when the guest says "el 510", "el del balcón" or "el otro que me mostraste", do NOT guess an apartment code. Emit a reference with the hint and call resolve_apartment_reference. When it answers 'ok', WRITE the apartment_code it returned into that reference's resolved_code -- that field is how the rest of the system learns which apartment the guest meant, and leaving it null throws the answer away. Leave it null only when the tool did not resolve it, and then ask the guest naturally.

NEVER REPEAT A TOOL CALL with the same arguments: these tools have no side effects, so the answer will be identical. If a tool told you it cannot resolve something, that is the answer for this turn -- record it in 'ambiguity' and move on. Asking twice only wastes the conversation.

TOOL RESULTS ARE FACTS, NOT SUGGESTIONS: a tool that answers 'ok' has RESOLVED the question. Use its value and do not report ambiguity about something a tool just settled -- if resolve_apartment_reference returns LF-210, the apartment is LF-210. Only 'needs_clarification' means it is still open, and only 'unavailable' or 'error' mean you could not find out.

REPAIRED OR INFERRED VALUES KEEP THEIR DOUBT: when you had to repair an implausible value, or choose between more than one reasonable reading, say so in the signals -- set the arrival 'approximate' rather than 'exact', and lower the confidence. A guest typing a year of 1026 almost certainly means 2026, and reading it that way is useful; reporting it as a value you are sure of is not, because the rest of the system will quote on it without asking. Interpret tentatively, and let the doubt show. A value the guest wrote plainly keeps its high confidence -- this is not a reason to doubt everything.

CANCELLATION IS NOT NEGOTIATION: set cancellation_request when the guest wants to undo a booking, pre-reservation or request they already made -- "CANCELAR", "quiero cancelar", "ya no me interesa", "deja así". Do NOT set exception_request for a plain cancellation; that field is for discounts and special conditions, and routing a cancellation there leaves the guest's pre-reservation alive while a human is asked to decide something nobody needed to decide. A question about the cancellation POLICY, with no intent to cancel now, is a knowledge question instead.

AMBIGUITY: when you genuinely cannot resolve something, say so in 'ambiguity' instead of inventing a value. That is a correct answer, not a failure.

UNMAPPED MEANING: if the guest said something meaningful that no field can hold, put it in 'unmapped_meaning'. Never discard it silently.

CONFIDENCE: be honest. Low confidence on a field that affects price will trigger a confirmation, which is the desired behaviour -- not a penalty.`;

/**
 * Interpreta un turno con el LLM como autoridad semantica.
 *
 * @param {object} deps.provider   adapter de proveedor
 * @param {object} deps.executor   ejecutor de read tools
 * @param {object} deps.flags      banderas de comportamiento
 */
async function interpretConversationally({ text, today, transcript, commercialContext,
  language, pendingConfirmation, olderSummary, caseState }, deps = {}) {

  const { provider, executor, flags = {}, logger = console, contextOptions = {} } = deps;
  const startedAt = Date.now();

  const built = buildConversationContext({
    commercialContext, transcript, language, pendingConfirmation, olderSummary, today, caseState
  }, contextOptions);

  const input = `Conversation context:\n${JSON.stringify(built.context)}\n\nCurrent guest message:\n${text}`;

  // La traza vive fuera del try: si el lazo falla a mitad, saber QUE tools se
  // alcanzaron a llamar es justo lo que permite diagnosticar. Perderla fue lo
  // que hizo parecer que no se invocaba ninguna tool.
  const traceRef = { trace: [] };
  let loop;
  try {
    loop = await runToolLoop({ traceRef,
      provider, schema: interpretationSchemaV2, system: SYSTEM_PROMPT, input,
      executor, timeoutMs: deps.timeoutMs, logger
    });
  } catch (error) {
    return {
      ok: false, fallback: true,
      error_code: String(error?.code || 'llm_interpretation_failed'),
      retryable: Boolean(error?.retryable),
      tool_trace: traceRef.trace,
      context_meta: built.meta,
      latency_ms: Date.now() - startedAt
    };
  }

  if (!loop.output) {
    return {
      ok: false, fallback: true,
      error_code: loop.stop_reason === 'max_iterations_exceeded' ? 'tool_loop_exhausted' : 'llm_no_output',
      tool_trace: loop.trace, usage: loop.usage,
      context_meta: built.meta, latency_ms: Date.now() - startedAt
    };
  }

  const v2 = loop.output;
  const legacy = projectToLegacyInterpretation(v2);

  // --- SHADOW MODE -------------------------------------------------------
  // El parser corre solo para comparar. Su salida NO toca `legacy` ni `v2`.
  // Si esta linea alguna vez modifica algo, se rompio la decision del 21-sep.
  let shadow = null;
  if (flags.shadowParser !== false) {
    try {
      const det = deterministicInterpret(text, { today, context: commercialContext || {} });
      shadow = {
        discrepancies: diffInterpretations(det, legacy),
        deterministic: {
          check_in: det.check_in, check_in_status: det.check_in_status,
          nights: det.nights, guests: det.guests,
          requested_apartment_code: det.requested_apartment_code, language: det.language
        }
      };
    } catch (error) {
      shadow = { error: String(error?.message || 'shadow_failed').slice(0, 120) };
    }
  }

  // --- confirmacion semantica -------------------------------------------
  let confirmation = null;
  let confirmationResolution = null;

  if (flags.semanticConfirmation) {
    if (pendingConfirmation && pendingConfirmation.status === STATUS.AWAITING) {
      confirmationResolution = resolveConfirmation(pendingConfirmation, v2, {
        affirmative: detectAffirmative(text)
      });
    }
    const evaluation = evaluateConfirmationNeed(v2, commercialContext, {
      recentCorrections: deps.recentCorrections || [],
      toolTrace: loop.trace,
      pendingAction: deps.pendingAction || null
    });
    if (evaluation.required && !(confirmationResolution?.outcome === STATUS.CONFIRMED)) {
      confirmation = openConfirmation({ evaluation, v2, context: commercialContext });
    }
  }

  return {
    ok: true, fallback: false,
    interpretation: legacy,
    v2,
    confirmation,
    confirmation_resolution: confirmationResolution,
    action_blocked: actionIsBlocked(confirmation || confirmationResolution?.pending),
    tool_trace: loop.trace,
    usage: loop.usage,
    provider_meta: loop.meta,
    shadow,
    context_meta: built.meta,
    iterations: loop.iterations,
    latency_ms: Date.now() - startedAt
  };
}

// Discrepancias LLM vs parser, solo para observabilidad.
function diffInterpretations(deterministic, llm) {
  const fields = ['check_in', 'check_in_status', 'nights', 'guests', 'requested_apartment_code', 'language'];
  const out = [];
  for (const field of fields) {
    const a = deterministic[field] ?? null;
    const b = llm[field] ?? null;
    if (a !== b) out.push({ field, deterministic: a, llm: b });
  }
  return out;
}

// Afirmacion/negacion explicita para resolver una confirmacion abierta.
// Deliberadamente estrecho: ante la duda devuelve null y la confirmacion
// queda `ambiguous`, que es lo seguro. Esto NO es interpretacion semantica
// del mensaje -- es la lectura de un si/no a una pregunta que acabamos de
// hacer, y sigue sin decidir ningun campo.
function detectAffirmative(text) {
  const value = String(text || '').trim().toLowerCase();
  if (/^(s[ií]|correcto|exacto|as[ií] es|perfecto|confirmo|dale|ok|okay|yes|right)\b/.test(value)) return true;
  if (/^(no|incorrecto|nope|negativo)\b/.test(value)) return false;
  return null;
}

module.exports = { interpretConversationally, SYSTEM_PROMPT, diffInterpretations, detectAffirmative };
