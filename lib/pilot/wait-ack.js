'use strict';

const WAIT_ACK_TEXT = '¡Hola! Recibimos tu mensaje. Estamos verificando disponibilidad y tarifa. En breve te responderemos por este mismo chat.';

function createWaitAck({ enabled = false, send, logger = console }) {
  return {
    async afterCapture({ captureResult, recipient }) {
      if (!enabled) return { sent: false, reason: 'disabled' };
      if (!captureResult?.created_interaction) {
        return { sent: false, reason: captureResult?.deduplicated ? 'deduplicated_capture' : 'capture_not_new' };
      }
      if (!recipient || typeof send !== 'function') return { sent: false, reason: 'not_configured' };

      try {
        await send(recipient, WAIT_ACK_TEXT);
        return { sent: true };
      } catch (error) {
        logger.warn('[pilot-wait-ack] failed_without_retry', {
          code: error?.code || 'wait_ack_failed',
          status: error?.response?.status || null,
        });
        return { sent: false, reason: 'failed_without_retry' };
      }
    },
  };
}

module.exports = { createWaitAck, WAIT_ACK_TEXT };

