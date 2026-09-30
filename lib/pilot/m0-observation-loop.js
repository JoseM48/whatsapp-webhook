'use strict';

// Incidente 2026-09-27: con el PMS suspendido, observe() rechazo con un 503
// y, sin catch, la promesa de `void tick()` quedo sin manejar: Node termina el
// proceso ante un unhandledRejection, asi que el webhook cayo en bucle cada
// minuto y Meta reentrego mensajes de huespedes hasta 28 h tarde. Un fallo de
// observacion se registra y el loop sigue: nunca debe tumbar la recepcion.
function startM0ObservationLoop({ enabled, observe, intervalMs = 60_000, setIntervalFn = setInterval, logger = console, name = 'm0' }) {
  if (!enabled) return { started: false, stop() {} };
  if (typeof observe !== 'function' || !Number.isInteger(intervalMs) || intervalMs < 10_000 || intervalMs > 120_000) {
    throw new Error('m0_observation_loop_invalid_config');
  }
  let running = false;
  let consecutiveFailures = 0;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await observe('periodic_60s');
      consecutiveFailures = 0;
    } catch (error) {
      consecutiveFailures += 1;
      logger.error('[m0-loop] observe_failed', {
        loop: name,
        status: error?.response?.status ?? null,
        code: error?.code || error?.message || 'unknown',
        consecutive_failures: consecutiveFailures
      });
    } finally { running = false; }
  };
  const timer = setIntervalFn(() => { void tick(); }, intervalMs);
  if (typeof timer?.unref === 'function') timer.unref();
  return { started: true, interval_ms: intervalMs, stop() { if (typeof timer?.close === 'function') timer.close();
    else clearInterval(timer); }, tick, failures: () => consecutiveFailures };
}

module.exports = { startM0ObservationLoop };
