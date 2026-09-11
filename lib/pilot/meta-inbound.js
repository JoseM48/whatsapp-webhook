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

// Objetivo persistente "atribucion click-to-WhatsApp" (2026-09-10/11),
// pedido por Marketing: Meta adjunta este objeto SOLO en el primer mensaje
// de una conversacion iniciada desde un anuncio "click to WhatsApp" -- se
// pasa tal cual (forma libre, ver migracion 072 en pms-lite), nunca se
// reinterpreta aqui. null cuando esta ausente, mismo patron ya usado para
// audio/flow.
function safeReferral(message) {
  const referral = message?.referral;
  return referral && typeof referral === 'object' ? referral : null;
}

// Objetivo persistente "atribucion landing -> WhatsApp" (2026-09-10/11),
// pedido por Marketing: el landing (landing-la-frontera/index.html) ahora
// embebe un codigo [ref:utm_source:utm_medium:utm_campaign] al final del
// texto precargado del enlace wa.me (unico parametro que wa.me realmente
// respeta). Se extrae y se QUITA del texto aqui, antes de que llegue a la
// interpretacion de Cami -- el huesped nunca debe ver ni que Cami mencione
// un codigo de correlacion interno. Formato siempre parseable (3 segmentos
// exactos, "sin_dato" cuando el landing no tenia ese UTM) -- si no calza
// exactamente, se ignora sin tocar el texto (mejor no atribuir que romper
// un mensaje real por un codigo mal formado).
const LANDING_REF_PATTERN = /\s*\[ref:([^:\]]+):([^:\]]+):([^:\]]+)\]\s*$/;

function extractLandingRef(text) {
  if (!text) return { text, landingRef: null };
  const match = LANDING_REF_PATTERN.exec(text);
  if (!match) return { text, landingRef: null };
  return {
    text: text.slice(0, match.index).trim() || null,
    landingRef: { utm_source: match[1], utm_medium: match[2], utm_campaign: match[3] }
  };
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
        const { text: cleanText, landingRef } = extractLandingRef(textForMessage(message));
        result.push({
          from,
          text: cleanText,
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
          } : null,
          referral: safeReferral(message),
          landingRef
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

