'use strict';

// CALENDARIO VISUAL (José Manuel, 2026-10-15). El PMS genera el calendario de
// operaciones en PNG para las personas del equipo y, al reclamar la fila,
// manda el enlace (token que vence en 24 h). El webhook solo lo envía si es
// una fila del equipo, con la clave conocida y un enlace https con la ruta
// exacta /media/equipo/<32 hex>.png. Teléfonos FALSOS.

const test = require('node:test');
const assert = require('node:assert/strict');
const { teamImage } = require('../lib/pilot/team-images');
const { createM0ClosedPilotDispatcher } = require('../lib/pilot/m0-closed-pilot');

const persona = '573000000101';
const config = { enabled: true, guestPhone: '573000000001', internalPhone: '573000000002', metaSignatureRequired: true,
  pmsM0Enabled: true, controlledIngressEnabled: true, pmsConfigured: true, receiptsEnabled: true,
  internalTemplateName: 'm0_internal_escalation_v1', internalTemplateLanguage: 'es_CO' };
const TOKEN = 'a'.repeat(32);
const LINK = `https://pms-lite-pilot.onrender.com/media/equipo/${TOKEN}.png`;
const KEY = 'equipo/calendario-operaciones';

function dispatcherCon(claims) {
  const sent = { text: [], photo: [] }, completed = [];
  const cola = [...claims];
  const pms = {
    async claimClosedPilotOutbound() { return cola.shift() || { outbox_id: null, status: 'empty', claimable: false }; },
    async completeClosedPilotOutbound(body) { completed.push(body); }
  };
  const dispatcher = createM0ClosedPilotDispatcher({ config, pms,
    async sendText(to, text) { sent.text.push({ to, text }); return 'wamid.text'; },
    async sendTemplate() { return 'wamid.tpl'; },
    async sendPhoto(to, url, caption) { sent.photo.push({ to, url, caption }); return `wamid.photo.${sent.photo.length}`; },
    logger: { info() {}, warn() {}, error() {} } });
  return { dispatcher, sent, completed };
}
const claim = (id, extra = {}) => ({ outbox_id: id, claimable: true, status: 'submitting', recipient_kind: 'guest', recipient_phone: persona,
  message_kind: 'image', media_key: KEY, media_link: LINK, equipo: true,
  message_text: 'Calendario de operaciones · hoy 15 oct\nSalen hoy: LF-404 · Llegan hoy: ninguno\n\nEscribe Menu para volver al menú.', ...extra });

test('teamImage: solo la clave conocida y un enlace https con la ruta exacta', () => {
  assert.deepEqual(teamImage(KEY, LINK), { code: KEY, url: LINK, team: true });
  for (const [k, l] of [['otra', LINK], [KEY, LINK.replace('https:', 'http:')], [KEY, `${LINK}?x=1`], [KEY, `${LINK}#a`],
    [KEY, 'https://pms-lite-pilot.onrender.com/media/equipo/abc.png'], [KEY, 'https://pms-lite-pilot.onrender.com/media/equipo/../guia/x.pdf'],
    [KEY, `https://u:p@pms-lite-pilot.onrender.com/media/equipo/${TOKEN}.png`], [KEY, null], ['__proto__', LINK], ['LF-510/01-portada', LINK]]) {
    assert.equal(teamImage(k, l), null, `${k} ${l}`);
  }
});

test('fila del equipo: sale como imagen con el enlace del PMS y el pie completo; se informa sin media_sent', async () => {
  const { dispatcher, sent, completed } = dispatcherCon([claim(51)]);
  const results = await dispatcher.deliverCommercialOutboxes([{ id: 51 }]);
  assert.equal(results[0].sent, true);
  assert.deepEqual(sent.text, []);
  assert.deepEqual(sent.photo, [{ to: persona, url: LINK, caption: claim(51).message_text }]);
  assert.deepEqual(completed, [{ outbox_id: 51, status: 'submitted', provider_reference: 'wamid.photo.1' }]);
});

test('el poller también la entrega; enlace inválido o sin marca de equipo: no se envía nada', async () => {
  const { dispatcher, sent, completed } = dispatcherCon([claim(61), claim(62, { media_link: `${LINK}?x=1` }), claim(63, { equipo: undefined })]);
  const results = await dispatcher.pollPendingInternalOutbox();
  assert.deepEqual(results.map((r) => r.status), ['submitted', 'failed', 'failed']);
  assert.equal(sent.photo.length, 1);
  assert.deepEqual(sent.text, []);
  assert.deepEqual(completed.slice(1), [{ outbox_id: 62, status: 'failed' }, { outbox_id: 63, status: 'failed' }]);
});
