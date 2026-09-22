'use strict';

// Enrutador de interpretacion -- BLOQUE C, secciones G/H/I.
//
// Es el unico punto del webhook que decide si un turno lo entiende la ruta
// conversacional nueva o la legacy. Deliberadamente NO decide nada mas: no
// compone mensajes, no cotiza, no elige apartamento. Todo eso sigue siendo
// determinista dentro de pms-lite, detras de authorized_response_packet y del
// validador de D3.2, que este cambio no toca.
//
// CONTRATO DE SALIDA. Devuelve exactamente lo mismo que PilotAi.interpret():
// la interpretacion legacy mas `_fallback`, `_error_code` y `_dependency`.
// Ni una clave mas, y esto no es cosmetico: publicInterpretation() reenvia al
// PMS TODO lo que no sean esas tres, asi que cualquier campo extra que se
// colara aqui viajaria a produccion como si fuera parte de la interpretacion.
// La observabilidad va al log, nunca al objeto devuelto.
//
// TRES CAIDAS A LEGACY, todas silenciosas para el huesped:
//   1. el gate no autoriza el telefono;
//   2. la ruta nueva falla (timeout, proveedor caido, lazo agotado);
//   3. la ruta nueva devuelve algo que no es una interpretacion utilizable.
// En los tres casos responde la legacy, que es el comportamiento de hoy.

const { evaluateConversationalRoute } = require('./route-gate.js');
const { interpretConversationally } = require('./conversational-engine.js');
const { createPmsToolExecutor } = require('./pms-executor.js');

// Lo que se registra de un turno de la ruta nueva. Sin texto del huesped, sin
// telefono, sin identificadores: solo lo que permite responder "¿funciono, que
// tools uso, cuanto costo y en que se diferencio del parser?".
function logConversationalTurn(logger, payload) {
  logger.log('[llm-route] conversational_turn', payload);
}

function createInterpretationRouter({ legacyAi, provider, pmsClient, logger = console,
  env = process.env, flags = {}, timeoutMs }) {

  if (!legacyAi || typeof legacyAi.interpret !== 'function') {
    throw Object.assign(new Error('legacy_ai_required'), { code: 'legacy_ai_required' });
  }

  async function interpret({ text, phone, today, context = {} }) {
    const gate = evaluateConversationalRoute(phone, env);

    if (!gate.allowed) {
      // A nivel debug: en produccion este caso es el 100% del trafico mientras
      // la ruta esta apagada, y registrarlo en info seria ruido puro.
      return legacyAi.interpret({ text, phone, today, context });
    }

    if (!provider) {
      logger.warn('[llm-route] provider_missing_falling_back_to_legacy');
      return legacyAi.interpret({ text, phone, today, context });
    }

    const startedAt = Date.now();
    let result;
    try {
      const executor = createPmsToolExecutor({
        pmsClient,
        // El contexto de la tool lo fija el webhook, no el modelo. `as_of` es
        // la fecha de referencia del turno: sin ella, disponibilidad y
        // cotizacion se resolverian contra el reloj del PMS en vez de contra
        // el dia que la conversacion da por hoy.
        context: { as_of: today },
        logger
      });

      result = await interpretConversationally({
        text,
        today,
        transcript: Array.isArray(context.transcript) ? context.transcript : [],
        commercialContext: context,
        language: context.language || null,
        pendingConfirmation: context.pending_confirmation || null,
        olderSummary: context.older_summary || null,
        caseState: context.case_state || null
      }, {
        provider,
        executor,
        logger,
        timeoutMs,
        // Por defecto la confirmacion semantica queda en observacion: hoy el
        // PMS no persiste `pending_confirmation`, y abrir una confirmacion que
        // nadie guarda produciria una pregunta que se repite cada turno.
        flags: { shadowParser: true, semanticConfirmation: false, ...flags }
      });
    } catch (error) {
      logger.error('[llm-route] conversational_route_threw', {
        code: String(error?.code || 'unknown').slice(0, 60),
        message: String(error?.message || '').slice(0, 200)
      });
      return legacyAi.interpret({ text, phone, today, context });
    }

    if (!result?.ok || !result.interpretation) {
      logConversationalTurn(logger, {
        outcome: 'fallback_to_legacy',
        error_code: result?.error_code || 'no_interpretation',
        tools_called: (result?.tool_trace || []).length,
        tool_names: (result?.tool_trace || []).map((entry) => entry.tool),
        latency_ms: Date.now() - startedAt
      });
      return legacyAi.interpret({ text, phone, today, context });
    }

    logConversationalTurn(logger, {
      outcome: 'ok',
      provider: provider.name || null,
      model: provider.model || null,
      tools_called: result.tool_trace.length,
      // Nombre y estado, nunca los argumentos: un argumento puede llevar texto
      // del huesped.
      tools: result.tool_trace.map((entry) => `${entry.tool}:${entry.status}`),
      iterations: result.iterations,
      usage: result.usage,
      // Diferencias contra el parser determinista. En SHADOW: se miden, no
      // deciden nada. Es el numero que dira si la ruta nueva entiende mejor.
      shadow_discrepancies: result.shadow?.discrepancies || null,
      confirmation_opened: Boolean(result.confirmation),
      latency_ms: result.latency_ms
    });

    return {
      ...result.interpretation,
      _fallback: false,
      _error_code: null,
      _dependency: null
    };
  }

  // Se reexpone el resto de la superficie de PilotAi por delegacion: hoy el
  // responder solo llama interpret(), pero devolver un objeto que solo tiene
  // interpret() convertiria cualquier uso futuro en un TypeError en
  // produccion en vez de un fallo de arranque.
  return {
    interpret,
    present: (...args) => legacyAi.present(...args),
    redact: (...args) => legacyAi.redact(...args),
    structured: (...args) => legacyAi.structured(...args)
  };
}

module.exports = { createInterpretationRouter };
