'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createPmsWarmup, isRetryablePmsStartupError } = require('../lib/pilot/pms-warmup');
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

test('clasifica sólo fallos transitorios de arranque como recuperables', () => {
  assert.equal(isRetryablePmsStartupError({ response: { status: 429 } }), true);
  assert.equal(isRetryablePmsStartupError({ response: { status: 503 } }), true);
  assert.equal(isRetryablePmsStartupError({ code: 'ETIMEDOUT' }), true);
  assert.equal(isRetryablePmsStartupError({ response: { status: 401 } }), false);
  assert.equal(isRetryablePmsStartupError({ response: { status: 400 } }), false);
});

test('espera el arranque frío, comparte la espera y reintenta una sola vez la misma operación', async () => {
  let current = 1_000;
  let warmCalls = 0;
  let operationCalls = 0;
  const externalIds = [];
  const warmup = createPmsWarmup({
    enabled: true,
    maxWaitMs: 85_000,
    retryDelayMs: 5_000,
    requestTimeoutMs: 15_000,
    now: () => current,
    sleep: async (delayMs) => { current += delayMs; },
    warm: async () => {
      warmCalls += 1;
      if (warmCalls < 3) throw { response: { status: 429 } };
      return { status: 200 };
    },
    log: { info() {}, warn() {} }
  });

  const operation = async () => {
    operationCalls += 1;
    externalIds.push('wamid.cold-start.001');
    if (operationCalls === 1) throw { response: { status: 429 } };
    return { captured: true, external_message_id: externalIds.at(-1) };
  };

  const result = await warmup.run(operation);
  assert.deepEqual(result, { captured: true, external_message_id: 'wamid.cold-start.001' });
  assert.equal(warmCalls, 3);
  assert.equal(operationCalls, 2);
  assert.deepEqual(externalIds, ['wamid.cold-start.001', 'wamid.cold-start.001']);
});

test('dos solicitudes concurrentes comparten un único calentamiento', async () => {
  let release;
  let warmCalls = 0;
  const pending = new Promise((resolve) => { release = resolve; });
  const warmup = createPmsWarmup({
    enabled: true,
    warm: async () => { warmCalls += 1; await pending; return { status: 200 }; },
    log: { info() {}, warn() {} }
  });

  const first = warmup.waitUntilReady({ force: true });
  const second = warmup.waitUntilReady({ force: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(warmCalls, 1);
  release();
  await Promise.all([first, second]);
});

test('no reintenta una operación rechazada por autenticación', async () => {
  let operationCalls = 0;
  let warmCalls = 0;
  const warmup = createPmsWarmup({
    enabled: true,
    warm: async () => { warmCalls += 1; return { status: 200 }; },
    log: { info() {}, warn() {} }
  });
  await assert.rejects(warmup.run(async () => {
    operationCalls += 1;
    throw { response: { status: 401 } };
  }), (error) => error.response.status === 401);
  assert.equal(operationCalls, 1);
  assert.equal(warmCalls, 0);
});

test('si PMS no despierta, no repite la captura ni oculta el fallo', async () => {
  let current = 10_000;
  let operationCalls = 0;
  let warmCalls = 0;
  const warmup = createPmsWarmup({
    enabled: true,
    maxWaitMs: 5_000,
    retryDelayMs: 5_000,
    now: () => current,
    sleep: async (delayMs) => { current += delayMs; },
    warm: async () => { warmCalls += 1; throw { response: { status: 429 } }; },
    log: { info() {}, warn() {} }
  });
  await assert.rejects(warmup.run(async () => {
    operationCalls += 1;
    throw { response: { status: 429 } };
  }), (error) => error.response.status === 429);
  assert.equal(operationCalls, 1);
  assert.equal(warmCalls, 1);
});
