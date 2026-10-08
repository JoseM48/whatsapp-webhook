'use strict';

// Lead 119 (2026-10-07): el mensaje del anuncio y "Buen día" 10 s despues. Un
// saludo suelto no deja superada la respuesta al mensaje anterior (la que trae
// el saludo aprobado y la pregunta); el PMS no le responde al saludo mientras
// esa respuesta este en camino.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createM0CommercialResponder, esSoloSaludo } = require('../lib/pilot/m0-commercial-responder');
const { createM0ClosedPilotDispatcher } = require('../lib/pilot/m0-closed-pilot');

const silencio = { info() {}, warn() {}, error() {} };
const guest = '573146892662', internal = '573006774425';
const config = { enabled: true, guestPhone: guest, internalPhone: internal, metaSignatureRequired: true,
  pmsM0Enabled: true, controlledIngressEnabled: true, pmsConfigured: true, receiptsEnabled: true,
  internalTemplateName: 'm0_internal_escalation_v1', internalTemplateLanguage: 'es_CO' };

test('esSoloSaludo: solo saludos, nada con contenido', () => {
  for (const t of ['Buen día', '¡Hola! ¿Cómo estás?', 'Buenas tardes Cami', 'Hola 👋', 'buenas noches']) assert.equal(esSoloSaludo(t), true, t);
  for (const t of ['Hola, quiero consultar apartamentos disponibles para mis fechas.', 'buen dia, 15 de octubre',
    'Hola, ¿tienen parqueadero?', 'Para 2 personas', '']) assert.equal(esSoloSaludo(t), false, t);
});

test('el responder no marca un saludo suelto como mensaje con texto', async () => {
  const llamadas = [];
  const responder = createM0CommercialResponder({
    async capture() { return { captured: true }; },
    ai: { async interpret() { throw new Error('not_expected'); } },
    closedPilot: { async beginCommercial(args) { llamadas.push(args.conTexto); return { result: { processing_claimed: true, outboxes: [] } }; } },
    pms: { async processingFailure() {} }
  });
  await responder.captureAndAcknowledge({ from: guest, text: 'Buen día', messageId: 'wamid.a', timestamp: '2026-10-07T17:45:52Z' });
  await responder.captureAndAcknowledge({ from: guest, text: 'Para 2 personas', messageId: 'wamid.b', timestamp: '2026-10-07T17:46:00Z' });
  assert.deepEqual(llamadas, [false, true]);
});

test('la aclaracion del mensaje del anuncio sale aunque despues llegue un "Buen día"', async () => {
  const enviados = [], completados = [];
  const packet = { packet_version: 2, action: 'CLARIFICAR SOLICITUD',
    deterministic_text: '¡Hola! Soy Cami de Mío La Frontera. ¿Qué fechas necesitas y para cuántas personas?',
    accepts: { writer_provenance: true, superseded: true },
    numbers: [], dates: [], apartments: [], required_facts: [], facts: [], forbidden_claims: [], semantic_claims: [] };
  const pms = {
    async beginClosedPilotCommercial() { return { processing_claimed: true, outboxes: [] }; },
    async processClosedPilotCommercial() { return { outboxes: [{ id: 91 }], authorized_response_packet: packet }; },
    async claimClosedPilotOutbound() { return { outbox_id: 91, claimable: true, recipient_kind: 'guest', recipient_phone: guest,
      message_kind: 'text', message_text: packet.deterministic_text }; },
    async completeClosedPilotOutbound(body) { completados.push(body); }
  };
  const dispatcher = createM0ClosedPilotDispatcher({ config, pms, logger: silencio,
    async sendText(to, text) { enviados.push(text); return 'wamid.out'; } });
  await dispatcher.beginCommercial({ phone: guest, messageId: 'wamid.ad', occurredAt: '2026-10-07T17:45:42.000Z', deliver: false });
  await dispatcher.beginCommercial({ phone: guest, messageId: 'wamid.hola', occurredAt: '2026-10-07T17:45:52.000Z', deliver: false,
    conTexto: !esSoloSaludo('Buen día') });
  await dispatcher.completeCommercial({ externalMessageId: 'wamid.ad', interpretation: {}, ai: {} });
  assert.deepEqual(enviados, [packet.deterministic_text]);
  assert.equal(completados[0].status, 'submitted');
});

test('el redactor no vuelve a saludar y pide los datos en estilo corto', () => {
  const { WRITER_SYSTEM_PROMPT } = require('../lib/pilot/llm/writer.js');
  assert.match(WRITER_SYSTEM_PROMPT, /never greet a second time/);
  assert.match(WRITER_SYSTEM_PROMPT, /never as a long questionnaire/);
});
