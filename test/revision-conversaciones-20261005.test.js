'use strict';

// Revision de conversaciones reales del 2026-10-05
// (docs/08_AUDITORIAS/REVISION_CONVERSACIONES_20261005.md): V1 (fechas
// opcionales para el redactor), V4 (negrita de WhatsApp) y V5 (mensaje `order`).

const test = require('node:test');
const assert = require('node:assert/strict');
const { negritaWhatsApp } = require('../lib/pilot/whatsapp-format');
const { createM0ClosedPilotDispatcher } = require('../lib/pilot/m0-closed-pilot');
const { extractMetaMessages, m0CommercialText, TEXTO_PEDIDO_CATALOGO } = require('../lib/pilot/meta-inbound');
const { writerViewOfPacket, WRITER_SYSTEM_PROMPT } = require('../lib/pilot/llm/writer');

const guest = '573146892662', internal = '573006774425';
const config = { enabled: true, guestPhone: guest, internalPhone: internal, metaSignatureRequired: true,
  pmsM0Enabled: true, controlledIngressEnabled: true, pmsConfigured: true, receiptsEnabled: true,
  internalTemplateName: 'm0_internal_escalation_v1', internalTemplateLanguage: 'es_CO' };

test('V4: **x** pasa a *x*; lo demas queda igual', () => {
  assert.equal(negritaWhatsApp('Total: **COP 3.197.000** al mes'), 'Total: *COP 3.197.000* al mes');
  assert.equal(negritaWhatsApp('**LF-210** y **LF-1208**'), '*LF-210* y *LF-1208*');
  assert.equal(negritaWhatsApp('Ya *correcto* y un * suelto'), 'Ya *correcto* y un * suelto');
  assert.equal(negritaWhatsApp('**sin cerrar'), '**sin cerrar');
  assert.equal(negritaWhatsApp(''), '');
  assert.equal(negritaWhatsApp(null), null);
});

test('V4: el texto al huesped sale con negrita de WhatsApp y queda asi en sent_text', async () => {
  const sent = [], completes = [];
  const pms = {
    async closedPilotInbound() { return { outboxes: [{ id: 70 }] }; },
    async claimClosedPilotOutbound() { return { outbox_id: 70, claimable: true, recipient_kind: 'guest', recipient_phone: guest,
      message_kind: 'text', message_text: 'El equivalente mensual es **COP 3.197.000**.' }; },
    async completeClosedPilotOutbound(body) { completes.push(body); }
  };
  const dispatcher = createM0ClosedPilotDispatcher({ config, pms,
    async sendText(phone, text) { sent.push(text); return 'wamid.text'; } });
  await dispatcher.process({ phone: guest, text: 'x', messageId: 'wamid.md', occurredAt: new Date().toISOString() });
  assert.deepEqual(sent, ['El equivalente mensual es *COP 3.197.000*.']);
  assert.equal(completes[0].sent_text, 'El equivalente mensual es *COP 3.197.000*.');
});

test('V5: un mensaje `order` del catalogo se convierte en una solicitud de informacion, no en tipo no soportado', () => {
  const payload = { entry: [{ changes: [{ value: {
    contacts: [{ wa_id: guest, profile: { name: 'Lead' } }],
    messages: [
      { id: 'wamid.o1', from: guest, timestamp: '1787688000', type: 'order',
        order: { catalog_id: '123', product_items: [{ product_retailer_id: 'x', quantity: 1 }] } },
      { id: 'wamid.o2', from: guest, timestamp: '1787688001', type: 'order',
        order: { catalog_id: '123', text: 'Para 2 personas en noviembre', product_items: [] } }
    ]
  } }] }] };
  const [sinNota, conNota] = extractMetaMessages(payload);
  assert.equal(sinNota.messageType, 'order');
  assert.equal(m0CommercialText(sinNota), TEXTO_PEDIDO_CATALOGO);
  assert.doesNotMatch(m0CommercialText(sinNota), /M0_UNSUPPORTED_INBOUND/);
  assert.equal(m0CommercialText(conNota), `${TEXTO_PEDIDO_CATALOGO} Para 2 personas en noviembre`);
});

test('V1: el redactor ve las fechas required:false como opcionales y el prompt lo explica', () => {
  const vista = writerViewOfPacket({ packet_version: 2, dates: [
    { id: 'check_in', formatted: '2026-10-20', required: false }, { id: 'check_out', formatted: '2026-12-20' }] });
  assert.deepEqual(vista.dates, [{ label: 'check_in', value: '2026-10-20', optional: true }, { label: 'check_out', value: '2026-12-20' }]);
  assert.match(WRITER_SYSTEM_PROMPT, /except dates marked "optional"/);
});
