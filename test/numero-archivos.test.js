'use strict';

// Archivos al 7355 (2026-11-01). Teléfonos FALSOS.
const test = require('node:test');
const assert = require('node:assert/strict');
const { atenderTengoCamello, atenderTengoCamelloDemo } = require('../lib/pilot/numero-entrante');
const { extractMetaMessages } = require('../lib/pilot/meta-inbound');

const FROM = '573000000901';
const silencio = { info() {}, warn() {}, error() {} };

function cambio(mensaje) {
  return { field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: '2' },
    contacts: [{ wa_id: FROM, profile: { name: 'Prueba' } }],
    messages: [{ from: FROM, id: 'wamid.a1', timestamp: '1761600000', ...mensaje }] } };
}
const PDF = { type: 'document', document: { id: 'media1', mime_type: 'application/pdf', filename: 'factura.pdf', caption: 'de la finca' } };

function montar({ falla = false, respuesta = { responder: true, mensajes: ['recibido'] } } = {}) {
  const posts = [], enviados = [], descargas = [];
  return { posts, enviados, descargas,
    deps: { pmsBaseUrl: 'http://pms', extractMetaMessages, logger: silencio,
      enviarTexto: async (to, body) => { enviados.push(body); },
      pms: { postUrl: async (url, body, opts) => {
        posts.push({ url, body, opts });
        if (falla && body.adjunto?.contenido_base64) throw Object.assign(new Error('grande'), { response: { status: 413 } });
        return respuesta;
      } } },
    descargar: async (media) => { descargas.push(media); return { tipo: media.tipo, estado: 'guardado', filename: media.filename, mime_type: media.mimeType, size_bytes: 3, sha256: 'a'.repeat(64), contenido_base64: 'YWJj' }; } };
}

test('un PDF al 7355 se descarga y viaja al PMS con plazo largo', async () => {
  const m = montar();
  await atenderTengoCamello([cambio(PDF)], { ...m.deps, descargarAdjunto: m.descargar });
  assert.equal(m.descargas[0].id, 'media1');
  assert.equal(m.posts[0].body.adjunto.filename, 'factura.pdf');
  assert.equal(m.posts[0].opts.timeoutMs, 30000);
  assert.deepEqual(m.enviados, ['recibido']);
});

test('si el PMS rechaza el archivo se reintenta sin contenido y el mensaje no se pierde', async () => {
  const m = montar({ falla: true });
  await atenderTengoCamello([cambio(PDF)], { ...m.deps, descargarAdjunto: m.descargar });
  assert.equal(m.posts.length, 2);
  assert.equal(m.posts[1].body.adjunto.estado, 'no_descargado');
  assert.equal(m.posts[1].body.adjunto.contenido_base64, undefined);
  assert.deepEqual(m.enviados, ['recibido']);
});

test('un sticker no cuenta como archivo; un texto no descarga nada', async () => {
  const m = montar();
  await atenderTengoCamello([cambio({ type: 'sticker', sticker: { id: 's1', mime_type: 'image/webp' } })], { ...m.deps, descargarAdjunto: m.descargar });
  await atenderTengoCamello([cambio({ type: 'text', text: { body: 'hola' } })], { ...m.deps, descargarAdjunto: m.descargar });
  assert.equal(m.descargas.length, 0);
  assert.ok(m.posts.every((p) => !p.body.adjunto));
});

test('el 7354 (demo) aún no descarga archivos: excepción declarada', async () => {
  const m = montar();
  await atenderTengoCamelloDemo([cambio(PDF)], m.deps);
  assert.equal(m.descargas.length, 0);
  assert.equal(m.posts[0].body.adjunto, undefined);
});
