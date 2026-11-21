'use strict';
// TEO-COLA #523 (2026-11-21, Nick, LF-904, outbox 8793 y 8800): la autorización a portería con botón
// («✅ Ya ingresó») nace en un tick del PMS y solo sale por el sondeo (pollPendingInternalOutbox).
// Antes una fila 'buttons' de huésped/equipo caía en 'unexpected_recipient_kind' (unknown) y no salía.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createM0ClosedPilotDispatcher } = require('../lib/pilot/m0-closed-pilot');

const porteria = '573001112233', internal = '573006774425';
const config = { enabled: true, guestPhone: porteria, internalPhone: internal, metaSignatureRequired: true,
  pmsM0Enabled: true, controlledIngressEnabled: true, pmsConfigured: true, receiptsEnabled: true,
  internalTemplateName: 'm0_internal_escalation_v1', internalTemplateLanguage: 'es_CO' };

function dispatcherCon(claims, { sendButtons } = {}) {
  const sent = { text: [], buttons: [] }, completed = [], cola = [...claims];
  const pms = {
    async claimClosedPilotOutbound() { return cola.shift() || { outbox_id: null, status: 'empty', claimable: false }; },
    async completeClosedPilotOutbound(body) { completed.push(body); }
  };
  const dispatcher = createM0ClosedPilotDispatcher({ config, pms,
    async sendText(to, text) { sent.text.push({ to, text }); return 'wamid.text'; },
    async sendTemplate() { return 'wamid.tpl'; },
    async sendPhoto() { return 'wamid.photo'; },
    sendButtons: sendButtons === undefined ? (async (to, b) => { sent.buttons.push({ to, ...b }); return 'wamid.btn.1'; }) : sendButtons,
    logger: { info() {}, warn() {}, error() {} } });
  return { dispatcher, sent, completed };
}
const TEXTO = 'Autorización de ingreso para hoy 20/11:\nNick Florida, 904, hasta el 24, una persona';
const btnClaim = (id, extra = {}) => ({ outbox_id: id, claimable: true, status: 'submitting', recipient_kind: 'guest',
  recipient_phone: porteria, message_kind: 'buttons', message_text: TEXTO,
  buttons: [{ id: 'porteria:ingreso:38', title: '✅ Ya ingresó' }],
  fallback_text: `${TEXTO}\n\nResponde: «✅ Ya ingresó»`, equipo: true, ...extra });

test('sondeo: la autorización con botón sale como botones y queda submitted', async () => {
  const { dispatcher, sent, completed } = dispatcherCon([btnClaim(8793)]);
  const results = await dispatcher.pollPendingInternalOutbox();
  assert.deepEqual(results.map((r) => [r.id, r.status, r.sent]), [[8793, 'submitted', true]]);
  assert.equal(sent.buttons.length, 1);
  assert.equal(sent.buttons[0].to, porteria);
  assert.equal(sent.buttons[0].bodyText, TEXTO);
  assert.deepEqual(sent.buttons[0].buttons, [{ id: 'porteria:ingreso:38', title: '✅ Ya ingresó' }]);
  assert.deepEqual(sent.text, []);
  assert.deepEqual(completed, [{ outbox_id: 8793, status: 'submitted', provider_reference: 'wamid.btn.1' }]);
});

test('sondeo: sin emisor de botones o botones inválidos -> sale el texto de respaldo, submitted', async () => {
  const sinEmisor = dispatcherCon([btnClaim(1)], { sendButtons: null });
  assert.deepEqual((await sinEmisor.dispatcher.pollPendingInternalOutbox()).map((r) => r.status), ['submitted']);
  assert.equal(sinEmisor.sent.text[0].text, `${TEXTO}\n\nResponde: «✅ Ya ingresó»`);
  const largo = dispatcherCon([btnClaim(2, { buttons: [{ id: 'x', title: 'un título demasiado largo para Meta' }] })]);
  assert.deepEqual((await largo.dispatcher.pollPendingInternalOutbox()).map((r) => r.status), ['submitted']);
  assert.equal(largo.sent.buttons.length, 0);
  assert.equal(largo.sent.text.length, 1);
});

test('sondeo: teléfono inválido -> unknown sin enviar; Meta rechaza -> failed y el sondeo sigue', async () => {
  const malo = dispatcherCon([btnClaim(3, { recipient_phone: '12' })]);
  assert.deepEqual((await malo.dispatcher.pollPendingInternalOutbox()).map((r) => r.status), ['recipient_missing_or_invalid']);
  assert.deepEqual(malo.completed.map((c) => c.status), ['unknown']);
  assert.deepEqual(malo.sent.buttons, []);
  const rechazo = dispatcherCon([btnClaim(4), btnClaim(5)],
    { sendButtons: async () => { throw Object.assign(new Error('meta 400'), { response: { status: 400, data: { error: { message: 'bad' } } } }); } });
  const r = await rechazo.dispatcher.pollPendingInternalOutbox();
  assert.equal(r.length, 2);
  assert.deepEqual(rechazo.completed.map((c) => c.status), ['failed', 'failed']);
});
