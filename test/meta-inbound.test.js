'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { extractMetaMessages, m0CommercialText } = require('../lib/pilot/meta-inbound');

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
  assert.equal(m0CommercialText(messages[1]), '[M0_UNSUPPORTED_INBOUND:audio]');
});

test('ignora estados Meta sin messages porque no son inbound de un lead', () => {
  const payload = { entry: [{ changes: [{ value: { statuses: [{ id: 'wamid.sent', status: 'sent' }] } }] }] };
  assert.deepEqual(extractMetaMessages(payload), []);
});
