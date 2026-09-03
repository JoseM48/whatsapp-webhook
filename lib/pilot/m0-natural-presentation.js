'use strict';

// Incremento D3.3 (2026-09-03): orquesta redaccion IA (PilotAi.redact, D3.3)
// + validacion determinista (validateAuthorizedResponse via HTTP a pms-lite,
// D3.2, nunca reimplementada aqui) detras de una bandera con default
// seguro OFF. Con la bandera apagada -- el estado por defecto, y el unico
// permitido para huespedes reales al cerrar este incremento -- esta funcion
// devuelve deterministic_text de inmediato, sin ninguna llamada a `ai` ni a
// `pms`: exactamente el mismo comportamiento visible de antes de D3.3.
//
// Una sola generacion como maximo. Cualquier error (IA, red, validacion, o
// un candidato invalido) produce fallback determinista -- nunca un segundo
// intento de generacion.

function isNaturalPresentationEnabled(env = process.env) {
  return String(env.M0_NATURAL_PRESENTATION_ENABLED || '').trim().toLowerCase() === 'true';
}

async function resolveNaturalPresentation({ packet, phone, ai, pms, enabled, logger = console }) {
  if (!enabled || !packet || !packet.deterministic_text) {
    return { text: packet?.deterministic_text ?? null, presentation_source: 'deterministic',
      attempted: false, failure_reasons: [], latency_ms: 0, model: null };
  }

  let redaction;
  try {
    redaction = await ai.redact({ packet, phone });
  } catch (error) {
    logger.error('[m0-natural-presentation] redact_call_failed', {
      code: error?.code || error?.message || 'unknown'
    });
    return { text: packet.deterministic_text, presentation_source: 'ai_fallback',
      attempted: true, failure_reasons: ['redaction_call_error'], latency_ms: 0, model: null };
  }

  if (redaction?._fallback || !redaction?.text) {
    logger.info('[m0-natural-presentation] redaction_fallback', {
      code: redaction?._error_code || 'ai_redaction_fallback', latency_ms: redaction?.latency_ms ?? null
    });
    return { text: packet.deterministic_text, presentation_source: 'ai_fallback',
      attempted: true, failure_reasons: [redaction?._error_code || 'ai_redaction_fallback'],
      latency_ms: redaction?.latency_ms ?? 0, model: redaction?.model ?? null };
  }

  let validation;
  try {
    validation = await pms.validateAuthorizedResponse({ packet, candidate_text: redaction.text });
  } catch (error) {
    logger.error('[m0-natural-presentation] validation_call_failed', {
      code: error?.code || error?.message || 'unknown'
    });
    return { text: packet.deterministic_text, presentation_source: 'ai_fallback',
      attempted: true, failure_reasons: ['validation_call_error'],
      latency_ms: redaction.latency_ms, model: redaction.model };
  }

  if (!validation?.valid) {
    logger.info('[m0-natural-presentation] candidate_rejected', {
      failure_reasons: validation?.failure_reasons || ['validation_rejected']
    });
    // Descarta el candidato COMPLETO -- nunca se intenta reparar ni mezclar
    // con el texto deterministico. Nunca se reintenta una segunda
    // generacion (regla explicita de D3.3).
    return { text: packet.deterministic_text, presentation_source: 'ai_fallback',
      attempted: true, failure_reasons: validation?.failure_reasons || ['validation_rejected'],
      latency_ms: redaction.latency_ms, model: redaction.model };
  }

  return { text: redaction.text, presentation_source: 'ai_validated',
    attempted: true, failure_reasons: [], latency_ms: redaction.latency_ms, model: redaction.model };
}

module.exports = { isNaturalPresentationEnabled, resolveNaturalPresentation };
