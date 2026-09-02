'use strict';

const { safeErrorCode } = require('./orchestrator');

function publicInterpretation(value = {}) {
  const {
    _fallback: _ignoredFallback,
    _error_code: _ignoredError,
    _dependency: _ignoredDependency,
    ...interpretation
  } = value;
  return interpretation;
}

function aiEvidence(value = {}) {
  return {
    fallback: value._fallback === true,
    error_code: value._error_code || null,
    dependency_code: value._dependency?.code || null
  };
}

function elapsedMs(startedAt, clock) {
  return Math.max(0, Number((clock() - startedAt).toFixed(3)));
}

function createM0CommercialResponder({ capture, ai, closedPilot, pms, logger = console,
  clock = () => Number(process.hrtime.bigint()) / 1e6 }) {
  if (typeof capture !== 'function' || !ai || !closedPilot || !pms) {
    throw new Error('m0_commercial_responder_dependencies_required');
  }

  async function recordFailure(externalMessageId, error, fallback = 'm0_commercial_processing_failed') {
    const code = safeErrorCode(error, fallback);
    try {
      await pms.processingFailure({ external_message_id: externalMessageId, error_code: code, retryable: true });
    } catch (persistenceError) {
      logger.error('[m0-commercial] processing_failure_persistence_failed', {
        code: safeErrorCode(persistenceError, 'processing_failure_persistence_failed')
      });
    }
    return code;
  }

  // Incremento 062: punto unico de manejo de errores de admision/captura.
  // Nunca deja al cliente en silencio -- intenta, en este orden: registrar
  // el error de forma durable y idempotente en PMS (evita una segunda
  // alerta/respuesta si el mismo evento se reintenta, incluso si esta
  // funcion se invoca mas de una vez para el mismo mensaje), y entregar
  // las dos salidas que ese registro ya deja encoladas (alerta interna +
  // respuesta segura al cliente) usando el mismo mecanismo de entrega que
  // el resto del sistema. Si ni siquiera el registro durable se pudo
  // completar, devuelve handled:false -- ahi si corresponde un 5xx real,
  // porque no queda ninguna evidencia de que el error se atendio.
  async function handleAdmissionError({ from, messageId, timestamp, error }) {
    const code = safeErrorCode(error, 'm0_commercial_admission_failed');
    logger.error('[m0-commercial] admission_error', { code, message_id_present: Boolean(messageId) });
    let recorded;
    try {
      recorded = await pms.recordM0AdmissionError({
        phone: from, external_message_id: messageId, error_code: code, occurred_at: timestamp
      });
    } catch (recordError) {
      logger.error('[m0-commercial] admission_error_record_failed', {
        code: safeErrorCode(recordError, 'admission_error_record_failed')
      });
      return { handled: false, code };
    }
    if (recorded?.first_occurrence) {
      try {
        const deliveries = await closedPilot.deliverCommercialOutboxes(recorded.outboxes || []);
        logger.info('[m0-commercial] admission_error_handled', {
          code, deliveries: deliveries.map((item) => item.status)
        });
      } catch (deliveryError) {
        // La entrega es best-effort: el registro durable (log + evento en
        // PMS) ya existe de todas formas, asi que esto no vuelve a lanzar.
        logger.error('[m0-commercial] admission_error_delivery_failed', {
          code: safeErrorCode(deliveryError, 'admission_error_delivery_failed')
        });
      }
    } else {
      logger.info('[m0-commercial] admission_error_deduplicated', { code });
    }
    return { handled: true, code };
  }

  async function captureAndAcknowledge({ from, text, messageId, timestamp, name }) {
    const startedAt = clock();
    let captureResult;
    try {
      captureResult = await capture({ from, text, messageId, timestamp, name });
    } catch (error) {
      const outcome = await handleAdmissionError({ from, messageId, timestamp, error });
      if (!outcome.handled) throw error; // fallo verdaderamente no manejado -- deja que el 5xx exista
      return {
        captured: false,
        capture_result: null,
        begin: null,
        processing_claimed: false,
        context: {},
        acknowledgement_outboxes: [],
        error_code: outcome.code,
        admission_error_handled: true,
        timings: { capture_ms: elapsedMs(startedAt, clock), acknowledge_ms: elapsedMs(startedAt, clock) }
      };
    }
    const captureMs = elapsedMs(startedAt, clock);
    try {
      const begin = await closedPilot.beginCommercial({ phone: from, messageId, occurredAt: timestamp, deliver: false });
      return {
        captured: true,
        capture_result: captureResult,
        begin,
        processing_claimed: begin?.result?.processing_claimed === true,
        context: begin?.result?.context || {},
        acknowledgement_outboxes: begin?.result?.outboxes || [],
        timings: { capture_ms: captureMs, acknowledge_ms: elapsedMs(startedAt, clock) }
      };
    } catch (error) {
      await recordFailure(messageId, error, 'm0_commercial_begin_failed');
      const outcome = await handleAdmissionError({ from, messageId, timestamp, error });
      if (!outcome.handled) throw error;
      return {
        captured: true,
        capture_result: captureResult,
        begin: null,
        processing_claimed: false,
        context: {},
        acknowledgement_outboxes: [],
        error_code: outcome.code,
        admission_error_handled: true,
        timings: { capture_ms: captureMs, acknowledge_ms: elapsedMs(startedAt, clock) }
      };
    }
  }

  async function processCaptured({ from, text, messageId, today, context = {}, processingClaimed = true }) {
    if (!processingClaimed) return { ok: true, skipped: 'not_claimed' };
    const startedAt = clock();
    try {
      const interpreted = await ai.interpret({ text, phone: from, today, context });
      const completed = await closedPilot.completeCommercial({
        externalMessageId: messageId,
        interpretation: publicInterpretation(interpreted),
        ai: aiEvidence(interpreted)
      });
      return {
        ok: true,
        completed,
        fallback: interpreted._fallback === true,
        timings: { response_ms: elapsedMs(startedAt, clock) }
      };
    } catch (error) {
      const code = await recordFailure(messageId, error);
      logger.error('[m0-commercial] processing_failed_after_durable_capture', {
        message_id_present: Boolean(messageId), code
      });
      return { ok: false, code, timings: { response_ms: elapsedMs(startedAt, clock) } };
    }
  }

  async function deliverAcknowledgement(outboxes = []) {
    return closedPilot.deliverCommercialOutboxes(outboxes);
  }

  return { captureAndAcknowledge, deliverAcknowledgement, processCaptured, handleAdmissionError };
}

module.exports = { createM0CommercialResponder, publicInterpretation, aiEvidence };
