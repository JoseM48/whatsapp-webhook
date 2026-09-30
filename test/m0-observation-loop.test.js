'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startM0ObservationLoop } = require('../lib/pilot/m0-observation-loop');

test('programa observación cada 60 segundos y deja el timer sin retener el proceso', async () => {
  let callback; let scheduledMs; let unref = 0; const reasons = [];
  const loop = startM0ObservationLoop({ enabled: true, observe: async (reason) => { reasons.push(reason); },
    setIntervalFn(fn, ms) { callback = fn; scheduledMs = ms; return { unref() { unref += 1; }, close() {} }; } });
  assert.equal(loop.started, true);
  assert.equal(scheduledMs, 60_000);
  assert.equal(unref, 1);
  callback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(reasons, ['periodic_60s']);
});

// Regresion del incidente 2026-09-27 (PMS suspendido -> 503 -> webhook caido
// en bucle). El rechazo de observe() no debe escapar como unhandledRejection.
test('un 503 del PMS no escapa del loop: se registra y el siguiente tick vuelve a correr', async () => {
  let callback; let calls = 0; const logs = [];
  const unhandled = [];
  const onUnhandled = (reason) => { unhandled.push(reason); };
  process.on('unhandledRejection', onUnhandled);
  try {
    const err503 = Object.assign(new Error('Request failed with status code 503'),
      { code: 'ERR_BAD_RESPONSE', response: { status: 503 } });
    const loop = startM0ObservationLoop({ enabled: true, name: 'internal_outbox_poll',
      observe: async () => { calls += 1; if (calls <= 2) throw err503; },
      logger: { error: (msg, meta) => logs.push({ msg, meta }) },
      setIntervalFn(fn) { callback = fn; return { unref() {}, close() {} }; } });
    callback(); await new Promise((r) => setImmediate(r));
    callback(); await new Promise((r) => setImmediate(r));
    assert.equal(loop.failures(), 2);
    callback(); await new Promise((r) => setImmediate(r));
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(calls, 3);
    assert.equal(loop.failures(), 0);
    assert.equal(unhandled.length, 0);
    assert.deepEqual(logs.map((l) => [l.msg, l.meta.status, l.meta.code, l.meta.consecutive_failures, l.meta.loop]), [
      ['[m0-loop] observe_failed', 503, 'ERR_BAD_RESPONSE', 1, 'internal_outbox_poll'],
      ['[m0-loop] observe_failed', 503, 'ERR_BAD_RESPONSE', 2, 'internal_outbox_poll']
    ]);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('un timeout sin response tambien queda contenido', async () => {
  const logs = [];
  const loop = startM0ObservationLoop({ enabled: true,
    observe: async () => { throw Object.assign(new Error('timeout'), { code: 'ECONNABORTED' }); },
    logger: { error: (msg, meta) => logs.push(meta) },
    setIntervalFn() { return { unref() {}, close() {} }; } });
  await loop.tick();
  assert.equal(logs[0].status, null);
  assert.equal(logs[0].code, 'ECONNABORTED');
});

test('rechaza intervalos que no pueden garantizar el límite de dos minutos', () => {
  assert.throws(() => startM0ObservationLoop({ enabled: true, observe() {}, intervalMs: 120_001 }),
    /m0_observation_loop_invalid_config/);
});

test('evita observaciones concurrentes cuando una consulta sigue activa', async () => {
  let release; let calls = 0;
  const loop = startM0ObservationLoop({ enabled: true, observe: () => { calls += 1;
    return new Promise((resolve) => { release = resolve; }); }, setIntervalFn() { return { unref() {}, close() {} }; } });
  const first = loop.tick();
  await loop.tick();
  assert.equal(calls, 1);
  release(); await first;
});
