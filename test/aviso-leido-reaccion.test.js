'use strict';

// REACCION ✅ AL AVISO LEIDO (José Manuel, 2026-10-23, instruccion 54): al marcar
// un aviso Leido, el PMS encola una fila 'reaction' con el wamid del mensaje
// original; este webhook la envia como reaccion (type 'reaction') al numero
// interno. Nunca sale como texto y nunca lanza.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createM0ClosedPilotDispatcher } = require('../lib/pilot/m0-closed-pilot');
const { PmsPilotClient } = require('../lib/pilot/pms-client');

const internal = '573006774425';
const config = { enabled: true, guestPhone: '573146892662', internalPhone: internal, metaSignatureRequired: true,
  pmsM0Enabled: true, controlledIngressEnabled: true, pmsConfigured: true, receiptsEnabled: true,
  internalTemplateName: 'm0_internal_escalation_v1', internalTemplateLanguage: 'es_CO' };
const silencioso = { info() {}, log() {}, error() {}, warn() {} };
const CLAIM = { outbox_id: 77, claimable: true, recipient_kind: 'internal', message_kind: 'reaction',
  message_text: 'REACCIÓN ✅ al aviso 42', reaction: { message_id: 'wamid.HBgMNTczMDA2Nzc0NDI1FQIAERgS', emoji: '✅' } };

function dispatcherCon(claim, { sendReaction } = {}) {
  const sent = [], reactions = [], completed = [];
  const pms = {
    async beginClosedPilotCommercial() { return { outboxes: [{ id: 77 }] }; },
    async claimClosedPilotOutbound() { return claim; },
    async completeClosedPilotOutbound(body) { completed.push(body); }
  };
  const d = createM0ClosedPilotDispatcher({ config, pms, logger: silencioso,
    async sendText(phone, text) { sent.push({ phone, text }); return 'wamid.t'; },
    async sendTemplate(phone, t) { sent.push({ phone, t }); return 'wamid.p'; },
    sendReaction: sendReaction === undefined
      ? async (phone, body) => { reactions.push({ phone, ...body }); return 'wamid.r'; } : sendReaction });
  return { d, sent, reactions, completed };
}

test('el claim declara internal_reaction en X-M0-Accepts', async () => {
  const calls = [];
  const client = new PmsPilotClient({ baseUrl: 'https://pms.test', secret: 's',
    http: { async post(url, body, options) { calls.push({ options }); return { data: { data: { claimable: false } } }; } } });
  await client.claimClosedPilotOutbound(5);
  assert.ok(calls[0].options.headers['X-M0-Accepts'].split(',').map((s) => s.trim()).includes('internal_reaction'));
});

test('entrega sincronica (outboxes del Leido): reacciona al wamid original en el numero interno, sin texto', async () => {
  const { d, sent, reactions, completed } = dispatcherCon(CLAIM);
  const r = await d.deliverCommercialOutboxes([{ id: 77 }]);
  assert.deepEqual(reactions, [{ phone: internal, messageId: CLAIM.reaction.message_id, emoji: '✅' }]);
  assert.equal(sent.length, 0);
  assert.deepEqual(completed, [{ outbox_id: 77, status: 'submitted', provider_reference: 'wamid.r' }]);
  assert.equal(r[0].status, 'submitted');
});

test('el sondeo tambien la entrega', async () => {
  let n = 0;
  const reactions = [], completed = [];
  const pms = { async claimClosedPilotOutbound() { n += 1; return n === 1 ? CLAIM : { claimable: false }; },
    async completeClosedPilotOutbound(body) { completed.push(body); } };
  const d = createM0ClosedPilotDispatcher({ config, pms, logger: silencioso, async sendText() { return 'x'; }, async sendTemplate() { return 'x'; },
    async sendReaction(phone, body) { reactions.push({ phone, ...body }); return 'wamid.r'; } });
  const res = await d.pollPendingInternalOutbox();
  assert.equal(reactions.length, 1);
  assert.equal(completed[0].status, 'submitted');
  assert.equal(res[0].sent, true);
});

test('Meta la rechaza (4xx): fila failed, no lanza y no manda texto; incierta (timeout): unknown', async () => {
  const rechazo = async () => { throw Object.assign(new Error('bad'), { response: { status: 400 } }); };
  const a = dispatcherCon(CLAIM, { sendReaction: rechazo });
  const r = await a.d.deliverCommercialOutboxes([{ id: 77 }]);
  assert.equal(r[0].status, 'failed');
  assert.deepEqual(a.completed, [{ outbox_id: 77, status: 'failed' }]);
  assert.equal(a.sent.length, 0);
  const b = dispatcherCon(CLAIM, { sendReaction: async () => { throw Object.assign(new Error('t'), { code: 'ECONNABORTED' }); } });
  await b.d.deliverCommercialOutboxes([{ id: 77 }]);
  assert.deepEqual(b.completed, [{ outbox_id: 77, status: 'unknown' }]);
});

test('sin emisor de reacciones, sin wamid valido o a un destinatario que no es el interno: failed, nunca texto', async () => {
  for (const [claim, opts] of [[CLAIM, { sendReaction: null }],
    [{ ...CLAIM, reaction: { message_id: 'x y', emoji: '✅' } }, {}],
    [{ ...CLAIM, reaction: null }, {}],
    [{ ...CLAIM, recipient_kind: 'guest' }, {}]]) {
    const { d, sent, reactions, completed } = dispatcherCon(claim, opts);
    await d.deliverCommercialOutboxes([{ id: 77 }]);
    assert.equal(sent.length, 0);
    assert.equal(reactions.length, 0);
    assert.deepEqual(completed, [{ outbox_id: 77, status: 'failed' }]);
  }
});

test('si el PMS no registra el estado, la reaccion no tumba nada', async () => {
  const pms = { async claimClosedPilotOutbound() { return CLAIM; },
    async completeClosedPilotOutbound() { throw new Error('pms caido'); } };
  const d = createM0ClosedPilotDispatcher({ config, pms, logger: silencioso, async sendText() { return 'x'; }, async sendTemplate() { return 'x'; },
    async sendReaction() { return 'wamid.r'; } });
  const r = await d.deliverCommercialOutboxes([{ id: 77 }]);
  assert.equal(r[0].status, 'submitted');
});
