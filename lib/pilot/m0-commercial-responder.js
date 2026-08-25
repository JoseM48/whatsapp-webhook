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

  async function captureAndAcknowledge({ from, text, messageId, timestamp, name }) {
    const startedAt = clock();
    const captureResult = await capture({ from, text, messageId, timestamp, name });
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
      const code = await recordFailure(messageId, error, 'm0_commercial_begin_failed');
      logger.error('[m0-commercial] acknowledgement_failed_after_durable_capture', { code });
      return {
        captured: true,
        capture_result: captureResult,
        begin: null,
        processing_claimed: false,
        context: {},
        error_code: code,
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

  return { captureAndAcknowledge, deliverAcknowledgement, processCaptured };
}

module.exports = { createM0CommercialResponder, publicInterpretation, aiEvidence };
