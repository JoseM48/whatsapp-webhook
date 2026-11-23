'use strict';

function createTypingIndicator({ enabled = false, send, logger = console }) {
  return {
    // `phoneNumberId` (P5, A22): número que recibió el mensaje. Sin él, el envío es
    // exactamente el de siempre (Miu).
    async show(messageId, { phoneNumberId = null } = {}) {
      if (!enabled) return { sent: false, reason: 'disabled' };
      if (!messageId || typeof send !== 'function') return { sent: false, reason: 'not_configured' };
      try {
        const payload = {
          messaging_product: 'whatsapp',
          status: 'read',
          message_id: messageId,
          typing_indicator: { type: 'text' },
        };
        await (phoneNumberId ? send(payload, { phoneNumberId }) : send(payload));
        return { sent: true };
      } catch (error) {
        logger.warn('[pilot-typing] failed', {
          code: error?.code || 'typing_indicator_failed',
          status: error?.response?.status || null,
        });
        return { sent: false, reason: 'failed' };
      }
    },
  };
}

module.exports = { createTypingIndicator };

