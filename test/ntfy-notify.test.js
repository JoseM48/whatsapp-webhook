'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('notifyOn respeta NTFY_BUSINESS_NOTIFY_ON, insensible a mayusculas/espacios', async () => {
  const originalEnv = process.env.NTFY_BUSINESS_NOTIFY_ON;
  process.env.NTFY_BUSINESS_NOTIFY_ON = ' Lead , reserva ';
  delete require.cache[require.resolve('../lib/pilot/ntfy-notify')];
  const { notifyOn } = require('../lib/pilot/ntfy-notify');
  assert.equal(notifyOn('lead'), true);
  assert.equal(notifyOn('reserva'), true);
  assert.equal(notifyOn('otra_cosa'), false);
  process.env.NTFY_BUSINESS_NOTIFY_ON = originalEnv;
});

test('notifyBusinessEvent no envia nada si falta NTFY_BUSINESS_TOPIC', async () => {
  const originalTopic = process.env.NTFY_BUSINESS_TOPIC;
  const originalNotify = process.env.NTFY_BUSINESS_NOTIFY_ON;
  delete process.env.NTFY_BUSINESS_TOPIC;
  process.env.NTFY_BUSINESS_NOTIFY_ON = 'lead';
  delete require.cache[require.resolve('../lib/pilot/ntfy-notify')];
  const { notifyBusinessEvent } = require('../lib/pilot/ntfy-notify');
  const result = await notifyBusinessEvent('lead', { title: 'x', message: 'y' });
  assert.equal(result.sent, false);
  assert.equal(result.reason, 'not_configured_or_disabled');
  process.env.NTFY_BUSINESS_TOPIC = originalTopic;
  process.env.NTFY_BUSINESS_NOTIFY_ON = originalNotify;
});

test('notifyBusinessEvent no envia nada si el tipo de evento no esta habilitado', async () => {
  const originalTopic = process.env.NTFY_BUSINESS_TOPIC;
  const originalNotify = process.env.NTFY_BUSINESS_NOTIFY_ON;
  process.env.NTFY_BUSINESS_TOPIC = 'test-topic';
  process.env.NTFY_BUSINESS_NOTIFY_ON = 'reserva';
  delete require.cache[require.resolve('../lib/pilot/ntfy-notify')];
  const { notifyBusinessEvent } = require('../lib/pilot/ntfy-notify');
  const result = await notifyBusinessEvent('lead', { title: 'x', message: 'y' });
  assert.equal(result.sent, false);
  assert.equal(result.reason, 'not_configured_or_disabled');
  process.env.NTFY_BUSINESS_TOPIC = originalTopic;
  process.env.NTFY_BUSINESS_NOTIFY_ON = originalNotify;
});
