'use strict';

// AVISOS A JOSÉ CON BOTONES (José Manuel, 2026-11-10). El PMS manda
// internal_delivery 'interactive' con la pregunta corta y sus opciones (botones o
// lista). El toque vuelve como "BOTON AVISO <decision> <n> [SI|NO]": el PMS
// resuelve esa decision exacta. Si Meta rechaza el interactivo, sale el aviso de
// siempre (internal_fallback_text).
const test = require('node:test');
const assert = require('node:assert/strict');
const { createM0ClosedPilotDispatcher } = require('../lib/pilot/m0-closed-pilot');
const { textForMessage } = require('../lib/pilot/meta-inbound');
const { isLiteralCommand } = require('../lib/pilot/llm/manager-intent');
const { PmsPilotClient } = require('../lib/pilot/pms-client');

const internal = '573006774425';
const config = { enabled: true, guestPhone: '573146892662', internalPhone: internal, metaSignatureRequired: true,
  pmsM0Enabled: true, controlledIngressEnabled: true, pmsConfigured: true, receiptsEnabled: true,
  internalTemplateName: 'm0_internal_escalation_v1', internalTemplateLanguage: 'es_CO' };
const SOBRE = 'PILOTO M0\nPARA: PROPIETARIO\nCASO: M0-1\nAPARTAMENTO: LF-210\nACCIÓN SOLICITADA: APROBAR O RECHAZAR\n\nRevisar.';
const PREGUNTA = 'Propietario · LF-210\n¿Apruebas la reserva de Ana del 12 al 19 dic?';
const RESPALDO = 'PROPIETARIO · HOY · Lead #360 · Aprobar\n\n1 · Aprobar\nResponde: 360 1';
const BOTONES = { tipo: 'botones', botones: [{ id: 'aviso:162:1:si', title: 'Confirmar' }, { id: 'aviso:162:1:no', title: 'Cancelar' }] };
const LISTA = { tipo: 'lista', boton: 'Elegir respuesta', filas: [
  { id: 'aviso:162:1', title: 'Sí, aprobar', description: 'Aprobar y pedir el anticipo al huésped' },
  { id: 'aviso:162:2', title: 'No, rechazar', description: 'Rechazar (pasa al Gerente)' },
  { id: 'aviso:162:3', title: 'Lo tomo yo', description: 'Tomo yo la conversación' },
  { id: 'aviso:162:0', title: 'Otra (escribe a Teo)', description: 'No es ninguna' }] };
const silencioso = { info() {}, log() {}, error() {}, warn() {} };

function dispatcherCon(claim, { sendList, sendButtons } = {}) {
  const sent = [], lists = [], buttons = [], completed = [];
  const pms = {
    async closedPilotInbound() { return { outboxes: [{ id: 42 }] }; },
    async claimClosedPilotOutbound() { return { outbox_id: 42, claimable: true, recipient_kind: 'internal', message_text: SOBRE, ...claim }; },
    async completeClosedPilotOutbound(body) { completed.push(body); }
  };
  const d = createM0ClosedPilotDispatcher({ config, pms, logger: silencioso,
    async sendText(phone, text) { sent.push({ phone, text }); return 'wamid.t'; },
    async sendTemplate() { return 'wamid.p'; },
    sendButtons: sendButtons ?? (async (phone, body) => { buttons.push({ phone, ...body }); return 'wamid.b'; }),
    sendList: sendList === undefined ? async (phone, body) => { lists.push({ phone, ...body }); return 'wamid.l'; } : sendList });
  return { d, sent, lists, buttons, completed };
}
const procesar = (d) => d.process({ phone: internal, text: 'hola', messageId: 'wamid.in.1', occurredAt: new Date().toISOString() });

test('el claim declara internal_interactive', async () => {
  const calls = [];
  const client = new PmsPilotClient({ baseUrl: 'https://pms.test', secret: 's',
    http: { async post(url, body, options) { calls.push({ url, body, options }); return { data: { data: { claimable: false } } }; } } });
  await client.claimClosedPilotOutbound(5);
  assert.ok(calls[0].options.headers['X-M0-Accepts'].split(',').map((s) => s.trim()).includes('internal_interactive'));
});

test('lista: sale la pregunta corta con sus filas', async () => {
  const { d, lists, sent, completed } = dispatcherCon({ internal_delivery: 'interactive', internal_text: PREGUNTA,
    internal_interactive: LISTA, internal_fallback_text: RESPALDO });
  await procesar(d);
  assert.equal(sent.length, 0);
  assert.equal(lists.length, 1);
  assert.equal(lists[0].bodyText, PREGUNTA);
  assert.equal(lists[0].buttonText, 'Elegir respuesta');
  assert.deepEqual(lists[0].rows.map((r) => r.id), ['aviso:162:1', 'aviso:162:2', 'aviso:162:3', 'aviso:162:0']);
  assert.equal(completed[0].provider_reference, 'wamid.l');
});

test('botones: el segundo toque sale como Confirmar / Cancelar', async () => {
  const { d, buttons } = dispatcherCon({ internal_delivery: 'interactive', internal_text: '¿Seguro? Aprobar (Ana, LF-210).',
    internal_interactive: BOTONES, internal_fallback_text: RESPALDO });
  await procesar(d);
  assert.deepEqual(buttons[0].buttons, BOTONES.botones);
});

test('Meta rechaza la lista (4xx) o no hay emisor de listas: sale el aviso de siempre', async () => {
  const rechazo = async () => { throw Object.assign(new Error('bad'), { response: { status: 400 } }); };
  for (const sendList of [rechazo, null]) {
    const { d, sent } = dispatcherCon({ internal_delivery: 'interactive', internal_text: PREGUNTA,
      internal_interactive: LISTA, internal_fallback_text: RESPALDO }, { sendList });
    await procesar(d);
    assert.deepEqual(sent, [{ phone: internal, text: RESPALDO }]);
  }
});

test('interactivo invalido (fila de mas de 24 caracteres): sale el respaldo, nunca un envio que Meta rechace', async () => {
  const mala = { ...LISTA, filas: [{ id: 'aviso:1:1', title: 'Un titulo demasiado largo para una fila' }] };
  const { d, sent, lists } = dispatcherCon({ internal_delivery: 'interactive', internal_text: PREGUNTA, internal_interactive: mala,
    internal_fallback_text: RESPALDO });
  await procesar(d);
  assert.equal(lists.length, 0);
  assert.deepEqual(sent, [{ phone: internal, text: RESPALDO }]);
});

test('el toque de un boton o de una fila llega como BOTON AVISO con la decision exacta', () => {
  assert.equal(textForMessage({ type: 'interactive', interactive: { type: 'list_reply', list_reply: { id: 'aviso:162:2', title: 'No, rechazar' } } }),
    'BOTON AVISO 162 2');
  assert.equal(textForMessage({ type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: 'aviso:162:1:si', title: 'Confirmar' } } }),
    'BOTON AVISO 162 1 SI');
  assert.equal(textForMessage({ type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: 'aviso:162:0', title: 'Otra (escribe a Teo)' } } }),
    'BOTON AVISO 162 0');
  // Los demas botones siguen entregando su titulo (huespedes, Leído).
  assert.equal(textForMessage({ type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: 'contacto:1', title: 'Llamarme' } } }), 'Llamarme');
  assert.equal(textForMessage({ type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: 'aviso_leido:42', title: '✅ Leído' } } }), 'LEÍDO 42');
  assert.equal(textForMessage({ type: 'button', button: { text: 'Ver opciones' } }), 'Ver opciones');
});

test('el gerente conversacional no reinterpreta el toque', () => {
  assert.equal(isLiteralCommand('BOTON AVISO 162 1'), true);
  assert.equal(isLiteralCommand('BOTON AVISO 162 1 SI'), true);
  assert.equal(isLiteralCommand('Ver opciones'), true);
});
