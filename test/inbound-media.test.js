'use strict';

// Fase 3 (2026-09-28): adjuntos entrantes. El archivo se descarga al recibirlo
// y viaja a pms-lite en la misma captura; si algo falla, el adjunto lo dice
// (estado + motivo) y la captura sigue: nunca se pierde el mensaje.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { InboundMediaDownloader, mediaDeMensaje, capturarConRespaldo, audioDelEquipo, ADJUNTO_MAX_BYTES } = require('../lib/pilot/inbound-media');
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

// NOTAS DE VOZ DEL EQUIPO (2026-11-03): el archivo solo se baja si el PMS dice que
// el telefono es del equipo. Un huesped no gasta descarga ni se le guarda el audio.
const AUDIO = { id: 'media.audio.1', mimeType: 'audio/ogg; codecs=opus' };

test('audio de una persona del equipo: se descarga como tipo audio', async () => {
  const pedidas = [];
  const r = await audioDelEquipo({ audio: AUDIO, from: '573000000301', esEquipo: async () => true,
    descargar: async (media) => { pedidas.push(media); return { tipo: 'audio', estado: 'guardado' }; } });
  assert.equal(r.estado, 'guardado');
  assert.deepEqual(pedidas, [{ tipo: 'audio', id: 'media.audio.1', mimeType: 'audio/ogg; codecs=opus', filename: null, caption: null }]);
});

test('audio de un huesped: no se descarga nada', async () => {
  let descargas = 0;
  const r = await audioDelEquipo({ audio: AUDIO, from: '573000000001', esEquipo: async () => false, descargar: async () => { descargas += 1; } });
  assert.equal(r, null);
  assert.equal(descargas, 0);
});

test('si el PMS no contesta o la descarga lanza, el mensaje sigue sin archivo y no lanza', async () => {
  const logger = { error() {} };
  assert.equal(await audioDelEquipo({ audio: AUDIO, from: 'x', logger, esEquipo: async () => { throw new Error('timeout'); }, descargar: async () => ({}) }), null);
  assert.equal(await audioDelEquipo({ audio: AUDIO, from: 'x', logger, esEquipo: async () => true, descargar: async () => { throw new Error('meta'); } }), null);
  assert.equal(await audioDelEquipo({ audio: null, from: 'x', esEquipo: async () => true, descargar: async () => ({}) }), null);
});

test('un fallo de Meta al bajar el audio queda no_descargado y la captura sigue', async () => {
  const falla = Object.assign(new Error('x'), { response: { status: 500 } });
  const downloader = new InboundMediaDownloader({ http: fakeHttp({ falla }), accessToken: 't' });
  const r = await audioDelEquipo({ audio: AUDIO, from: 'x', esEquipo: async () => true, descargar: (m) => downloader.adjunto(m) });
  assert.equal(r.tipo, 'audio');
  assert.equal(r.estado, 'no_descargado');
  assert.equal(r.contenido_base64, undefined);
});

test('si el PMS rechaza la captura con el audio, el responder y el orquestador reales reintentan sin los bytes', async () => {
  for (const status of [413, 503]) {
    const cuerpos = [];
    const pms = { capture: async (body) => {
      cuerpos.push(body);
      if (cuerpos.length === 1) throw Object.assign(new Error('x'), { response: { status } });
      return { created_interaction: true };
    } };
    const orchestrator = new PilotOrchestrator({ pms, ai: {}, sendImage: async () => {}, sendText: async () => 'w', context: {} });
    // El mismo cableado de index.js.
    const responder = createM0CommercialResponder({
      capture: (payload) => capturarConRespaldo((p) => orchestrator.capture(p), payload, { error() {} }),
      ai: { async interpret() { throw new Error('no'); } },
      closedPilot: { async beginCommercial() { return { result: { processing_claimed: false, outboxes: [] } }; } },
      pms: { async processingFailure() {} }
    });
    const audioEquipo = { tipo: 'audio', estado: 'guardado', mime_type: 'audio/ogg', size_bytes: 3, sha256: 'a'.repeat(64), contenido_base64: 'QUJD' };
    const r = await responder.captureAndAcknowledge({ from: '573000000301', text: 'revise el 210, sin agua', messageId: `wamid.resp.${status}`,
      timestamp: '2026-11-03T01:00:00.000Z', audioEquipo });
    assert.equal(r.captured, true);
    assert.equal(cuerpos.length, 2);
    assert.equal(cuerpos[0].audio_equipo.contenido_base64, 'QUJD');
    assert.equal(cuerpos[1].audio_equipo.estado, 'no_descargado');
    assert.match(cuerpos[1].audio_equipo.motivo, new RegExp(String(status)));
    assert.equal(cuerpos[1].audio_equipo.contenido_base64, undefined);
    assert.equal(cuerpos[1].audio_equipo.sha256, undefined);
    assert.equal(cuerpos[1].mensaje, 'revise el 210, sin agua');
  }
});

test('sin archivo, un fallo de captura se propaga: no se reintenta', async () => {
  let llamadas = 0;
  const capture = async () => { llamadas += 1; throw new Error('pms_caido'); };
  await assert.rejects(capturarConRespaldo(capture, { mensaje: 'hola', audioEquipo: null }, { error() {} }), /pms_caido/);
  assert.equal(llamadas, 1);
});

test('si el PMS no contesta a tiempo, audioDelEquipo sigue sin archivo dentro del tope y sin descargar', async () => {
  let descargas = 0;
  const errores = [];
  const inicio = Date.now();
  const r = await audioDelEquipo({ audio: AUDIO, from: 'x', topeMs: 30, logger: { error: (...a) => errores.push(a) },
    esEquipo: () => new Promise(() => {}), descargar: async () => { descargas += 1; } });
  assert.equal(r, null);
  assert.equal(descargas, 0);
  assert.ok(Date.now() - inicio < 1000);
  assert.equal(errores[0][1].code, 'audio_equipo_tope');
});

test('el tope de 3 s es de la pregunta: la descarga de una persona del equipo conserva su propio plazo', async () => {
  const r = await audioDelEquipo({ audio: AUDIO, from: 'x', topeMs: 20, esEquipo: async () => true,
    descargar: async () => { await new Promise((ok) => setTimeout(ok, 60)); return { tipo: 'audio', estado: 'guardado' }; } });
  assert.equal(r.estado, 'guardado');
});

test('el respondedor y el orquestador llevan audio_equipo a la captura; sin el, el campo no va', async () => {
  const capturas = [];
  const pms = { capture: async (body) => { capturas.push(body); return { created_interaction: true }; } };
  const orchestrator = new PilotOrchestrator({ pms, ai: {}, sendImage: async () => {}, sendText: async () => 'w', context: {} });
  const responder = createM0CommercialResponder({ capture: (p) => orchestrator.capture(p), ai: { async interpret() { throw new Error('no'); } },
    closedPilot: { async beginCommercial() { return { result: { processing_claimed: false, outboxes: [] } }; } }, pms: { async processingFailure() {} } });
  const base = { from: '573000000301', text: 'revise el 210', timestamp: '2026-11-03T01:00:00.000Z' };
  await responder.captureAndAcknowledge({ ...base, messageId: 'wamid.a.1', audioEquipo: { tipo: 'audio', estado: 'guardado' } });
  await responder.captureAndAcknowledge({ ...base, messageId: 'wamid.a.2' });
  assert.deepEqual(capturas[0].audio_equipo, { tipo: 'audio', estado: 'guardado' });
  assert.equal(capturas[0].mensaje, 'revise el 210');
  assert.equal(capturas[1].audio_equipo, undefined);
});

test('telefonoEsEquipo pregunta firmado con plazo corto; solo true cuenta', async () => {
  const posts = [];
  const http = { post: async (url, body, cfg) => { posts.push({ url, body, cfg }); return { data: { data: { equipo: posts.length === 1 } } }; } };
  const client = new PmsPilotClient({ http, baseUrl: 'https://pms.example', inboundUrl: 'https://pms.example/i', secret: 's' });
  assert.equal(await client.telefonoEsEquipo('573000000301'), true);
  assert.equal(await client.telefonoEsEquipo('573000000001'), false);
  assert.equal(posts[0].url, 'https://pms.example/api/integrations/whatsapp/equipo/puede-audio');
  assert.equal(posts[0].cfg.timeout, 3000);
  assert.ok(posts[0].cfg.headers['X-PMS-Signature']);
});
