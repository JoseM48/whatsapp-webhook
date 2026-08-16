'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createWaitAck, WAIT_ACK_TEXT } = require('../lib/pilot/wait-ack');

test('queda apagado por defecto', async () => {
  const ack = createWaitAck({ send: async () => { throw new Error('no_debe_enviar'); } });
  assert.deepEqual(await ack.afterCapture({
    captureResult: { created_interaction: true }, recipient: '573000000000',
  }), { sent: false, reason: 'disabled' });
});

test('envia solo despues de la primera captura durable', async () => {
  const calls = [];
  const ack = createWaitAck({
    enabled: true,
    send: async (recipient, text) => calls.push([recipient, text]),
  });
  assert.deepEqual(await ack.afterCapture({
    captureResult: { created_interaction: true, deduplicated: false }, recipient: '573000000000',
  }), { sent: true });
  assert.deepEqual(calls, [['573000000000', WAIT_ACK_TEXT]]);
});

test('un reintento deduplicado no vuelve a enviar el aviso', async () => {
  const ack = createWaitAck({
    enabled: true,
    send: async () => { throw new Error('no_debe_enviar'); },
  });
  assert.deepEqual(await ack.afterCapture({
    captureResult: { created_interaction: false, deduplicated: true }, recipient: '573000000000',
  }), { sent: false, reason: 'deduplicated_capture' });
});

test('un resultado incierto no se reintenta automaticamente', async () => {
  let calls = 0;
  const ack = createWaitAck({
    enabled: true,
    send: async () => { calls += 1; throw Object.assign(new Error('timeout'), { code: 'ECONNABORTED' }); },
    logger: { warn() {} },
  });
  assert.deepEqual(await ack.afterCapture({
    captureResult: { created_interaction: true }, recipient: '573000000000',
  }), { sent: false, reason: 'failed_without_retry' });
  assert.equal(calls, 1);
});

