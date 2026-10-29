'use strict';

// SEGUNDO NÚMERO DE WHATSAPP: TenGo Camello (2026-10-28; PMS migración 1050).
//
// Enrutamiento por el número que RECIBE el mensaje
// (entry[].changes[].value.metadata.phone_number_id), fail-closed:
//   - igual a PHONE_NUMBER_ID, o ausente      -> Miu, camino de siempre, intacto;
//   - igual a TENGOCAMELLO_PHONE_NUMBER_ID    -> TenGo Camello (si la variable existe);
//   - cualquier otro                          -> log sin datos personales; no se responde.
// Si todos los cambios son de Miu, el cuerpo original se devuelve TAL CUAL
// (misma referencia): el camino de Miu no ve ninguna diferencia.
//
// Camino TenGo: solo mensajes. Cada mensaje se reenvía al PMS
// (POST /api/tengocamello/whatsapp/inbound, misma firma HMAC que el resto) y lo
// que el PMS devuelve se envía DESDE el número de TenGo. Llamadas (`calls`) y
// estados (`statuses`) de ese número se ignoran con log: nunca llegan a Cami de
// Miu ni a sus recibos de entrega.

const RUTA_PMS_TENGOCAMELLO = '/api/tengocamello/whatsapp/inbound';
// Cola de mensajes de Teo que salen desde el número de TenGo (PMS migración 1052).
const RUTA_PMS_TC_RECLAMAR = '/api/tengocamello/whatsapp/outbox/reclamar';
const rutaPmsTcResultado = (id) => `/api/tengocamello/whatsapp/outbox/${encodeURIComponent(id)}/resultado`;

function idDe(change) {
  const v = change?.value?.metadata?.phone_number_id;
  return v == null || v === '' ? null : String(v);
}

function separarPorNumero(body, { miuId, tengoId } = {}) {
  const miu = String(miuId || '').trim();
  const tengo = String(tengoId || '').trim();
  const tengoChanges = [];
  let desconocidos = 0;
  // phone_number_id que no es de Miu ni de TenGo (no es dato personal): se
  // loguea para detectar si Miu se descarta por un id que no coincide.
  const idsDesconocidos = [];
  let filtrado = false;
  const entries = [];
  for (const entry of Array.isArray(body?.entry) ? body.entry : []) {
    const changes = [];
    for (const change of Array.isArray(entry?.changes) ? entry.changes : []) {
      const id = idDe(change);
      if (id == null || id === miu) { changes.push(change); continue; }
      filtrado = true;
      if (tengo && id === tengo) tengoChanges.push(change);
      else { desconocidos += 1; if (!idsDesconocidos.includes(id)) idsDesconocidos.push(id.slice(0, 40)); }
    }
    if (changes.length) entries.push(changes.length === (entry.changes || []).length ? entry : { ...entry, changes });
  }
  if (!filtrado) return { miuBody: body, tengoChanges, desconocidos, idsDesconocidos };
  return { miuBody: entries.length ? { ...body, entry: entries } : null, tengoChanges, desconocidos, idsDesconocidos };
}

function whatsappMessagesUrl(phoneNumberId) {
  return `https://graph.facebook.com/v20.0/${phoneNumberId}/messages`;
}

function mascara(telefono) {
  const d = String(telefono || '').replace(/\D/g, '');
  return d ? `***${d.slice(-4)}` : null;
}

/**
 * Atiende los cambios del número de TenGo Camello.
 * deps: { pms: { postUrl(url, body) }, pmsBaseUrl, enviarTexto(to, body), extractMetaMessages, logger }
 */
async function atenderTengoCamello(changes, { pms, pmsBaseUrl, enviarTexto, extractMetaMessages, logger = console }) {
  const resultado = { mensajes: 0, enviados: 0, ignorados: 0 };
  for (const change of changes) {
    const field = String(change?.field || '');
    if (field === 'calls' || (change?.value?.calls || []).length) {
      resultado.ignorados += 1;
      logger.warn('[tengocamello] llamada_ignorada', { field });
    }
    if ((change?.value?.statuses || []).length) {
      resultado.ignorados += 1;
      logger.info('[tengocamello] statuses_ignorados', { count: change.value.statuses.length });
    }
    const mensajes = extractMetaMessages({ entry: [{ changes: [change] }] });
    for (const m of mensajes) {
      resultado.mensajes += 1;
      if (!pmsBaseUrl) { logger.error('[tengocamello] pms_no_configurado'); continue; }
      try {
        const data = await pms.postUrl(`${String(pmsBaseUrl).replace(/\/$/, '')}${RUTA_PMS_TENGOCAMELLO}`, {
          from: m.from, text: m.text || '', message_id: m.messageId, occurred_at: m.timestamp,
          contact_name: m.name || null, message_type: m.messageType || null,
        });
        const salida = data?.responder === true && Array.isArray(data.mensajes) ? data.mensajes : [];
        for (const texto of salida) {
          if (!String(texto || '').trim()) continue;
          await enviarTexto(m.from, String(texto));
          resultado.enviados += 1;
        }
        logger.info('[tengocamello] mensaje', { phone: mascara(m.from), action: data?.action || null, enviados: salida.length });
      } catch (error) {
        logger.error('[tengocamello] mensaje_fallo', { phone: mascara(m.from), code: error?.code || null,
          http_status: error?.response?.status || null });
      }
    }
  }
  return resultado;
}

/**
 * Reclama los mensajes que Teo dejó en la cola de TenGo y los envía DESDE el
 * número de TenGo (enviarTexto ya va atado a TENGOCAMELLO_PHONE_NUMBER_ID).
 * Nunca toca el outbox de Miu. Reporta cada resultado al PMS.
 */
async function despacharSalidasTengoCamello({ pms, pmsBaseUrl, enviarTexto, logger = console }) {
  const base = String(pmsBaseUrl || '').replace(/\/$/, '');
  if (!base) return { enviados: 0, fallidos: 0 };
  const data = await pms.postUrl(`${base}${RUTA_PMS_TC_RECLAMAR}`, { limite: 10 });
  const salidas = Array.isArray(data?.salidas) ? data.salidas : [];
  let enviados = 0, fallidos = 0;
  for (const s of salidas) {
    let ok = false, providerReference = null, error = null;
    try {
      providerReference = await enviarTexto(s.to, String(s.texto || ''));
      ok = true;
    } catch (e) {
      error = String(e?.response?.data?.error?.code || e?.code || 'envio_fallido').slice(0, 80);
    }
    try {
      await pms.postUrl(`${base}${rutaPmsTcResultado(s.id)}`, ok ? { ok, provider_reference: providerReference || null } : { ok, error });
    } catch (e) {
      logger.error('[tengocamello] resultado_fallo', { id: s.id, code: e?.code || null });
    }
    if (ok) enviados += 1; else fallidos += 1;
    logger.info('[tengocamello] salida_teo', { id: s.id, phone: mascara(s.to), ok });
  }
  return { enviados, fallidos };
}

module.exports = { separarPorNumero, atenderTengoCamello, despacharSalidasTengoCamello, whatsappMessagesUrl, RUTA_PMS_TENGOCAMELLO,
  RUTA_PMS_TC_RECLAMAR };
