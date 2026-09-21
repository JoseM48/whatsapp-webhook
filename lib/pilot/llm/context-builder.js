'use strict';

// buildConversationContext() -- Bloque B.
//
// El defecto que corrige es el mas caro de la auditoria: hoy el LLM recibe un
// objeto de casillas y NI UN SOLO turno anterior, asi que "el otro que me
// mostraste" es irresoluble por construccion, no por falta de modelo.
//
// Tres capas, no un volcado del historial:
//   1. ventana reciente  -- los ultimos N turnos, literales
//   2. estado estructurado -- commercial_context, que ya existe
//   3. resumen de lo antiguo -- un solo string, con provenance
//
// Presupuesto de tokens: el contexto NO crece con la conversacion. Ventana
// acotada + resumen de tope fijo = coste estable en el turno 3 y en el 300.

const { minimizeUserText } = require('../ai.js');

const DEFAULTS = {
  windowTurns: 6,          // ~3 intercambios: cubre las anaforas observadas
  maxContextTokens: 3000,
  maxWindowTokens: 1500,
  maxSummaryTokens: 300,
  charsPerToken: 4         // misma convencion que el gobierno de contexto
};

const estimateTokens = (text, charsPerToken) =>
  Math.ceil(String(text || '').length / charsPerToken);

// Lo que el modelo NO debe ver nunca, aunque venga en la fila.
const FORBIDDEN_KEYS = new Set([
  'phone', 'phone_hash', 'telefono', 'nombre', 'name', 'email', 'correo',
  'content_version_id', 'content_hash', 'lead_id', 'case_id', 'id'
]);

function scrubObject(value, depth = 0) {
  if (depth > 4 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => scrubObject(v, depth + 1));
  const out = {};
  for (const [key, val] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key)) continue;
    out[key] = scrubObject(val, depth + 1);
  }
  return out;
}

// Un turno del transcript. `text` ya viene minimizado: correos y telefonos
// redactados, longitud acotada. Se aplica a CADA turno, no solo al actual --
// que es lo que hace hoy el flujo y por eso solo protegia el ultimo mensaje.
function normalizeTurn(turn) {
  return {
    role: turn.role === 'guest' || turn.role === 'huesped' ? 'guest' : 'cami',
    text: minimizeUserText(turn.text),
    at: turn.at || null
  };
}

/**
 * @param {object}   input
 * @param {object}   input.commercialContext  role_state.commercial_context
 * @param {Array}    input.transcript         turnos ya ordenados, antiguo -> reciente
 * @param {string}   input.language           language_preference persistido
 * @param {object}   input.pendingConfirmation
 * @param {object}   input.olderSummary       { text, covers_turns, generated_at }
 * @param {string}   input.today              fecha en America/Bogota
 * @param {object}   options
 */
function buildConversationContext(input = {}, options = {}) {
  const cfg = { ...DEFAULTS, ...options };
  const transcript = Array.isArray(input.transcript) ? input.transcript : [];

  // Ventana: los mas recientes. Se recorta SIEMPRE por el extremo antiguo --
  // perder el ultimo turno seria perder justamente el que se esta respondiendo.
  let window = transcript.slice(-cfg.windowTurns).map(normalizeTurn);
  let windowTokens = window.reduce((sum, t) => sum + estimateTokens(t.text, cfg.charsPerToken), 0);
  let droppedForBudget = 0;
  while (window.length > 1 && windowTokens > cfg.maxWindowTokens) {
    window.shift();
    droppedForBudget += 1;
    windowTokens = window.reduce((sum, t) => sum + estimateTokens(t.text, cfg.charsPerToken), 0);
  }

  const olderCount = Math.max(0, transcript.length - window.length);
  let olderSummary = null;
  if (olderCount > 0 && input.olderSummary?.text) {
    const text = String(input.olderSummary.text).slice(0, cfg.maxSummaryTokens * cfg.charsPerToken);
    olderSummary = {
      text,
      // Provenance explicita: quien lo genero y que cubre. Un resumen sin
      // procedencia es indistinguible de una alucinacion persistida.
      covers_turns: input.olderSummary.covers_turns ?? olderCount,
      generated_at: input.olderSummary.generated_at ?? null,
      generated_by: input.olderSummary.generated_by ?? 'unknown'
    };
  }

  const context = {
    now: { today: input.today, tz: 'America/Bogota' },
    case: {
      language: input.language || 'es',
      turn_index: transcript.length,
      state: input.caseState || null
    },
    known: scrubObject(input.commercialContext || {}),
    current_proposal: input.commercialContext?.proposal_snapshot
      ? scrubObject(input.commercialContext.proposal_snapshot) : null,
    recent_turns: window,
    older_summary: olderSummary,
    pending_confirmation: input.pendingConfirmation
      ? scrubObject(input.pendingConfirmation) : null
  };

  const serialized = JSON.stringify(context);
  const totalTokens = estimateTokens(serialized, cfg.charsPerToken);

  return {
    context,
    meta: {
      window_turns: window.length,
      turns_available: transcript.length,
      turns_summarized: olderCount,
      dropped_for_budget: droppedForBudget,
      estimated_tokens: totalTokens,
      budget_tokens: cfg.maxContextTokens,
      // No aborta: informa. Quedarse sin contexto es peor que pasarse un poco,
      // pero pasarse en silencio es lo que no puede ocurrir.
      over_budget: totalTokens > cfg.maxContextTokens,
      summary_present: Boolean(olderSummary)
    }
  };
}

// Decide si hace falta regenerar el resumen. No se regenera en cada turno: solo
// cuando algo salio de la ventana y el resumen vigente ya no lo cubre.
function needsSummaryRefresh({ transcript = [], olderSummary = null }, options = {}) {
  const cfg = { ...DEFAULTS, ...options };
  const olderCount = Math.max(0, transcript.length - cfg.windowTurns);
  if (olderCount <= 0) return false;
  if (!olderSummary?.text) return true;
  return (olderSummary.covers_turns ?? 0) < olderCount;
}

module.exports = { buildConversationContext, needsSummaryRefresh, DEFAULTS, estimateTokens };
