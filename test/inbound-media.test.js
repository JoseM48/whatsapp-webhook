'use strict';

// Fase 3 (2026-09-28): adjuntos entrantes. El archivo se descarga al recibirlo
// y viaja a pms-lite en la misma captura; si algo falla, el adjunto lo dice
// (estado + motivo) y la captura sigue: nunca se pierde el mensaje.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { InboundMediaDownloader, mediaDeMensaje, capturarConRespaldo, ADJUNTO_MAX_BYTES } = require('../lib/pilot/inbound-media');
const { extractMetaMessages, m0CommercialText } = require('../lib/pilot/meta-inbound');
const { createM0CommercialResponder } = require('../lib/pilot/m0-commercial-responder');
const { PilotOrchestrator } = require('../lib/pilot/orchestrator');
const { PmsPilotClient } = require('../lib/pilot/pms-client');

const BYTES = Buffer.from('%PDF-1.4 comprobante de prueba');

function fakeHttp({ meta = { url: 'https://lookaside.example/file', mime_type: 'application/pdf', file_size: BYTES.length },
  bytes = BYTES, falla = null } = {}) {
  const calls = [];
  return {
    calls,
    get: async (url, config) => {
      calls.push({ url, auth: config?.headers?.Authorization, responseType: config?.responseType, maxContentLength: config?.maxContentLength });
      if (falla) throw falla;
      if (url.startsWith('https://graph.facebook.com')) return { data: meta };
      if (url === meta.url) return { data: bytes };
      throw new Error(`unexpected_url:${url}`);
    }
  };
}

const MEDIA = { tipo: 'document', id: 'media.doc.1', mimeType: 'application/pdf', filename: 'comprobante.pdf', caption: 'Mi pago' };

test('descarga en dos pasos con el token del negocio y entrega bytes, huella y metadatos', async () => {
  const http = fakeHttp();
  const adjunto = await new InboundMediaDownloader({ http, accessToken: 'token-negocio' }).adjunto(MEDIA);
  assert.equal(http.calls.length, 2);
  assert.equal(http.calls[0].url, 'https://graph.facebook.com/v20.0/media.doc.1');
  assert.ok(http.calls.every((c) => c.auth === 'Bearer token-negocio'));
  assert.equal(http.calls[1].responseType, 'arraybuffer');
  assert.equal(http.calls[1].maxContentLength, ADJUNTO_MAX_BYTES);
  assert.deepEqual({ ...adjunto, contenido_base64: undefined }, {
    tipo: 'document', meta_media_id: 'media.doc.1', mime_type: 'application/pdf', filename: 'comprobante.pdf',
    caption: 'Mi pago', estado: 'guardado', size_bytes: BYTES.length,
    sha256: crypto.createHash('sha256').update(BYTES).digest('hex'), contenido_base64: undefined
  });
  assert.equal(Buffer.from(adjunto.contenido_base64, 'base64').equals(BYTES), true);
});

test('si Meta declara un archivo mayor al tope, no lo descarga: demasiado_grande sin contenido', async () => {
  const http = fakeHttp({ meta: { url: 'https://lookaside.example/file', mime_type: 'video/mp4', file_size: ADJUNTO_MAX_BYTES + 1 } });
  const adjunto = await new InboundMediaDownloader({ http, accessToken: 't' }).adjunto({ ...MEDIA, tipo: 'video' });
  assert.equal(http.calls.length, 1);
  assert.equal(adjunto.estado, 'demasiado_grande');
  assert.equal(adjunto.contenido_base64, undefined);
});

test('si la descarga supera el tope a mitad de camino, queda demasiado_grande', async () => {
  const http = fakeHttp({ meta: { url: 'https://lookaside.example/file', mime_type: 'application/pdf' } });
  http.get = async (url) => {
    if (url.startsWith('https://graph.facebook.com')) return { data: { url: 'https://lookaside.example/file', mime_type: 'application/pdf' } };
    throw new Error('maxContentLength size of 10485760 exceeded');
  };
  const adjunto = await new InboundMediaDownloader({ http, accessToken: 't' }).adjunto(MEDIA);
  assert.equal(adjunto.estado, 'demasiado_grande');
});

test('un fallo de Meta no lanza: el adjunto queda no_descargado con motivo y la captura puede seguir', async () => {
  const falla = Object.assign(new Error('Request failed'), { response: { status: 404 } });
  const adjunto = await new InboundMediaDownloader({ http: fakeHttp({ falla }), accessToken: 't' }).adjunto(MEDIA);
  assert.equal(adjunto.estado, 'no_descargado');
  assert.match(adjunto.motivo, /404/);
  assert.equal(adjunto.contenido_base64, undefined);
});

test('sin URL de descarga o sin token, no_descargado con motivo', async () => {
  const sinUrl = await new InboundMediaDownloader({ http: fakeHttp({ meta: { mime_type: 'image/jpeg' } }), accessToken: 't' })
    .adjunto({ ...MEDIA, tipo: 'image' });
  assert.equal(sinUrl.estado, 'no_descargado');
  const http = fakeHttp();
  const sinToken = await new InboundMediaDownloader({ http, accessToken: '' }).adjunto(MEDIA);
  assert.equal(sinToken.estado, 'no_descargado');
  assert.equal(http.calls.length, 0);
});

test('extrae imagen, documento, video y sticker; texto y audio no llevan adjunto; el texto sigue siendo la marca', () => {
  const payload = { entry: [{ changes: [{ value: { messages: [
    { id: 'w1', from: '573146892662', timestamp: '1787688000', type: 'image', image: { id: 'm1', mime_type: 'image/jpeg', caption: 'foto' } },
    { id: 'w2', from: '573146892662', timestamp: '1787688001', type: 'document', document: { id: 'm2', mime_type: 'application/pdf', filename: 'c.pdf' } },
    { id: 'w3', from: '573146892662', timestamp: '1787688002', type: 'video', video: { id: 'm3', mime_type: 'video/mp4' } },
    { id: 'w4', from: '573146892662', timestamp: '1787688003', type: 'sticker', sticker: { id: 'm4', mime_type: 'image/webp' } },
    { id: 'w5', from: '573146892662', timestamp: '1787688004', type: 'text', text: { body: 'hola' } },
    { id: 'w6', from: '573146892662', timestamp: '1787688005', type: 'audio', audio: { id: 'm6' } }
  ] } }] }] };
  const m = extractMetaMessages(payload);
  assert.deepEqual(m.map((x) => x.media && [x.media.tipo, x.media.id]), [['image', 'm1'], ['document', 'm2'], ['video', 'm3'], ['sticker', 'm4'], null, null]);
  assert.equal(m[0].media.caption, 'foto');
  assert.equal(m[1].media.filename, 'c.pdf');
  assert.equal(m0CommercialText(m[0]), '[M0_UNSUPPORTED_INBOUND:image]');
  assert.equal(m[5].audio.id, 'm6');
  assert.equal(mediaDeMensaje({ type: 'image', image: {} }), null);
});

test('el respondedor y el orquestador llevan el adjunto hasta la captura de pms-lite', async () => {
  const capturas = [];
  const pms = { capture: async (body) => { capturas.push(body); return { created_interaction: true }; } };
  const orchestrator = new PilotOrchestrator({ pms, ai: {}, sendImage: async () => {}, sendText: async () => 'w',
    context: { organizationKey: 'o', verticalKey: 'v', channelKey: 'whatsapp', channelAccountKey: 'a', conversationKey: 'c' } });
  const responder = createM0CommercialResponder({
    capture: (payload) => orchestrator.capture(payload),
    ai: { async interpret() { throw new Error('no'); } },
    closedPilot: { async beginCommercial() { return { result: { processing_claimed: false, outboxes: [] } }; } },
    pms: { async processingFailure() {} }
  });
  const adjunto = { tipo: 'image', estado: 'guardado', meta_media_id: 'm1' };
  await responder.captureAndAcknowledge({ from: '573146892662', text: '[M0_UNSUPPORTED_INBOUND:image]',
    messageId: 'wamid.adj.1', timestamp: '2026-09-28T01:00:00.000Z', adjunto });
  assert.deepEqual(capturas[0].adjunto, adjunto);
  assert.equal(capturas[0].mensaje, '[M0_UNSUPPORTED_INBOUND:image]');
});

test('la captura con archivo usa un tiempo de espera mayor; sin archivo, el de siempre', async () => {
  const timeouts = [];
  const client = new PmsPilotClient({ http: { post: async (_url, _body, cfg) => { timeouts.push(cfg.timeout); return { data: { data: {} } }; } },
    baseUrl: 'https://pms.example', inboundUrl: 'https://pms.example/api/integrations/whatsapp/inbound', secret: 's', timeoutMs: 8000 });
  await client.capture({ mensaje: 'hola' });
  await client.capture({ mensaje: '[M0_UNSUPPORTED_INBOUND:image]', adjunto: { estado: 'guardado', contenido_base64: 'AAAA' } });
  await client.capture({ mensaje: '[M0_UNSUPPORTED_INBOUND:image]', adjunto: { estado: 'no_descargado' } });
  assert.deepEqual(timeouts, [8000, 30000, 8000]);
});

test('si pms-lite rechaza la captura con archivo, se reintenta sin el contenido: el mensaje no se pierde', async () => {
  const intentos = [];
  const capture = async (p) => {
    intentos.push(p);
    if (p.adjunto.contenido_base64) throw Object.assign(new Error('Request failed'), { response: { status: 413 } });
    return { created_interaction: true };
  };
  const logger = { error() {} };
  const r = await capturarConRespaldo(capture, { mensaje: '[M0_UNSUPPORTED_INBOUND:image]',
    adjunto: { tipo: 'image', estado: 'guardado', sha256: 'a'.repeat(64), size_bytes: 3, contenido_base64: 'AAAA' } }, logger);
  assert.deepEqual(r, { created_interaction: true });
  assert.equal(intentos.length, 2);
  assert.equal(intentos[1].adjunto.estado, 'no_descargado');
  assert.match(intentos[1].adjunto.motivo, /413/);
  assert.equal(intentos[1].adjunto.contenido_base64, undefined);
  assert.equal(intentos[1].adjunto.sha256, undefined);
  assert.equal(intentos[1].mensaje, '[M0_UNSUPPORTED_INBOUND:image]');
});

test('sin archivo, un fallo de captura se propaga igual que antes (no hay reintento inventado)', async () => {
  let n = 0;
  const capture = async () => { n++; throw new Error('pms_down'); };
  await assert.rejects(capturarConRespaldo(capture, { mensaje: 'hola' }), /pms_down/);
  await assert.rejects(capturarConRespaldo(capture, { mensaje: 'x', adjunto: { tipo: 'image', estado: 'no_descargado' } }), /pms_down/);
  assert.equal(n, 2);
});

test('las dos descargas comparten un plazo total (signal)', async () => {
  const http = fakeHttp();
  const signals = [];
  const get = http.get;
  http.get = async (url, cfg) => { signals.push(cfg.signal); return get(url, cfg); };
  await new InboundMediaDownloader({ http, accessToken: 't' }).adjunto(MEDIA);
  assert.equal(signals.length, 2);
  assert.ok(signals[0] && signals[0] === signals[1]);
});

