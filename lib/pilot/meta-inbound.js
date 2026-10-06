'use strict';

const { mediaDeMensaje } = require('./inbound-media');

// Revision de conversaciones 2026-10-05 (V5): un mensaje de tipo `order` (el
// huesped toco "enviar al negocio" en el catalogo que muestra un anuncio) no
// trae texto y llegaba como "[M0_UNSUPPORTED_INBOUND:order]"; Cami contestaba
// "No logré entender tu pedido" (lead 113). Es una intencion de cotizar: se
// convierte en una solicitud de informacion explicita, con la nota que el
// huesped haya escrito en el carrito si existe. No se inventa ningun dato de
// estadia (fechas, personas): Cami los pide como en cualquier primer contacto.
// El prefijo entre corchetes deja visible la procedencia (no lo escribio el huesped).
const TEXTO_PEDIDO_CATALOGO = '[Pedido desde el catálogo de WhatsApp] Quiero información sobre los apartamentos disponibles.';
function textoDePedido(order) {
  const nota = typeof order?.text === 'string' ? order.text.trim().slice(0, 500) : '';
  return nota ? `${TEXTO_PEDIDO_CATALOGO} ${nota}` : TEXTO_PEDIDO_CATALOGO;
}

function textForMessage(message) {
  if (message?.text?.body) return message.text.body.trim();
  if (message?.type === 'order') return textoDePedido(message.order);
  if (message?.interactive?.button_reply?.title) return message.interactive.button_reply.title.trim();
  if (message?.interactive?.list_reply?.title) return message.interactive.list_reply.title.trim();
  // Boton de respuesta rapida "Ver detalle" de la plantilla corta del aviso
  // interno (2026-10-06): Meta lo entrega como type 'button', no como
  // interactive. Solo ese boton: los botones de plantillas de huesped siguen
  // llegando como antes (revision independiente 2026-10-06).
  if (message?.type === 'button' && /^ver detalle$/i.test(String(message?.button?.text || '').trim())) {
    return 'Ver detalle';
  }
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
          // Fase 3 (2026-09-28): imagen, documento, video o sticker. Se
          // descarga en index.js antes de capturar (ver inbound-media.js).
          media: mediaDeMensaje(message),
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
  extractMetaMessages, extractMetaStatuses, m0CommercialText, textForMessage, safeMessageType, TEXTO_PEDIDO_CATALOGO
};

