'use strict';

function createTypingIndicator({ enabled = false, send, logger = console }) {
  return {
    async show(messageId) {
      if (!enabled) return { sent: false, reason: 'disabled' };
      if (!messageId || typeof send !== 'function') return { sent: false, reason: 'not_configured' };
      try {
        await send({
          messaging_product: 'whatsapp',
          status: 'read',
          message_id: messageId,
          typing_indicator: { type: 'text' },
        });
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

