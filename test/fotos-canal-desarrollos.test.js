'use strict';

// FOTOS DEL CANAL DE DESARROLLOS (José Manuel, 2026-10-13, "Agrega el envío de
// fotos"). El PMS encola una fila 'image' por foto con la CLAVE del catálogo
// aprobado ("LF-510/01-portada") y su pie ("LF-510 · 1/6"). El webhook la
// traduce con su lista cerrada (apartment-photos.js) y la envía con la misma
// llamada a Meta que las fotos de Cami, ahora con pie.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { photoForKey, PHOTO_FILES, PHOTO_VERSION } = require('../lib/pilot/apartment-photos');
const { createM0ClosedPilotDispatcher } = require('../lib/pilot/m0-closed-pilot');

const guest = '573146892662', internal = '573006774425';
const config = { enabled: true, guestPhone: guest, internalPhone: internal, metaSignatureRequired: true,
  pmsM0Enabled: true, controlledIngressEnabled: true, pmsConfigured: true, receiptsEnabled: true,
  internalTemplateName: 'm0_internal_escalation_v1', internalTemplateLanguage: 'es_CO' };

test('photoForKey: solo claves de la lista cerrada, con la URL de siempre', () => {
  const foto = photoForKey('LF-510/03-cocina');
  assert.equal(foto.code, 'LF-510');
  assert.match(foto.url, new RegExp(`/media/photos/LF-510/03-cocina\\.jpg\\?v=${PHOTO_VERSION}$`));
  assert.equal(photoForKey('EDIFICIO/06-parqueadero').code, 'EDIFICIO');
  for (const mala of [null, '', 'LF-510/99-otra', 'LF-999/01-portada', 'LF-510/../01-portada', 'LF-510/01-portada.jpg',
    '__proto__/01-portada', 'https://x/media/photos/LF-510/01-portada.jpg']) {
    assert.equal(photoForKey(mala), null, String(mala));
  }
});

test('cada foto del catálogo existe en public/photos', () => {
  for (const [code, files] of Object.entries(PHOTO_FILES)) {
    for (const slug of files) assert.ok(fs.existsSync(path.join(__dirname, '..', 'public', 'photos', code, `${slug}.jpg`)), `${code}/${slug}`);
  }
});

test('la copia del catálogo en pms-lite (fotos-catalogo.js) coincide con PHOTO_FILES', async (t) => {
  // Sin M0_PMS_SOURCE_ROOT se omite AVISANDO (como las demas pruebas cruzadas);
  // con la variable y sin el archivo, FALLA: las dos listas no pueden separarse.
  const raiz = process.env.M0_PMS_SOURCE_ROOT;
  if (!raiz) return t.skip('COMPARACION DE CATALOGOS OMITIDA: falta M0_PMS_SOURCE_ROOT (checkout de pms-lite)');
  const archivo = path.join(raiz, 'src', 'modules', 'desarrollos-canal', 'fotos-catalogo.js');
  assert.ok(fs.existsSync(archivo), 'pms-lite sin src/modules/desarrollos-canal/fotos-catalogo.js');
  const { FOTOS_APROBADAS } = await import(pathToFileURL(archivo).href);
  assert.deepEqual(JSON.parse(JSON.stringify(FOTOS_APROBADAS)), JSON.parse(JSON.stringify(PHOTO_FILES)));
});

function dispatcherCon(claims, { sendPhoto } = {}) {
  const sent = { text: [], photo: [] }, completed = [];
  const cola = [...claims];
  const pms = {
    async claimClosedPilotOutbound() { return cola.shift() || { outbox_id: null, status: 'empty', claimable: false }; },
    async completeClosedPilotOutbound(body) { completed.push(body); }
  };
  const dispatcher = createM0ClosedPilotDispatcher({ config, pms,
    async sendText(to, text) { sent.text.push({ to, text }); return 'wamid.text'; },
    async sendTemplate() { return 'wamid.tpl'; },
    sendPhoto: sendPhoto || (async (to, url, caption) => { sent.photo.push({ to, url, caption }); return `wamid.photo.${sent.photo.length}`; }),
    logger: { info() {}, warn() {}, error() {} } });
  return { dispatcher, sent, completed };
}
const fotoClaim = (id, key, pie, extra = {}) => ({ outbox_id: id, claimable: true, status: 'submitting', recipient_kind: 'guest',
  recipient_phone: guest, message_kind: 'image', media_key: key, message_text: pie, ...extra });

test('poller: cada fila de imagen sale como foto con su pie, nunca como texto, y se informa al PMS', async () => {
  const { dispatcher, sent, completed } = dispatcherCon([fotoClaim(11, 'LF-510/01-portada', 'LF-510 · 1/6'),
    fotoClaim(12, 'EDIFICIO/03-terraza', 'Zonas comunes · 3/6')]);
  const results = await dispatcher.pollPendingInternalOutbox();
  assert.deepEqual(results.map((r) => [r.id, r.status, r.sent]), [[11, 'submitted', true], [12, 'submitted', true]]);
  assert.deepEqual(sent.text, []);
  assert.deepEqual(sent.photo.map((p) => [p.to, p.caption]), [[guest, 'LF-510 · 1/6'], [guest, 'Zonas comunes · 3/6']]);
  assert.match(sent.photo[0].url, /\/media\/photos\/LF-510\/01-portada\.jpg\?v=/);
  assert.equal(completed[0].status, 'submitted');
  assert.equal(completed[0].provider_reference, 'wamid.photo.1');
  assert.deepEqual(completed[0].media_sent, [{ code: 'LF-510', kind: 'gallery', ok: true, provider_reference: 'wamid.photo.1', url: sent.photo[0].url }]);
  assert.equal(completed[1].media_sent[0].code, 'EDIFICIO');
});

test('clave fuera de la lista cerrada o teléfono inválido: no se envía nada', async () => {
  const { dispatcher, sent, completed } = dispatcherCon([fotoClaim(21, 'LF-510/99-otra', 'x'),
    fotoClaim(22, 'LF-510/01-portada', 'LF-510 · 1/6', { recipient_phone: '12' })]);
  const results = await dispatcher.pollPendingInternalOutbox();
  assert.deepEqual(results.map((r) => r.status), ['failed', 'unknown']);
  assert.deepEqual(sent.photo, []);
  assert.deepEqual(sent.text, []);
  assert.deepEqual(completed, [{ outbox_id: 21, status: 'failed' }, { outbox_id: 22, status: 'unknown' }]);
});

test('Meta rechaza la foto: queda failed (sin respuesta segura: unknown) y el poller sigue', async () => {
  const { dispatcher, completed } = dispatcherCon([fotoClaim(31, 'LF-904/02-escritorio', 'LF-904 · 2/6'),
    fotoClaim(32, 'LF-904/03-cama', 'LF-904 · 3/6')],
  { sendPhoto: async () => { throw Object.assign(new Error('meta 400'), { response: { status: 400, data: { error: { message: 'bad' } } } }); } });
  const results = await dispatcher.pollPendingInternalOutbox();
  assert.equal(results.length, 2);
  assert.deepEqual(completed.map((c) => c.status), ['failed', 'failed']);
});

test('una fila de imagen que llegue por la entrega sincrónica tampoco sale como texto', async () => {
  const { dispatcher, sent } = dispatcherCon([fotoClaim(41, 'LF-210/02-cama', 'LF-210 · 2/6')]);
  const results = await dispatcher.deliverCommercialOutboxes([{ id: 41 }]);
  assert.equal(results[0].sent, true);
  assert.deepEqual(sent.text, []);
  assert.equal(sent.photo[0].caption, 'LF-210 · 2/6');
});
