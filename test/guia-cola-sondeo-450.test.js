'use strict';
// TEO-COLA #450 (2026-11-20, Nick, lead 285, reserva 63): la guía del sector en cola nace en un tick del PMS y
// solo sale por el sondeo (pollPendingInternalOutbox). Antes, un documento de huésped caía en 'unknown'.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createM0ClosedPilotDispatcher } = require('../lib/pilot/m0-closed-pilot');

const guest = '573146892662', internal = '573006774425';
const config = { enabled: true, guestPhone: guest, internalPhone: internal, metaSignatureRequired: true,
  pmsM0Enabled: true, controlledIngressEnabled: true, pmsConfigured: true, receiptsEnabled: true,
  internalTemplateName: 'm0_internal_escalation_v1', internalTemplateLanguage: 'es_CO' };
const LINK = 'https://pms-lite-pilot.onrender.com/media/guia/c473e823a97063124e26066e/guia-sector-mio-la-frontera-v1.pdf';

function dispatcherCon(claims, { sendDocument } = {}) {
  const sent = { text: [], doc: [] }, completed = [], cola = [...claims];
  const pms = {
    async claimClosedPilotOutbound() { return cola.shift() || { outbox_id: null, status: 'empty', claimable: false }; },
    async completeClosedPilotOutbound(body) { completed.push(body); }
  };
  const dispatcher = createM0ClosedPilotDispatcher({ config, pms,
    async sendText(to, text) { sent.text.push({ to, text }); return 'wamid.text'; },
    async sendTemplate() { return 'wamid.tpl'; },
    async sendPhoto() { return 'wamid.photo'; },
    sendDocument: sendDocument === undefined ? (async (to, d) => { sent.doc.push({ to, ...d }); return 'wamid.doc.1'; }) : sendDocument,
    logger: { info() {}, warn() {}, error() {} } });
  return { dispatcher, sent, completed };
}
const docClaim = (id, extra = {}) => ({ outbox_id: id, claimable: true, status: 'submitting', recipient_kind: 'guest',
  recipient_phone: guest, message_kind: 'document', document_key: 'guia_huesped_v1', document_link: LINK,
  message_text: 'Te comparto la guía del sector.', ...extra });

test('sondeo: la guía en cola sale como documento y queda submitted', async () => {
  const { dispatcher, sent, completed } = dispatcherCon([docClaim(41)]);
  const results = await dispatcher.pollPendingInternalOutbox();
  assert.deepEqual(results.map((r) => [r.id, r.status, r.sent]), [[41, 'submitted', true]]);
  assert.deepEqual(sent.text, []);
  assert.equal(sent.doc.length, 1);
  assert.equal(sent.doc[0].to, guest);
  assert.equal(sent.doc[0].link, LINK);
  assert.equal(sent.doc[0].caption, 'Te comparto la guía del sector.');
  assert.deepEqual(completed, [{ outbox_id: 41, status: 'submitted', provider_reference: 'wamid.doc.1' }]);
});

test('sondeo: enlace o clave fuera de la lista, sin emisor o teléfono inválido: no se envía nada, nunca texto', async () => {
  const { dispatcher, sent, completed } = dispatcherCon([docClaim(51, { document_link: 'https://evil.example/x.pdf' }),
    docClaim(52, { document_key: 'otro' }), docClaim(53, { recipient_phone: '12' })]);
  const results = await dispatcher.pollPendingInternalOutbox();
  assert.deepEqual(results.map((r) => r.status), ['failed', 'failed', 'unknown']);
  assert.deepEqual(sent.doc, []);
  assert.deepEqual(sent.text, []);
  assert.deepEqual(completed.map((c) => c.status), ['failed', 'failed', 'unknown']);
  const sinEmisor = dispatcherCon([docClaim(54)], { sendDocument: null });
  assert.deepEqual((await sinEmisor.dispatcher.pollPendingInternalOutbox()).map((r) => r.status), ['failed']);
});

test('sondeo: Meta rechaza el documento -> failed y el sondeo sigue', async () => {
  const { dispatcher, completed } = dispatcherCon([docClaim(61), docClaim(62)],
    { sendDocument: async () => { throw Object.assign(new Error('meta 400'), { response: { status: 400, data: { error: { message: 'bad' } } } }); } });
  const results = await dispatcher.pollPendingInternalOutbox();
  assert.equal(results.length, 2);
  assert.deepEqual(completed.map((c) => c.status), ['failed', 'failed']);
});
