'use strict';

// Objetivo persistente "Torre de Control -- notificaciones + refresco
// automatico" (2026-09-09): avisos push a Jose Manuel para eventos de
// negocio reales (lead nuevo, reserva confirmada), reusando ntfy.sh (mismo
// mecanismo ya probado para los avisos de Claude Code, pero en un topic
// NUEVO y separado -- ver reference_ntfy_notifications.md, no mezclar).
//
// NTFY_BUSINESS_TOPIC: topic privado de ntfy.sh para estos avisos.
// NTFY_BUSINESS_NOTIFY_ON: lista separada por comas de tipos de evento
// activos (ej. "lead,reserva"). Cambiar esta variable en Render (sin
// desplegar codigo nuevo) ajusta el nivel de detalle -- hoy en fase de
// estabilizacion Jose Manuel quiere ver todo; mas adelante puede dejar
// solo "reserva".
//
// Nunca deja que un fallo de ntfy rompa el flujo principal del webhook --
// siempre se llama en modo "fire and forget" con su propio catch.
const axios = require('axios');

function notifyOn(eventType) {
  const raw = process.env.NTFY_BUSINESS_NOTIFY_ON || '';
  const enabled = new Set(raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
  return enabled.has(eventType);
}

function asciiSanitize(value) {
  // Bug real ya documentado (reference_ntfy_notifications.md): caracteres
  // acentuados corrompen el header Title de ntfy -- el body si es UTF-8 seguro.
  return String(value).replace(/[^\x00-\x7F]/g, '');
}

async function sendNtfy({ topic, title, message, priority, tags }) {
  if (!topic) return { sent: false, reason: 'no_topic_configured' };
  try {
    await axios.post(`https://ntfy.sh/${topic}`, message, {
      headers: {
        'Title': asciiSanitize(title),
        'Priority': priority || 'default',
        ...(tags ? { 'Tags': tags } : {})
      },
      timeout: 5000
    });
    return { sent: true };
  } catch (error) {
    console.error('[ntfy-business] send_failed', { code: error.message });
    return { sent: false, reason: 'request_failed' };
  }
}

async function notifyBusinessEvent(eventType, { title, message, priority, tags } = {}) {
  const topic = process.env.NTFY_BUSINESS_TOPIC;
  if (!topic || !notifyOn(eventType)) return { sent: false, reason: 'not_configured_or_disabled' };
  return sendNtfy({ topic, title, message, priority, tags });
}

module.exports = { notifyBusinessEvent, notifyOn };
