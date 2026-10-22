'use strict';

// AVISO LEIDO (2026-10-21): con la ventana de 24 h abierta y este webhook
// declarando internal_buttons, el PMS manda internal_delivery 'buttons': el
// aviso sale con el boton de respuesta rapida "✅ Leído"; si Meta lo rechaza o
// no hay emisor de botones, sale internal_fallback_text (con "responde LEÍDO <id>").
const test = require('node:test');
const assert = require('node:assert/strict');
const { createM0ClosedPilotDispatcher, internalDelivery } = require('../lib/pilot/m0-closed-pilot');
const { textForMessage } = require('../lib/pilot/meta-inbound');
const { PmsPilotClient } = require('../lib/pilot/pms-client');

const internal = '573006774425';
const config = { enabled: true, guestPhone: '573146892662', internalPhone: internal, metaSignatureRequired: true,
  pmsM0Enabled: true, controlledIngressEnabled: true, pmsConfigured: true, receiptsEnabled: true,
  internalTemplateName: 'm0_internal_escalation_v1', internalTemplateLanguage: 'es_CO' };
const status = { internalTemplateName: 'm0_internal_escalation_v1', internalTemplateLanguage: 'es_CO' };
const SOBRE = 'PILOTO M0\nPARA: PROPIETARIO\nCASO: M0-1\nAPARTAMENTO: LF-210\nACCIÓN SOLICITADA: VALIDAR\n\nRevisar\nsolicitud.';
const TEXTO = 'ADMINISTRADOR · URGENTE · Lead #114 · Cami no sabe responder\n\n¿Laureles?';
const RESPALDO = `${TEXTO}\n\nResponde LEÍDO 42 cuando lo veas.`;
const BOTONES = [{ id: 'aviso_leido:42', title: '✅ Leído' }];
const claimBotones = { internal_delivery: 'buttons', internal_text: TEXTO, internal_buttons: BOTONES, internal_fallback_text: RESPALDO };
const silencioso = { info() {}, log() {}, error() {}, warn() {} };

function dispatcherCon(claim, { sendButtons } = {}) {
  const sent = [], buttons = [], templates = [], completed = [], warns = [];
  const pms = {
    async closedPilotInbound() { return { outboxes: [{ id: 42 }] }; },
    async claimClosedPilotOutbound() { return { outbox_id: 42, claimable: true, recipient_kind: 'internal', message_text: SOBRE, ...claim }; },
    async completeClosedPilotOutbound(body) { completed.push(body); }
  };
  const logger = { ...silencioso, warn(...a) { warns.push(a); } };
  const d = createM0ClosedPilotDispatcher({ config, pms, logger,
    async sendText(phone, text) { sent.push({ phone, text }); return 'wamid.t'; },
    async sendTemplate(phone, template) { templates.push({ phone, template }); return 'wamid.p'; },
    sendButtons: sendButtons === undefined
      ? async (phone, body) => { buttons.push({ phone, ...body }); return 'wamid.b'; } : sendButtons });
  return { d, sent, buttons, templates, completed, warns };
}
const procesar = (d) => d.process({ phone: internal, text: 'hola', messageId: 'wamid.in.1', occurredAt: new Date().toISOString() });

test('el claim declara internal_buttons en X-M0-Accepts (fuera del cuerpo firmado)', async () => {
  const calls = [];
  const client = new PmsPilotClient({ baseUrl: 'https://pms.test', secret: 's',
    http: { async post(url, body, options) { calls.push({ url, body, options }); return { data: { data: { claimable: false } } }; } } });
  await client.claimClosedPilotOutbound(5);
  const capacidades = calls[0].options.headers['X-M0-Accepts'].split(',').map((s) => s.trim());
  assert.ok(capacidades.includes('internal_buttons'));
  assert.deepEqual(calls[0].body, { outbox_id: 5 });
});

test('internal_delivery buttons: el aviso sale con el boton "✅ Leído" y el texto sin la linea LEÍDO', async () => {
  const { d, sent, buttons, templates, completed } = dispatcherCon(claimBotones);
  await procesar(d);
  assert.deepEqual(buttons, [{ phone: internal, bodyText: TEXTO, buttons: BOTONES }]);
  assert.equal(sent.length, 0);
  assert.equal(templates.length, 0);
  assert.equal(completed[0].status, 'submitted');
  assert.equal(completed[0].provider_reference, 'wamid.b');
});

test('Meta rechaza los botones (4xx): sale el texto de respaldo con la linea LEÍDO', async () => {
  const rechazo = async () => { throw Object.assign(new Error('bad request'), { response: { status: 400 } }); };
  const { d, sent, completed, warns } = dispatcherCon(claimBotones, { sendButtons: rechazo });
  await procesar(d);
  assert.deepEqual(sent, [{ phone: internal, text: RESPALDO }]);
  assert.equal(completed[0].status, 'submitted');
  assert.equal(completed[0].provider_reference, 'wamid.t');
  assert.equal(warns.length, 1);
});

test('envio incierto de los botones (timeout/5xx): NO se manda el respaldo (evita duplicar); la fila queda unknown', async () => {
  for (const error of [Object.assign(new Error('timeout of 15000ms exceeded'), { code: 'ECONNABORTED' }),
    Object.assign(new Error('server'), { response: { status: 502 } })]) {
    const { d, sent, completed } = dispatcherCon(claimBotones, { sendButtons: async () => { throw error; } });
    // Igual que cualquier otro envio fallido: la fila se marca y el error sube.
    await assert.rejects(procesar(d), (e) => e === error);
    assert.equal(sent.length, 0);
    assert.equal(completed[0].status, 'unknown');
  }
});

test('sin emisor de botones: sale el texto de respaldo', async () => {
  const { d, sent } = dispatcherCon(claimBotones, { sendButtons: null });
  await procesar(d);
  assert.deepEqual(sent, [{ phone: internal, text: RESPALDO }]);
});

test('botones invalidos o cuerpo de mas de 1024: sale el respaldo como texto', () => {
  assert.deepEqual(internalDelivery({ ...claimBotones, internal_buttons: [{ id: 'x', title: '' }] }, status),
    { mode: 'text', text: RESPALDO });
  assert.deepEqual(internalDelivery({ ...claimBotones, internal_buttons: [] }, status), { mode: 'text', text: RESPALDO });
  assert.deepEqual(internalDelivery({ ...claimBotones, internal_text: 'x'.repeat(1025) }, status), { mode: 'text', text: RESPALDO });
  // Sin respaldo del PMS: el mismo texto del aviso.
  const { internal_fallback_text: _omit, ...sinRespaldo } = claimBotones;
  assert.deepEqual(internalDelivery({ ...sinRespaldo, internal_buttons: null }, status), { mode: 'text', text: TEXTO });
  assert.deepEqual(internalDelivery(claimBotones, status), { mode: 'buttons', text: TEXTO, buttons: BOTONES, fallback: RESPALDO });
});

test('internal_delivery buttons sin internal_text: cae a la plantilla de siempre (PMS anterior o fila rota)', () => {
  const plan = internalDelivery({ internal_delivery: 'buttons', internal_buttons: BOTONES, message_text: SOBRE }, status);
  assert.equal(plan.mode, 'template');
  assert.equal(plan.template.name, 'm0_internal_escalation_v1');
});

test('el sondeo de avisos internos tambien envia con botones', async () => {
  const buttons = [], completed = [];
  let reclamos = 0;
  const pms = {
    async claimClosedPilotOutbound() {
      reclamos += 1;
      return reclamos === 1 ? { outbox_id: 42, claimable: true, recipient_kind: 'internal', message_text: SOBRE, ...claimBotones } : { claimable: false };
    },
    async completeClosedPilotOutbound(body) { completed.push(body); }
  };
  const d = createM0ClosedPilotDispatcher({ config, pms, logger: silencioso,
    async sendText() { return 'wamid.t'; }, async sendTemplate() { return 'wamid.p'; },
    async sendButtons(phone, body) { buttons.push({ phone, ...body }); return 'wamid.b'; } });
  await d.pollPendingInternalOutbox();
  assert.deepEqual(buttons, [{ phone: internal, bodyText: TEXTO, buttons: BOTONES }]);
  assert.equal(completed[0].status, 'submitted');
  assert.equal(completed[0].provider_reference, 'wamid.b');
});

test('entrada: el toque del boton "aviso_leido:<id>" llega como "LEÍDO <id>"; los demas botones, con su titulo', () => {
  const toque = (id, title) => textForMessage({ type: 'interactive', interactive: { type: 'button_reply', button_reply: { id, title } } });
  assert.equal(toque('aviso_leido:42', '✅ Leído'), 'LEÍDO 42');
  assert.equal(toque('boton_1', 'Hablar con alguien'), 'Hablar con alguien');
  assert.equal(toque('aviso_leido:abc', '✅ Leído'), '✅ Leído');
});

test('"✅ Leído" y "LEÍDO <id>" son comandos literales: nunca pasan por el modelo del gerente', () => {
  const { isLiteralCommand } = require('../lib/pilot/llm/manager-intent');
  for (const t of ['✅ Leído', '✅️ Leído', 'LEÍDO 42', 'leido #42', 'Leído.', 'leída 7 ✅']) assert.equal(isLiteralCommand(t), true, t);
  for (const t of ['ya lo leí', 'leído el mensaje del 114', '¿lo leíste?']) assert.equal(isLiteralCommand(t), false, t);
});
