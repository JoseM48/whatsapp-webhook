'use strict';

// F-AUDIO-001: transcribe notas de voz entrantes de WhatsApp para que fluyan
// por el mismo camino que un mensaje de texto (ver index.js, justo antes de
// m0CommercialText). Antes de esto, cualquier audio se marcaba como
// "[M0_UNSUPPORTED_INBOUND:audio]" y nunca llegaba a interpretarse.
//
// Descarga en dos pasos, igual que documenta la Graph API de Meta: primero
// GET /{media-id} para obtener la URL temporal, luego GET a esa URL (ambas
// con el mismo Bearer token) para el binario. Cualquier fallo (red, Meta,
// OpenAI) se propaga como excepción - el llamador decide degradar al
// comportamiento anterior en vez de que esto rompa el webhook completo.

const GRAPH_API_BASE = 'https://graph.facebook.com/v20.0';

function extensionForMimeType(mimeType) {
  const value = String(mimeType || '').toLowerCase();
  if (value.includes('ogg')) return 'ogg';
  if (value.includes('mp4') || value.includes('m4a')) return 'm4a';
  if (value.includes('mpeg') || value.includes('mp3')) return 'mp3';
  if (value.includes('amr')) return 'amr';
  if (value.includes('wav')) return 'wav';
  return 'ogg';
}

class InboundAudioTranscriber {
  constructor({ http, openai, toFile, accessToken, model = 'whisper-1' } = {}) {
    if (!http) throw new Error('inbound_audio_http_required');
    if (!openai) throw new Error('inbound_audio_openai_required');
    if (!toFile) throw new Error('inbound_audio_tofile_required');
    this.http = http;
    this.openai = openai;
    this.toFile = toFile;
    this.accessToken = accessToken;
    this.model = model;
  }

  async transcribe(mediaId) {
    if (!mediaId) throw new Error('inbound_audio_media_id_required');
    const authHeaders = { headers: { Authorization: `Bearer ${this.accessToken}` } };

    const metaResponse = await this.http.get(`${GRAPH_API_BASE}/${mediaId}`, authHeaders);
    const mediaUrl = metaResponse?.data?.url;
    if (!mediaUrl) throw new Error('inbound_audio_media_url_missing');
    const mimeType = metaResponse?.data?.mime_type || null;

    const audioResponse = await this.http.get(mediaUrl, { ...authHeaders, responseType: 'arraybuffer' });
    const buffer = Buffer.from(audioResponse.data);
    if (!buffer.length) throw new Error('inbound_audio_empty_download');

    const file = await this.toFile(buffer, `inbound-audio.${extensionForMimeType(mimeType)}`,
      mimeType ? { type: mimeType } : undefined);
    const transcription = await this.openai.audio.transcriptions.create({ file, model: this.model });
    const text = transcription?.text ? String(transcription.text).trim() : '';
    if (!text) throw new Error('inbound_audio_transcription_empty');
    return text;
  }
}

module.exports = { InboundAudioTranscriber, extensionForMimeType };
