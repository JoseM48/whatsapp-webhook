'use strict';

// Fase 3 (2026-09-28): adjuntos entrantes (imagen, documento, video, sticker).
//
// Hasta hoy el webhook solo conservaba el media id del audio (para
// transcribirlo); cualquier otro archivo se convertia en el texto
// "[M0_UNSUPPORTED_INBOUND:<tipo>]" y se perdia. Ahora se descarga AL RECIBIRLO,
// porque la URL que entrega Meta dura solo unos minutos y el archivo no se
// conserva en Meta indefinidamente, y viaja a pms-lite en la misma captura. El
// texto del mensaje sigue siendo la marca de siempre: el resto del flujo (Cami,
// comprobantes de pago) no cambia.
//
// Descarga en dos pasos, igual que inbound-audio.js: GET /{media-id} para la
// URL temporal y los metadatos, y GET a esa URL para el binario, ambos con el
// token del negocio. Tope de tamano ANTES (file_size de Meta) y DURANTE la
// descarga (maxContentLength). Nunca lanza: un fallo se describe en el propio
// adjunto (estado + motivo) y pms-lite lo registra sin contenido, para que ni
// el CEM ni Cami prometan un archivo que no existe.

const crypto = require('node:crypto');

const GRAPH_API_BASE = 'https://graph.facebook.com/v20.0';
const ADJUNTO_MAX_BYTES = 10 * 1024 * 1024;
const TIPOS_ADJUNTO = new Set(['image', 'document', 'video', 'sticker']);

function mediaDeMensaje(message) {
  const tipo = String(message?.type || '').toLowerCase();
  if (!TIPOS_ADJUNTO.has(tipo)) return null;
  const media = message?.[tipo];
  if (!media?.id) return null;
  return {
    tipo,
    id: String(media.id),
    mimeType: media.mime_type ? String(media.mime_type).slice(0, 200) : null,
    filename: media.filename ? String(media.filename).slice(0, 255) : null,
    caption: media.caption ? String(media.caption).slice(0, 3000) : null
  };
}

class InboundMediaDownloader {
  // `timeoutMs` es el plazo TOTAL de las dos llamadas (el timeout de axios solo
  // mide inactividad del socket: una descarga lenta podia pasarse). Meta espera
  // la respuesta del webhook, que sale despues de capturar.
  constructor({ http, accessToken, maxBytes = ADJUNTO_MAX_BYTES, timeoutMs = 20000 } = {}) {
    if (!http) throw new Error('inbound_media_http_required');
    this.http = http;
    this.accessToken = accessToken;
    this.maxBytes = maxBytes;
    this.timeoutMs = timeoutMs;
  }

  // Devuelve siempre el objeto `adjunto` que espera pms-lite
  // (inbound-attachments.js, adjuntoSchema).
  async adjunto(media) {
    const base = {
      tipo: media.tipo, meta_media_id: media.id, mime_type: media.mimeType,
      filename: media.filename, caption: media.caption
    };
    if (!this.accessToken) return { ...base, estado: 'no_descargado', motivo: 'token de Meta no configurado' };
    const auth = { Authorization: `Bearer ${this.accessToken}` };
    const signal = AbortSignal.timeout(this.timeoutMs);
    try {
      const meta = (await this.http.get(`${GRAPH_API_BASE}/${media.id}`, { headers: auth, timeout: this.timeoutMs, signal }))?.data || {};
      const declarado = Number(meta.file_size);
      const mimeType = meta.mime_type ? String(meta.mime_type).slice(0, 200) : media.mimeType;
      if (Number.isFinite(declarado) && declarado > this.maxBytes) {
        return { ...base, mime_type: mimeType, estado: 'demasiado_grande', motivo: `supera el tope de ${this.maxBytes} bytes`, size_bytes: declarado };
      }
      if (!meta.url) return { ...base, mime_type: mimeType, estado: 'no_descargado', motivo: 'Meta no entregó la URL de descarga' };
      const respuesta = await this.http.get(meta.url, {
        headers: auth, responseType: 'arraybuffer', timeout: this.timeoutMs, signal,
        maxContentLength: this.maxBytes, maxBodyLength: this.maxBytes
      });
      const buffer = Buffer.from(respuesta.data);
      if (!buffer.length) return { ...base, mime_type: mimeType, estado: 'no_descargado', motivo: 'el archivo llegó vacío' };
      if (buffer.length > this.maxBytes) {
        return { ...base, mime_type: mimeType, estado: 'demasiado_grande', motivo: `supera el tope de ${this.maxBytes} bytes`, size_bytes: buffer.length };
      }
      return {
        ...base, mime_type: mimeType, estado: 'guardado', size_bytes: buffer.length,
        sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
        contenido_base64: buffer.toString('base64')
      };
    } catch (error) {
      const excedido = /maxContentLength|content length/i.test(String(error?.message || ''));
      return excedido
        ? { ...base, estado: 'demasiado_grande', motivo: `supera el tope de ${this.maxBytes} bytes` }
        : { ...base, estado: 'no_descargado', motivo: `descarga fallida (${String(error?.response?.status || error?.code || 'error').slice(0, 40)})` };
    }
  }
}

// Si pms-lite rechaza la captura CON el archivo (cuerpo demasiado grande,
// version anterior, fallo transitorio), se reintenta una vez SIN el contenido:
// el mensaje nunca se pierde por culpa del adjunto. Queda registrado como no
// descargado, y Cami y el CEM lo dicen asi.
async function capturarConRespaldo(capture, payload, logger = console) {
  try {
    return await capture(payload);
  } catch (error) {
    if (!payload?.adjunto?.contenido_base64) throw error;
    logger.error('[m0-media] capture_with_file_failed', { status: error?.response?.status || null, code: error?.code || null });
    const { contenido_base64: _omitido, sha256: _huella, ...resto } = payload.adjunto;
    return capture({ ...payload, adjunto: { ...resto, estado: 'no_descargado',
      motivo: `captura del archivo rechazada (${String(error?.response?.status || error?.code || 'error').slice(0, 40)})` } });
  }
}

module.exports = { InboundMediaDownloader, mediaDeMensaje, capturarConRespaldo, ADJUNTO_MAX_BYTES };
