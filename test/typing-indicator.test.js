'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createTypingIndicator } = require('../lib/pilot/typing-indicator');

test('queda apagado por defecto', async () => {
  const indicator = createTypingIndicator({ send: async () => { throw new Error('no_debe_enviar'); } });
  assert.deepEqual(await indicator.show('wamid.synthetic.1'), { sent: false, reason: 'disabled' });
});

test('usa el message id sin almacenar telefono ni texto', async () => {
  const calls = [];
  const indicator = createTypingIndicator({
    enabled: true,
    send: async (payload) => { calls.push(payload); },
  });
  assert.deepEqual(await indicator.show('wamid.synthetic.2'), { sent: true });
  assert.deepEqual(calls, [{
    messaging_product: 'whatsapp',
    status: 'read',
    message_id: 'wamid.synthetic.2',
    typing_indicator: { type: 'text' },
  }]);
});

test('falla contenido sin lanzar ni reintentar', async () => {
  const indicator = createTypingIndicator({
    enabled: true,
    send: async () => { throw Object.assign(new Error('timeout'), { code: 'ECONNABORTED' }); },
    logger: { warn() {} },
  });
  assert.deepEqual(await indicator.show('wamid.synthetic.3'), { sent: false, reason: 'failed' });
});

