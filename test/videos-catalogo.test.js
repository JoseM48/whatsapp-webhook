'use strict';

// VIDEOS DEL CATALOGO (Jose Manuel, 2026-11-04): cada video existe, cabe en el
// limite de WhatsApp, solo sale una clave de la lista cerrada y la entrega por el
// dispatcher completa la fila.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { videoForKey, VIDEO_CODES } = require('../lib/pilot/apartment-photos');
const { createM0ClosedPilotDispatcher } = require('../lib/pilot/m0-closed-pilot');

const guest = '573146892662';
const config = { enabled: true, guestPhone: guest, internalPhone: '573006774425', naturalPresentationEnabled: false };
function dispatcherCon(claims, sendVideo) {
  const sent = { text: [] }, completed = [], cola = [...claims];
  const pms = {
    async claimClosedPilotOutbound() { return cola.shift() || { outbox_id: null, status: 'empty', claimable: false }; },
    async completeClosedPilotOutbound(body) { completed.push(body); }
  };
  const dispatcher = createM0ClosedPilotDispatcher({ config, pms, sendVideo,
    async sendText(to, text) { sent.text.push({ to, text }); return 'wamid.text'; },
    async sendTemplate() { return 'wamid.tpl'; }, async sendPhoto() { return 'wamid.photo'; },
    logger: { info() {}, warn() {}, error() {} } });
  return { dispatcher, sent, completed };
}
const fila = (id, key, extra = {}) => ({ outbox_id: id, claimable: true, status: 'submitting', recipient_kind: 'guest',
  recipient_phone: guest, message_kind: 'video', media_key: key, message_text: 'LF-510 · Recorrido', ...extra });

test('una fila de video sale como video con su pie, nunca como texto', async () => {
  const enviados = [];
  const { dispatcher, sent, completed } = dispatcherCon([fila(1, 'LF-510/recorrido')], async (to, url, pie) => { enviados.push({ to, url, pie }); return 'wamid.video'; });
  const r = await dispatcher.pollPendingInternalOutbox();
  assert.deepEqual(r.map((x) => [x.id, x.status, x.sent]), [[1, 'submitted', true]]);
  assert.deepEqual(sent.text, []);
  assert.equal(enviados[0].pie, 'LF-510 · Recorrido');
  assert.match(enviados[0].url, /\/media\/videos\/LF-510\/recorrido\.mp4/);
  assert.deepEqual(completed, [{ outbox_id: 1, status: 'submitted', provider_reference: 'wamid.video' }]);
});

test('clave fuera de la lista, Meta rechaza o sin función: no sale como texto y queda el estado', async () => {
  const a = dispatcherCon([fila(2, 'LF-210/recorrido')], async () => 'x');
  assert.equal((await a.dispatcher.pollPendingInternalOutbox())[0].status, 'failed');
  const b = dispatcherCon([fila(3, 'LF-510/recorrido')], async () => { throw Object.assign(new Error('meta'), { response: { status: 400, data: { error: { message: 'bad' } } } }); });
  assert.equal((await b.dispatcher.pollPendingInternalOutbox())[0].status, 'failed');
  const c = dispatcherCon([fila(4, 'LF-510/recorrido')], null);
  assert.equal((await c.dispatcher.pollPendingInternalOutbox())[0].status, 'failed');
  for (const d of [a, b, c]) assert.deepEqual(d.sent.text, []);
});

test('cada video del catalogo existe y pesa menos de 16 MB', () => {
  for (const code of VIDEO_CODES) {
    const archivo = path.join(__dirname, '..', 'public', 'videos', code, 'recorrido.mp4');
    assert.ok(fs.existsSync(archivo), `falta ${archivo}`);
    assert.ok(fs.statSync(archivo).size < 16 * 1024 * 1024, `${code} supera 16 MB`);
  }
});

test('solo se resuelven claves de la lista cerrada', () => {
  assert.match(videoForKey('LF-510/recorrido').url, /\/media\/videos\/LF-510\/recorrido\.mp4\?v=/);
  for (const clave of ['LF-210/recorrido', 'LF-510/otro', '../LF-510/recorrido', '', null]) assert.equal(videoForKey(clave), null);
});

test('la copia del catalogo en pms-lite coincide con VIDEO_CODES', async (t) => {
  const raiz = process.env.M0_PMS_SOURCE_ROOT;
  if (!raiz) return t.skip('COMPARACION DE CATALOGOS OMITIDA: falta M0_PMS_SOURCE_ROOT (checkout de pms-lite)');
  const { CODIGOS_CON_VIDEO } = await import(pathToFileURL(path.join(raiz, 'src/modules/desarrollos-canal/fotos-catalogo.js')).href);
  assert.deepEqual([...CODIGOS_CON_VIDEO], VIDEO_CODES);
});
