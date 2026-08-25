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
          messageType: safeMessageType(message)
        });
      }
    }
  }
  return result;
}

function m0CommercialText(message) {
  return message.text || `[M0_UNSUPPORTED_INBOUND:${message.messageType}]`;
}

module.exports = { extractMetaMessages, m0CommercialText, textForMessage, safeMessageType };
