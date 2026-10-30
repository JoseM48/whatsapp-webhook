'use strict';

// SEGUNDO NÚMERO DE WHATSAPP: TenGo Camello (2026-10-28; PMS migración 1050).
//
// Enrutamiento por el número que RECIBE el mensaje
// (entry[].changes[].value.metadata.phone_number_id), fail-closed:
//   - igual a PHONE_NUMBER_ID, o ausente      -> Miu, camino de siempre, intacto;
//   - igual a TENGOCAMELLO_PHONE_NUMBER_ID    -> TenGo Camello (si la variable existe);
//   - igual a TENGOCAMELLO_DEMO_PHONE_NUMBER_ID -> TenGo Camello DEMO, número compartido
//     de la beta (si la variable existe; PMS migración 1060);
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
// Número DEMO compartido (PMS migración 1060): mismo camino, otra ruta y otro emisor.
const RUTA_PMS_TC_DEMO = '/api/tengocamello/demo/inbound';
const RUTA_PMS_TC_DEMO_RECLAMAR = '/api/tengocamello/demo/outbox/reclamar';
const rutaPmsTcDemoResultado = (id) => `/api/tengocamello/demo/outbox/${encodeURIComponent(id)}/resultado`;
// Cola de mensajes de Teo que salen desde el número de TenGo (PMS migración 1052).
const RUTA_PMS_TC_RECLAMAR = '/api/tengocamello/whatsapp/outbox/reclamar';
const rutaPmsTcResultado = (id) => `/api/tengocamello/whatsapp/outbox/${encodeURIComponent(id)}/resultado`;

function idDe(change) {
  const v = change?.value?.metadata?.phone_number_id;
  return v == null || v === '' ? null : String(v);
}

// Número demo EFECTIVO: vacío si falta o si coincide con Miu o con el 7355 (error
// de configuración). La misma regla gobierna el ruteo, el envío y el sondeo de la
// cola del demo (fail-closed): esos caminos nunca cambian.
function demoIdEfectivo({ miuId, tengoId, demoId } = {}) {
  const demo = String(demoId || '').trim();
  if (!demo) return { id: '', motivo: 'sin_variable' };
  if (demo === String(miuId || '').trim()) return { id: '', motivo: 'igual_a_miu' };
  if (demo === String(tengoId || '').trim()) return { id: '', motivo: 'igual_a_tengocamello' };
  return { id: demo, motivo: null };
}

function separarPorNumero(body, { miuId, tengoId, demoId } = {}) {
  const miu = String(miuId || '').trim();
  const tengo = String(tengoId || '').trim();
  const demo = demoIdEfectivo({ miuId, tengoId, demoId }).id;
  const tengoChanges = [];
  const demoChanges = [];
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
      else if (demo && id === demo) demoChanges.push(change);
      else { desconocidos += 1; if (!idsDesconocidos.includes(id)) idsDesconocidos.push(id.slice(0, 40)); }
    }
    if (changes.length) entries.push(changes.length === (entry.changes || []).length ? entry : { ...entry, changes });
  }
  if (!filtrado) return { miuBody: body, tengoChanges, demoChanges, desconocidos, idsDesconocidos };
  return { miuBody: entries.length ? { ...body, entry: entries } : null, tengoChanges, demoChanges, desconocidos, idsDesconocidos };
}

function whatsappMessagesUrl(phoneNumberId) {
  return `https://graph.facebook.com/v20.0/${phoneNumberId}/messages`;
}

// ORIGEN DEL ANUNCIO (Click-to-WhatsApp) en 7355 y 7354 (José Manuel, 2026-10-29;
// PMS migración 1074). Meta adjunta `referral` al primer mensaje que llega desde
// un anuncio. Se reenvía al PMS solo con los campos conocidos y acotados (el PMS
// vuelve a validar). Sin referral, o si no es un objeto con algún campo útil,
// el cuerpo al PMS queda exactamente igual que antes (sin la clave).
const CAMPOS_REFERRAL = { source_id: 64, source_type: 40, source_url: 500, headline: 300, body: 1000, ctwa_clid: 512, media_type: 20 };
function referralParaPms(ref) {
  if (!ref || typeof ref !== 'object' || Array.isArray(ref)) return null;
  const out = {};
  for (const [campo, max] of Object.entries(CAMPOS_REFERRAL)) {
    const v = ref[campo];
    if ((typeof v === 'string' && v.trim()) || (typeof v === 'number' && Number.isFinite(v))) out[campo] = String(v).trim().slice(0, max);
  }
  return Object.keys(out).length ? out : null;
}

function mascara(telefono) {
  const d = String(telefono || '').replace(/\D/g, '');
  return d ? `***${d.slice(-4)}` : null;
}

/**
 * Atiende los cambios del número de TenGo Camello.
 * deps: { pms: { postUrl(url, body) }, pmsBaseUrl, enviarTexto(to, body), extractMetaMessages, logger,
 *         transcribirAudio? }
 * transcribirAudio (2026-10-30): las notas de voz al 7355 llegaban al PMS con
 * texto vacío. Si viene (en index.js, el mismo transcriptor de Miu), un audio
 * sin texto se transcribe antes de reenviarlo; si falla, sigue con texto vacío
 * (el log nunca lleva el texto). message_type va como siempre.
 */
async function atenderTengoCamello(changes, { pms, pmsBaseUrl, enviarTexto, extractMetaMessages, logger = console,
  transcribirAudio = null, ruta = RUTA_PMS_TENGOCAMELLO, etiqueta = '[tengocamello]' }) {
  const resultado = { mensajes: 0, enviados: 0, ignorados: 0 };
  for (const change of changes) {
    const field = String(change?.field || '');
    if (field === 'calls' || (change?.value?.calls || []).length) {
      resultado.ignorados += 1;
      logger.warn(`${etiqueta} llamada_ignorada`, { field });
    }
    if ((change?.value?.statuses || []).length) {
      resultado.ignorados += 1;
      logger.info(`${etiqueta} statuses_ignorados`, { count: change.value.statuses.length });
    }
    const mensajes = extractMetaMessages({ entry: [{ changes: [change] }] });
    for (const m of mensajes) {
      resultado.mensajes += 1;
      if (!pmsBaseUrl) { logger.error(`${etiqueta} pms_no_configurado`); continue; }
      let texto = m.text || '';
      if (!texto && transcribirAudio && m.messageType === 'audio' && m.audio?.id) {
        try {
          texto = String(await transcribirAudio(m.audio.id) || '');
          logger.info(`${etiqueta} audio_transcrito`, { phone: mascara(m.from), chars: texto.length });
        } catch (error) {
          texto = '';
          logger.error(`${etiqueta} audio_transcripcion_fallo`, { phone: mascara(m.from), code: error?.code || error?.message || null });
        }
      }
      try {
        const referral = referralParaPms(m.referral);
        const data = await pms.postUrl(`${String(pmsBaseUrl).replace(/\/$/, '')}${ruta}`, {
          from: m.from, text: texto, message_id: m.messageId, occurred_at: m.timestamp,
          contact_name: m.name || null, message_type: m.messageType || null,
          ...(referral ? { referral } : {}),
        });
        const salida = data?.responder === true && Array.isArray(data.mensajes) ? data.mensajes : [];
        for (const texto of salida) {
          if (!String(texto || '').trim()) continue;
          await enviarTexto(m.from, String(texto));
          resultado.enviados += 1;
        }
        logger.info(`${etiqueta} mensaje`, { phone: mascara(m.from), action: data?.action || null, enviados: salida.length });
      } catch (error) {
        logger.error(`${etiqueta} mensaje_fallo`, { phone: mascara(m.from), code: error?.code || null,
          http_status: error?.response?.status || null });
      }
    }
  }
  return resultado;
}

// Clasifica un fallo de envío (revisión 2026-10-28): solo un error EXPLÍCITO de
// Meta (respuesta HTTP 4xx/5xx) es 'error' y se puede reintentar; un timeout,
// un corte de red o cualquier fallo sin respuesta es 'incierto' (Meta pudo
// haberlo entregado) y NUNCA se reintenta.
function clasificarFalloEnvio(e) {
  const status = Number(e?.response?.status);
  if (Number.isInteger(status) && status >= 400 && status <= 599) {
    return { resultado: 'error', error: String(e?.response?.data?.error?.code || `http_${status}`).slice(0, 80) };
  }
  return { resultado: 'incierto', error: String(e?.code || 'sin_respuesta').slice(0, 80) };
}

/**
 * Reclama los mensajes que Teo dejó en la cola de TenGo y los envía DESDE el
 * número de TenGo (enviarTexto ya va atado a TENGOCAMELLO_PHONE_NUMBER_ID).
 * Nunca toca el outbox de Miu. Reporta cada resultado al PMS:
 * {resultado: 'enviado' | 'error' | 'incierto'}.
 */
async function despacharSalidasTengoCamello({ pms, pmsBaseUrl, enviarTexto, logger = console,
  rutaReclamar = RUTA_PMS_TC_RECLAMAR, rutaResultado = rutaPmsTcResultado, etiqueta = '[tengocamello]' }) {
  const base = String(pmsBaseUrl || '').replace(/\/$/, '');
  if (!base) return { enviados: 0, fallidos: 0, inciertos: 0 };
  const data = await pms.postUrl(`${base}${rutaReclamar}`, { limite: 10 });
  const salidas = Array.isArray(data?.salidas) ? data.salidas : [];
  let enviados = 0, fallidos = 0, inciertos = 0;
  for (const s of salidas) {
    let cuerpo;
    try {
      const providerReference = await enviarTexto(s.to, String(s.texto || ''));
      cuerpo = { resultado: 'enviado', provider_reference: providerReference || null };
    } catch (e) {
      cuerpo = clasificarFalloEnvio(e);
    }
    try {
      await pms.postUrl(`${base}${rutaResultado(s.id)}`, cuerpo);
    } catch (e) {
      // Si el reporte se pierde, el PMS la marca 'incierto' a los 5 min: no se reenvía.
      logger.error(`${etiqueta} resultado_fallo`, { id: s.id, code: e?.code || null });
    }
    if (cuerpo.resultado === 'enviado') enviados += 1; else if (cuerpo.resultado === 'error') fallidos += 1; else inciertos += 1;
    logger.info(`${etiqueta} salida_teo`, { id: s.id, phone: mascara(s.to), resultado: cuerpo.resultado });
  }
  return { enviados, fallidos, inciertos };
}

// Camino DEMO (número compartido de la beta): el mismo del 7355 con su ruta del
// PMS; enviarTexto debe ir atado a TENGOCAMELLO_DEMO_PHONE_NUMBER_ID. Llamadas y
// estados del número demo se ignoran con log.
const atenderTengoCamelloDemo = (changes, deps) => atenderTengoCamello(changes, { ...deps, ruta: RUTA_PMS_TC_DEMO, etiqueta: '[tengocamello-demo]' });
const despacharSalidasTengoCamelloDemo = (deps) => despacharSalidasTengoCamello({ ...deps, rutaReclamar: RUTA_PMS_TC_DEMO_RECLAMAR,
  rutaResultado: rutaPmsTcDemoResultado, etiqueta: '[tengocamello-demo]' });

module.exports = { atenderTengoCamelloDemo, despacharSalidasTengoCamelloDemo, demoIdEfectivo, RUTA_PMS_TC_DEMO, RUTA_PMS_TC_DEMO_RECLAMAR,
  separarPorNumero, atenderTengoCamello, despacharSalidasTengoCamello, clasificarFalloEnvio, whatsappMessagesUrl, RUTA_PMS_TENGOCAMELLO,
  RUTA_PMS_TC_RECLAMAR, referralParaPms };
