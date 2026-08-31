'use strict';

function textForMessage(message) {
  if (message?.text?.body) return message.text.body.trim();
  if (message?.interactive?.button_reply?.title) return message.interactive.button_reply.title.trim();
  if (message?.interactive?.list_reply?.title) return message.interactive.list_reply.title.trim();
  return null;
}

function safeMessageType(message) {
  const value = String(message?.type || 'unsupported').toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 40);
  return value || 'unsupported';
}

function extractMetaMessages(payload) {
  const result = [];
  for (const entry of payload?.entry || []) {
    for (const change of entry?.changes || []) {
      const value = change?.value || {};
      const names = new Map((value.contacts || []).map((contact) => [String(contact?.wa_id || ''), contact?.profile?.name]));
      for (const message of value.messages || []) {
        const from = message?.from ? String(message.from) : null;
        if (!from) continue;
        const seconds = Number(message.timestamp);
        result.push({
          from,
          text: textForMessage(message),
          messageId: message?.id ? String(message.id) : null,
          timestamp: Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString() : new Date().toISOString(),
          name: names.get(from) || undefined,
          messageType: safeMessageType(message),
          audio: message?.type === 'audio' && message?.audio?.id ? {
            id: String(message.audio.id),
            mimeType: message.audio.mime_type ? String(message.audio.mime_type) : null
          } : null,
          flow: message?.type === 'interactive' && message?.interactive?.type === 'nfm_reply' ? {
            name: message.interactive.nfm_reply?.name ? String(message.interactive.nfm_reply.name) : null,
            responseJson: message.interactive.nfm_reply?.response_json || null
          } : null
        });
      }
    }
  }
  return result;
}

function extractMetaStatuses(payload) {
  const result = [];
  const allowed = new Set(['sent', 'delivered', 'read', 'failed']);
  for (const entry of payload?.entry || []) {
    for (const change of entry?.changes || []) {
      for (const status of change?.value?.statuses || []) {
        const providerReference = status?.id ? String(status.id) : null;
        const recipientId = status?.recipient_id ? String(status.recipient_id) : null;
        const providerStatus = String(status?.status || '').toLowerCase();
        const seconds = Number(status?.timestamp);
        if (!providerReference || !recipientId || !allowed.has(providerStatus) || !Number.isFinite(seconds)) continue;
        const rawCode = status?.errors?.[0]?.code;
        const errorCode = rawCode == null ? null : String(rawCode).replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, 80) || null;
        result.push({
          providerReference,
          recipientId,
          status: providerStatus,
          timestamp: new Date(seconds * 1000).toISOString(),
          errorCode
        });
      }
    }
  }
  return result;
}

function m0CommercialText(message) {
  return message.text || `[M0_UNSUPPORTED_INBOUND:${message.messageType}]`;
}

module.exports = {
  extractMetaMessages, extractMetaStatuses, m0CommercialText, textForMessage, safeMessageType
};

