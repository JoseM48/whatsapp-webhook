'use strict';

function startM0ObservationLoop({ enabled, observe, intervalMs = 60_000, setIntervalFn = setInterval }) {
  if (!enabled) return { started: false, stop() {} };
  if (typeof observe !== 'function' || !Number.isInteger(intervalMs) || intervalMs < 10_000 || intervalMs > 120_000) {
    throw new Error('m0_observation_loop_invalid_config');
  }
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try { await observe('periodic_60s'); } finally { running = false; }
  };
  const timer = setIntervalFn(() => { void tick(); }, intervalMs);
  if (typeof timer?.unref === 'function') timer.unref();
  return { started: true, interval_ms: intervalMs, stop() { if (typeof timer?.close === 'function') timer.close();
    else clearInterval(timer); }, tick };
}

module.exports = { startM0ObservationLoop };
