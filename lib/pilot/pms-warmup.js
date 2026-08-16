'use strict';

function createPmsWarmup({ enabled = false, cooldownMs = 60_000, warm, now = () => Date.now(), log = console }) {
  let lastStartedAt = 0;
  let inFlight = null;

  return {
    trigger() {
      if (!enabled) return { started: false, reason: 'disabled' };
      if (typeof warm !== 'function') return { started: false, reason: 'not_configured' };

      const current = now();
      if (inFlight) return { started: false, reason: 'in_flight' };
      if (lastStartedAt && current - lastStartedAt < cooldownMs) {
        return { started: false, reason: 'cooldown' };
      }

      lastStartedAt = current;
      inFlight = Promise.resolve()
        .then(() => warm())
        .then((result) => log.info('[pms-warmup] ready', { status: result?.status || 200 }))
        .catch((error) => log.warn('[pms-warmup] failed', {
          code: error?.code || 'warmup_failed',
          status: error?.response?.status || null,
        }))
        .finally(() => { inFlight = null; });

      return { started: true };
    },
  };
}

module.exports = { createPmsWarmup };

