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
  assert.equal(messages[0].flow, null);
  assert.equal(messages[1].flow, null);
  assert.equal(m0CommercialText(messages[1]), '[M0_UNSUPPORTED_INBOUND:audio]');
});

test('extrae la respuesta de un Flow completado (nfm_reply) sin perder el response_json', () => {
  const payload = { entry: [{ changes: [{ value: {
    contacts: [{ wa_id: '573146892662', profile: { name: 'Lead' } }],
    messages: [
      { id: 'wamid.flow', from: '573146892662', timestamp: '1787688000', type: 'interactive',
        interactive: { type: 'nfm_reply', nfm_reply: {
          name: 'flow', response_json: '{"checkin_date":"2026-10-01","duration":"3m"}'
        } } }
    ]
  } }] }] };
  const messages = extractMetaMessages(payload);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].text, null);
  assert.deepEqual(messages[0].flow, { name: 'flow', responseJson: '{"checkin_date":"2026-10-01","duration":"3m"}' });
  assert.equal(m0CommercialText(messages[0]), '[M0_UNSUPPORTED_INBOUND:interactive]');
});

test('un botón/lista clásico (no Flow) sigue extrayendo el título como texto y flow queda null', () => {
  const payload = { entry: [{ changes: [{ value: {
    contacts: [{ wa_id: '573146892662', profile: { name: 'Lead' } }],
    messages: [
      { id: 'wamid.btn', from: '573146892662', timestamp: '1787688000', type: 'interactive',
        interactive: { type: 'button_reply', button_reply: { title: 'Sí' } } }
    ]
  } }] }] };
  const messages = extractMetaMessages(payload);
  assert.equal(messages[0].text, 'Sí');
  assert.equal(messages[0].flow, null);
});

test('extrae el objeto referral de un mensaje llegado desde un anuncio click-to-WhatsApp', () => {
  const payload = { entry: [{ changes: [{ value: {
    contacts: [{ wa_id: '573146892662', profile: { name: 'Lead' } }],
    messages: [
      { id: 'wamid.ad', from: '573146892662', timestamp: '1787688000', type: 'text', text: { body: 'Hola' },
        referral: { source_type: 'ad', source_id: '12345', source_url: 'https://fb.me/x', headline: 'Apartamentos La Frontera', ctwa_clid: 'abc123' } }
    ]
  } }] }] };
  const messages = extractMetaMessages(payload);
  assert.deepEqual(messages[0].referral, {
    source_type: 'ad', source_id: '12345', source_url: 'https://fb.me/x', headline: 'Apartamentos La Frontera', ctwa_clid: 'abc123'
  });
});

test('un mensaje sin referral (la inmensa mayoria de los casos) deja el campo en null', () => {
  const payload = { entry: [{ changes: [{ value: {
    contacts: [{ wa_id: '573146892662', profile: { name: 'Lead' } }],
    messages: [{ id: 'wamid.organic', from: '573146892662', timestamp: '1787688000', type: 'text', text: { body: 'Hola' } }]
  } }] }] };
  assert.equal(extractMetaMessages(payload)[0].referral, null);
});

test('extrae y quita el codigo [ref:...] del landing antes de que Cami vea el texto', () => {
  const payload = { entry: [{ changes: [{ value: {
    contacts: [{ wa_id: '573146892662', profile: { name: 'Lead' } }],
    messages: [
      { id: 'wamid.landing', from: '573146892662', timestamp: '1787688000', type: 'text',
        text: { body: 'Hola, quiero consultar apartamentos amoblados disponibles en La Frontera, El Poblado. Modalidad de interés: 1 mes. [ref:meta:paid_social:meta_apartamentos_la_frontera]' } }
    ]
  } }] }] };
  const messages = extractMetaMessages(payload);
  assert.equal(messages[0].text, 'Hola, quiero consultar apartamentos amoblados disponibles en La Frontera, El Poblado. Modalidad de interés: 1 mes.');
  assert.deepEqual(messages[0].landingRef, { utm_source: 'meta', utm_medium: 'paid_social', utm_campaign: 'meta_apartamentos_la_frontera' });
});

test('un mensaje normal (sin codigo [ref:...]) deja landingRef en null y el texto intacto', () => {
  const payload = { entry: [{ changes: [{ value: {
    contacts: [{ wa_id: '573146892662', profile: { name: 'Lead' } }],
    messages: [{ id: 'wamid.plain', from: '573146892662', timestamp: '1787688000', type: 'text', text: { body: 'Hola, buenas tardes' } }]
  } }] }] };
  const messages = extractMetaMessages(payload);
  assert.equal(messages[0].text, 'Hola, buenas tardes');
  assert.equal(messages[0].landingRef, null);
});

test('un codigo [ref:...] mal formado (menos de 3 segmentos) se ignora sin tocar el texto', () => {
  const payload = { entry: [{ changes: [{ value: {
    contacts: [{ wa_id: '573146892662', profile: { name: 'Lead' } }],
    messages: [{ id: 'wamid.malformed', from: '573146892662', timestamp: '1787688000', type: 'text', text: { body: 'Hola [ref:meta:paid_social]' } }]
  } }] }] };
  const messages = extractMetaMessages(payload);
  assert.equal(messages[0].text, 'Hola [ref:meta:paid_social]');
  assert.equal(messages[0].landingRef, null);
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
