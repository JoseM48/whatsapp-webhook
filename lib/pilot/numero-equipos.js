'use strict';

// NÚMEROS DE TENGO CAMELLO EQUIPOS (GO José Manuel 2026-11-01; PMS migración 1088).
//
// Los números son datos en el PMS (equipos_numeros), no variables: un cliente nuevo
// no exige desplegar. El webhook lee la lista con caché; si falla, conserva lo
// último. Solo espera esa lectura cuando llega un número que no conoce: el camino de
// Miu nunca espera por esto (ver index.js).
// Cada mensaje va firmado al PMS y lo que el PMS responde sale DESDE el número que
// lo recibió, con botones reales de WhatsApp (máximo 3, título de 20 caracteres).
// El teléfono nunca va a logs.

const { capturarConRespaldo } = require('./inbound-media');

const RUTA_NUMEROS = '/api/equipos/numeros';
const RUTA_PUEDE = '/api/equipos/puede';
const RUTA_INBOUND = '/api/equipos/whatsapp/inbound';
const RUTA_ESTADOS = '/api/equipos/whatsapp/estados';
const RUTA_RECLAMAR = '/api/equipos/whatsapp/outbox/reclamar';
const rutaResultado = (id) => `/api/equipos/whatsapp/outbox/${encodeURIComponent(id)}/resultado`;
const MAX_BOTONES = 3;
const MAX_TITULO = 20;
const ETIQUETA = '[equipos]';

function crearCacheNumeros({ pms, pmsBaseUrl, ttlMs = 60_000, logger = console, ahora = Date.now }) {
  let ids = new Set();
  let vence = 0;
  let cargada = false;
  let enCurso = null;
  const actualizar = () => {
    if (enCurso) return enCurso;
    const base = String(pmsBaseUrl || '').replace(/\/$/, '');
    if (!base) return Promise.resolve(ids);
    enCurso = pms.postUrl(`${base}${RUTA_NUMEROS}`, {}, { timeoutMs: 5000 })
      .then((data) => {
        if (Array.isArray(data?.numeros)) { ids = new Set(data.numeros.map(String)); cargada = true; }
        vence = ahora() + ttlMs;
        return ids;
      })
      .catch((error) => {
        // Se conserva lo último; se reintenta en 10 s, no en cada mensaje.
        vence = ahora() + Math.min(10_000, ttlMs);
        logger.error(`${ETIQUETA} numeros_fallo`, { http_status: error?.response?.status || null, code: error?.code || null });
        return ids;
      })
      .finally(() => { enCurso = null; });
    return enCurso;
  };
  return {
    // Lo que se sabe hoy, sin esperar; si venció, refresca en segundo plano.
    ids() { if (ahora() >= vence) actualizar(); return ids; },
    // ¿Se ha leído alguna vez? Vacía y cargada = política apagada; vacía sin cargar = no se sabe.
    cargada: () => cargada,
    // Para un número desconocido: espera la lectura solo si la caché venció.
    async refrescarSiVencio() { if (ahora() >= vence) await actualizar(); return ids; },
  };
}

// Cuerpo del mensaje con botones. Si los botones no cumplen el formato de Meta se
// recortan: un botón mal formado haría fallar el mensaje entero.
function cuerpoInteractivo(to, { texto, botones }) {
  return { messaging_product: 'whatsapp', to, type: 'interactive', interactive: { type: 'button', body: { text: String(texto || '').slice(0, 1024) },
    action: { buttons: botones.slice(0, MAX_BOTONES).map((b) => ({ type: 'reply', reply: { id: String(b.id).slice(0, 256), title: String(b.title).slice(0, MAX_TITULO) } })) } } };
}

// Caché fría con el PMS caído y un número ajeno: no se sabe si era de Equipos. Meta lo
// reintenta si no le decimos 200, y solo se hace si en ese cuerpo no venía nada de Miu.
function debeReintentar(ruteo, cache) {
  return ruteo.desconocidos > 0 && !cache.cargada() && !ruteo.miuBody && !ruteo.tengoChanges.length && !ruteo.demoChanges.length;
}

// S3: Equipos espera como el 7355, salvo que el cuerpo traiga también a Miu o a los otros
// números: la IA de Equipos nunca retrasa a nadie más.
const debeEsperarEquipos = (ruteo) => !ruteo.miuBody && !ruteo.tengoChanges.length && !ruteo.demoChanges.length;

// S2: a quién reconoció el PMS en esta instancia, para avisarle una sola vez si el PMS
// falla con su mensaje. Solo en memoria: tras reiniciar no se sabe y queda solo la traza.
const TEXTO_FALLA_PMS = 'Tuve un problema y no pude guardar eso. Mándamelo otra vez en un rato, por favor.';
function crearMemoriaRemitentes({ maximo = 5000 } = {}) {
  const conocidos = new Set();
  const avisados = new Set();
  return {
    conocido(tel) { if (conocidos.size >= maximo) conocidos.clear(); conocidos.add(String(tel)); },
    bien(tel) { avisados.delete(String(tel)); },
    // true la primera vez, hasta que el PMS vuelva a responderle.
    debeAvisar(tel) { const t = String(tel); if (!conocidos.has(t) || avisados.has(t)) return false; avisados.add(t); return true; },
  };
}

function mascara(telefono) {
  const d = String(telefono || '').replace(/\D/g, '');
  return d ? `***${d.slice(-4)}` : null;
}

/**
 * Atiende los cambios de números de Equipos.
 * deps: { pms, pmsBaseUrl, enviar(phoneNumberId, to, {texto, botones?}), extractMetaMessages, logger, transcribirAudio?, descargarAdjunto? }
 */
async function atenderEquipos(changes, { pms, pmsBaseUrl, enviar, extractMetaMessages, logger = console, transcribirAudio = null, descargarAdjunto = null, memoria = null }) {
  const resultado = { mensajes: 0, enviados: 0 };
  const base = String(pmsBaseUrl || '').replace(/\/$/, '');
  if (!base) { logger.error(`${ETIQUETA} pms_no_configurado`); return resultado; }
  for (const change of changes) {
    const phoneNumberId = String(change?.value?.metadata?.phone_number_id || '');
    const numeroMostrado = change?.value?.metadata?.display_phone_number ? String(change.value.metadata.display_phone_number).slice(0, 40) : null;
    if (String(change?.field || '') === 'calls' || (change?.value?.calls || []).length) logger.warn(`${ETIQUETA} evento_llamada_sin_chat`, {});
    if ((change?.value?.statuses || []).length) {
      try {
        await pms.postUrl(`${base}${RUTA_ESTADOS}`, { statuses: change.value.statuses.map((s) => ({
          id: s?.id, status: s?.status, timestamp: s?.timestamp, recipient_id: s?.recipient_id,
          ...(s?.errors ? { errors: s.errors.map((e) => ({ code: e?.code, title: e?.title })) } : {}) })) });
      } catch (error) {
        logger.error(`${ETIQUETA} estados_fallo`, { http_status: error?.response?.status || null, code: error?.code || null });
      }
    }
    for (const m of extractMetaMessages({ entry: [{ changes: [change] }] })) {
      resultado.mensajes += 1;
      // Antes de gastar: un desconocido o quien no tiene permiso no consume ni
      // transcripción ni descarga. Si el PMS no contesta tampoco se gasta nada.
      let puede = { documentos: false, notas_voz: false };
      const esAudio = !m.text && m.messageType === 'audio' && m.audio?.id;
      const esArchivo = m.media && m.media.tipo !== 'sticker';
      if (esAudio || esArchivo) {
        try {
          puede = await pms.postUrl(`${base}${RUTA_PUEDE}`, { phone_number_id: phoneNumberId, from: m.from }, { timeoutMs: 8000 }) || puede;
          if (puede.conocido === true) memoria?.conocido(m.from);
        } catch (error) {
          logger.error(`${ETIQUETA} puede_fallo`, { phone: mascara(m.from), http_status: error?.response?.status || null, code: error?.code || null });
        }
      }
      let texto = m.text || '';
      if (esAudio && transcribirAudio && puede.notas_voz === true) {
        try {
          texto = String(await transcribirAudio(m.audio.id) || '');
        } catch (error) {
          texto = '';
          logger.error(`${ETIQUETA} audio_transcripcion_fallo`, { phone: mascara(m.from), code: error?.code || null });
        }
      }
      try {
        const adjunto = !esArchivo ? null
          : descargarAdjunto && puede.documentos === true ? await descargarAdjunto(m.media)
            : { tipo: m.media.tipo, estado: 'no_descargado', motivo: 'sin_permiso_o_desconocido' };
        const payload = { phone_number_id: phoneNumberId, numero_mostrado: numeroMostrado, from: m.from, text: texto, message_id: m.messageId, occurred_at: m.timestamp,
          contact_name: m.name || null, message_type: m.messageType || null,
          ...(m.botonId ? { boton_id: m.botonId } : {}), ...(m.contactos?.length ? { contactos: m.contactos } : {}), ...(adjunto ? { adjunto } : {}) };
        // La IA del PMS puede tardar: plazo largo para todo mensaje de este camino.
        const data = await capturarConRespaldo((cuerpo) => pms.postUrl(`${base}${RUTA_INBOUND}`, cuerpo, { timeoutMs: 45000 }), payload, logger);
        if (data?.conocido === true) memoria?.conocido(m.from);
        memoria?.bien(m.from);
        const salida = data?.responder === true && Array.isArray(data.mensajes) ? data.mensajes : [];
        for (const s of salida) {
          if (!String(s?.texto || '').trim()) continue;
          await enviar(phoneNumberId, m.from, s);
          resultado.enviados += 1;
        }
        logger.info(`${ETIQUETA} mensaje`, { phone: mascara(m.from), action: data?.action || null, enviados: salida.length });
      } catch (error) {
        // Traza clara: este mensaje NO se atendió. Con el id se puede buscar en Meta.
        logger.error(`${ETIQUETA} mensaje_no_atendido`, { phone: mascara(m.from), message_id: m.messageId || null, tipo: m.messageType || null, code: error?.code || null, http_status: error?.response?.status || null });
        if (memoria?.debeAvisar(m.from)) {
          try {
            await enviar(phoneNumberId, m.from, { texto: TEXTO_FALLA_PMS });
            logger.info(`${ETIQUETA} aviso_falla_enviado`, { phone: mascara(m.from) });
          } catch (e) {
            logger.error(`${ETIQUETA} aviso_falla_fallo`, { phone: mascara(m.from), code: e?.code || null });
          }
        }
      }
    }
  }
  return resultado;
}

module.exports = { atenderEquipos, crearCacheNumeros, cuerpoInteractivo, debeReintentar, debeEsperarEquipos, crearMemoriaRemitentes, TEXTO_FALLA_PMS, RUTA_PUEDE, RUTA_NUMEROS, RUTA_INBOUND, RUTA_ESTADOS, RUTA_RECLAMAR, rutaResultado, MAX_BOTONES, MAX_TITULO };
