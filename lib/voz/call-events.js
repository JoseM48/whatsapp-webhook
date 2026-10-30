'use strict';

// Lectura de eventos de llamadas. Funciones puras, sin red.
//
// 1. Meta, campo `calls` del webhook (connect / terminate). En modo SIP Meta
//    solo los manda si se activa `webhook_delivery`; si llegan, se registran
//    contra el lead. El webhook NO contesta llamadas por esta via (exigiria
//    WebRTC, que Render no permite): el audio va por SIP directo a OpenAI.
// 2. OpenAI, webhook `realtime.call.incoming`: id de la llamada y cabeceras
//    SIP, de donde sale el telefono (From) y el id de Meta (x-wa-meta-wacid).
//    Las cabeceras SIP son metadatos del llamante: sirven para ligar el lead,
//    nunca como autorizacion.

function digitosTelefono(valor) {
  const d = String(valor ?? '').replace(/\D/g, '');
  return d.length >= 8 && d.length <= 15 ? d : null;
}

function segundosAIso(valor) {
  const n = Number(valor);
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000).toISOString() : new Date().toISOString();
}

function extractMetaCalls(payload) {
  const out = [];
  for (const entry of payload?.entry || []) {
    for (const change of entry?.changes || []) {
      if (change?.field !== 'calls') continue;
      for (const call of change?.value?.calls || []) {
        const id = call?.id ? String(call.id).slice(0, 300) : null;
        const evento = String(call?.event || '').toLowerCase().replace(/[^a-z_]/g, '').slice(0, 40);
        if (!id || !evento) continue;
        const duracion = Number(call?.duration);
        out.push({
          wacid: id,
          evento,
          direccion: call?.direction ? String(call.direction).slice(0, 40) : null,
          estado: call?.status ? String(call.status).slice(0, 40) : null,
          telefono: digitosTelefono(call?.from),
          duracionSegundos: Number.isInteger(duracion) && duracion >= 0 ? duracion : null,
          ocurridoAt: segundosAIso(call?.timestamp),
        });
      }
    }
  }
  return out;
}

function isCallsOnlyPayload(payload) {
  const changes = (payload?.entry || []).flatMap((entry) => entry?.changes || []);
  return changes.length > 0 && changes.every((change) => change?.field === 'calls');
}

function sipHeader(headers, nombre) {
  const buscado = String(nombre).toLowerCase();
  const h = (Array.isArray(headers) ? headers : []).find((item) => String(item?.name || '').toLowerCase() === buscado);
  return h?.value == null ? null : String(h.value);
}

// From: "Nombre" <sip:+573001234567@dominio>;tag=...  -> 573001234567
// Si Meta manda un identificador opaco en vez del numero, devuelve null.
function telefonoDeSip(valor) {
  if (!valor) return null;
  const m = /sips?:([^@;>]+)@/i.exec(String(valor));
  if (!m) return null;
  const usuario = m[1].trim();
  return /^\+?\d{8,15}$/.test(usuario) ? usuario.replace(/\D/g, '') : null;
}

// Diagnostico del ruteo al numero de TenGo Camello (2026-10-30): delante de
// OpenAI hay un proxy (Kamailio) que reescribe la Request-URI y deja From/To
// intactos, pero aun no esta verificado que Meta mande el numero del negocio en
// To. Solo los NOMBRES de las cabeceras recibidas, en minuscula, nunca valores.
function nombresCabecerasSip(headers) {
  const nombres = [];
  for (const h of Array.isArray(headers) ? headers : []) {
    const n = String(h?.name ?? '').trim().toLowerCase();
    if (/^[a-z0-9_.-]{1,60}$/.test(n) && !nombres.includes(n)) nombres.push(n);
    if (nombres.length >= 30) break;
  }
  return nombres;
}

function parseOpenAiCallIncoming(event) {
  if (event?.type !== 'realtime.call.incoming') return null;
  const callId = event?.data?.call_id ? String(event.data.call_id) : null;
  if (!callId || !/^[A-Za-z0-9_-]{3,200}$/.test(callId)) return null;
  const headers = event?.data?.sip_headers;
  return {
    callId,
    telefono: telefonoDeSip(sipHeader(headers, 'From')) || telefonoDeSip(sipHeader(headers, 'P-Asserted-Identity')),
    wacid: (sipHeader(headers, 'x-wa-meta-wacid') || '').slice(0, 300) || null,
    // Número LLAMADO (cabecera To), si Meta lo manda como número. Sirve para
    // que una llamada al número de TenGo Camello no llegue a Cami de Miu
    // (2026-10-28); null si no es un número.
    destino: telefonoDeSip(sipHeader(headers, 'To')),
    // phone_number_id del número LLAMADO (cabecera x-wa-meta-phone-number-id de Meta).
    // Es la señal confiable para el 7355: la llamada de prueba del 2026-10-30 traía
    // un To que no coincidía con el número publicado. Solo dígitos, o null.
    destinoId: /^\d{5,30}$/.test(String(sipHeader(headers, 'x-wa-meta-phone-number-id') || '').trim())
      ? String(sipHeader(headers, 'x-wa-meta-phone-number-id')).trim() : null,
    sipHeaderNames: nombresCabecerasSip(headers),
  };
}

module.exports = { extractMetaCalls, isCallsOnlyPayload, parseOpenAiCallIncoming, telefonoDeSip, sipHeader, digitosTelefono };
