'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { extractMetaMessages, extractMetaStatuses, m0CommercialText } = require('../lib/pilot/meta-inbound');

test('extrae todos los mensajes de un lote Meta sin perder ids ni remitentes', () => {
  const payload = { entry: [{ changes: [{ value: {
    contacts: [{ wa_id: '573146892662', profile: { name: 'Lead' } }],
    messages: [
      { id: 'wamid.1', from: '573146892662', timestamp: '1787688000', type: 'text', text: { body: 'Hola' } },
      { id: 'wamid.2', from: '573146892662', timestamp: '1787688001', type: 'audio', audio: { id: 'media.1' } }
    ]
  } }] }] };
  const messages = extractMetaMessages(payload);
  assert.equal(messages.length, 2);
  assert.deepEqual(messages.map((item) => item.messageId), ['wamid.1', 'wamid.2']);
  assert.equal(messages[0].text, 'Hola');
  assert.equal(messages[0].name, 'Lead');
  assert.equal(messages[1].text, null);
  assert.deepEqual(messages[1].audio, { id: 'media.1', mimeType: null });
  assert.equal(messages[0].audio, null);
  assert.equal(m0CommercialText(messages[1]), '[M0_UNSUPPORTED_INBOUND:audio]');
});

test('ignora estados Meta sin messages porque no son inbound de un lead', () => {
  const payload = { entry: [{ changes: [{ value: { statuses: [{ id: 'wamid.sent', status: 'sent' }] } }] }] };
  assert.deepEqual(extractMetaMessages(payload), []);
});

test('extrae recibos Meta sin PII adicional y conserva el código seguro de fallo', () => {
  const payload = { entry: [{ changes: [{ value: { statuses: [
    { id: 'wamid.delivery.1', recipient_id: '573006774425', status: 'failed', timestamp: '1787688002',
      errors: [{ code: 131047, title: 'not persisted' }] },
    { id: 'wamid.delivery.2', recipient_id: '573146892662', status: 'delivered', timestamp: '1787688003' }
  ] } }] }] };
  assert.deepEqual(extractMetaStatuses(payload), [
    { providerReference: 'wamid.delivery.1', recipientId: '573006774425', status: 'failed',
      timestamp: new Date(1787688002 * 1000).toISOString(), errorCode: '131047' },
    { providerReference: 'wamid.delivery.2', recipientId: '573146892662', status: 'delivered',
      timestamp: new Date(1787688003 * 1000).toISOString(), errorCode: null }
  ]);
});
