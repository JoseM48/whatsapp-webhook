'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createPmsWarmup } = require('../lib/pilot/pms-warmup');
const { PmsPilotClient } = require('../lib/pilot/pms-client');

test('queda apagado por defecto', () => {
  const warmup = createPmsWarmup({ warm: async () => ({ status: 200 }) });
  assert.deepEqual(warmup.trigger(), { started: false, reason: 'disabled' });
});

test('inicia sin bloquear y evita llamadas concurrentes', async () => {
  let release;
  let calls = 0;
  const pending = new Promise((resolve) => { release = resolve; });
  const warmup = createPmsWarmup({
    enabled: true,
    warm: async () => { calls += 1; await pending; return { status: 200 }; },
    log: { info() {}, warn() {} },
  });

  assert.deepEqual(warmup.trigger(), { started: true });
  assert.deepEqual(warmup.trigger(), { started: false, reason: 'in_flight' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  release();
  await pending;
  await new Promise((resolve) => setImmediate(resolve));
});

test('respeta cooldown entre calentamientos', async () => {
  let current = 100_000;
  let calls = 0;
  const warmup = createPmsWarmup({
    enabled: true,
    cooldownMs: 60_000,
    now: () => current,
    warm: async () => { calls += 1; return { status: 200 }; },
    log: { info() {}, warn() {} },
  });

  assert.deepEqual(warmup.trigger(), { started: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(warmup.trigger(), { started: false, reason: 'cooldown' });
  current += 60_000;
  assert.deepEqual(warmup.trigger(), { started: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 2);
});

test('el cliente valida la identidad health de PMS Lite', async () => {
  const calls = [];
  const client = new PmsPilotClient({
    http: {
      get: async (url, options) => {
        calls.push([url, options.timeout]);
        return { status: 200, data: { service: 'pms-lite' } };
      },
    },
    baseUrl: 'https://pms.example.test',
    inboundUrl: 'https://pms.example.test/api/whatsapp/inbound',
    secret: 'synthetic-secret',
  });
  assert.deepEqual(await client.warmup(70_000), { status: 200 });
  assert.deepEqual(calls, [['https://pms.example.test/health', 70_000]]);
});

test('el cliente rechaza un health ajeno', async () => {
  const client = new PmsPilotClient({
    http: { get: async () => ({ status: 200, data: { service: 'other' } }) },
    baseUrl: 'https://pms.example.test',
    inboundUrl: 'https://pms.example.test/api/whatsapp/inbound',
    secret: 'synthetic-secret',
  });
  await assert.rejects(client.warmup(), { code: 'pms_warmup_unhealthy' });
});
