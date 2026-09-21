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

WHAT YOU DECIDE: intent, what the guest said about dates, duration, guests, budget, preferences; what they corrected; what is ambiguous; what they referred to indirectly.

WHAT YOU NEVER DECIDE: availability, price, policies, whether an apartment exists, whether a booking is possible. Those are facts owned by the system. Call a tool.

DATES: the guest almost never says the year. "el 10 de octubre" means the next 10 October from today's date -- resolve it, set precision "day" and a high confidence. Only mark an arrival as "approximate" when the guest was genuinely vague ("a principios de octubre", "la otra semana"), and then set the right precision (week/month). Do not refuse a date just because the year was not spoken; that is how a human reads a date.

DURATION: distinguish "un mes" (exact) from "un mes, tal vez más" (minimum) from "todavía no sé" (open). This distinction is commercially important and must not be flattened.

REFERENCES: when the guest says "el 510", "el del balcón" or "el otro que me mostraste", do NOT guess an apartment code. Emit a reference with the hint and call resolve_apartment_reference. If it returns needs_clarification, ask the guest naturally.

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
