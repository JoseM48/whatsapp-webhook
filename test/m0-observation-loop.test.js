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
