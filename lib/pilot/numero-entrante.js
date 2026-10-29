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

function idDe(change) {
  const v = change?.value?.metadata?.phone_number_id;
  return v == null || v === '' ? null : String(v);
}

function separarPorNumero(body, { miuId, tengoId } = {}) {
  const miu = String(miuId || '').trim();
  const tengo = String(tengoId || '').trim();
  const tengoChanges = [];
  let desconocidos = 0;
  let filtrado = false;
  const entries = [];
  for (const entry of Array.isArray(body?.entry) ? body.entry : []) {
    const changes = [];
    for (const change of Array.isArray(entry?.changes) ? entry.changes : []) {
      const id = idDe(change);
      if (id == null || id === miu) { changes.push(change); continue; }
      filtrado = true;
      if (tengo && id === tengo) tengoChanges.push(change);
      else desconocidos += 1;
    }
    if (changes.length) entries.push(changes.length === (entry.changes || []).length ? entry : { ...entry, changes });
  }
  if (!filtrado) return { miuBody: body, tengoChanges, desconocidos };
  return { miuBody: entries.length ? { ...body, entry: entries } : null, tengoChanges, desconocidos };
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

module.exports = { separarPorNumero, atenderTengoCamello, whatsappMessagesUrl, RUTA_PMS_TENGOCAMELLO };
