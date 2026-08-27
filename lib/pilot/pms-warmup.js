'use strict';

const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
const RETRYABLE_CODE = new Set(['ECONNABORTED', 'ECONNRESET', 'ETIMEDOUT']);

function isRetryablePmsStartupError(error) {
  return RETRYABLE_STATUS.has(error?.response?.status) || RETRYABLE_CODE.has(error?.code);
}

function defaultSleep(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function createPmsWarmup({
  enabled = false,
  cooldownMs = 60_000,
  readyTtlMs = 0,
  maxWaitMs = 85_000,
  retryDelayMs = 5_000,
  requestTimeoutMs = 15_000,
  warm,
  now = () => Date.now(),
  sleep = defaultSleep,
  log = console
}) {
  let lastStartedAt = 0;
  let lastReadyAt = 0;
  let inFlight = null;

  function recentlyReady(current = now()) {
    return readyTtlMs > 0 && lastReadyAt > 0 && current - lastReadyAt < readyTtlMs;
  }

  async function warmUntilReady() {
    const deadline = now() + maxWaitMs;
    let attempts = 0;
    while (true) {
      attempts += 1;
      try {
        const remainingMs = Math.max(1, deadline - now());
        const result = await warm(Math.min(requestTimeoutMs, remainingMs));
        lastReadyAt = now();
        log.info('[pms-warmup] ready', { status: result?.status || 200, attempts });
        return result;
      } catch (error) {
        const remainingMs = deadline - now();
        if (!isRetryablePmsStartupError(error) || remainingMs <= 0) throw error;
        log.warn('[pms-warmup] retrying', {
          code: error?.code || 'warmup_retryable',
          status: error?.response?.status || null,
          attempt: attempts
        });
        await sleep(Math.min(retryDelayMs, remainingMs));
        if (now() >= deadline) throw error;
      }
    }
  }

  function start({ force = false } = {}) {
    if (!enabled) return { started: false, reason: 'disabled', promise: null };
    if (typeof warm !== 'function') return { started: false, reason: 'not_configured', promise: null };

    const current = now();
    if (recentlyReady(current)) {
      return { started: false, reason: 'ready', promise: Promise.resolve({ status: 200 }) };
    }
    if (inFlight) return { started: false, reason: 'in_flight', promise: inFlight };
    if (!force && lastStartedAt && current - lastStartedAt < cooldownMs) {
      return { started: false, reason: 'cooldown', promise: null };
    }

    lastStartedAt = current;
    const pending = Promise.resolve().then(warmUntilReady);
    const tracked = pending.finally(() => {
      if (inFlight === tracked) inFlight = null;
    });
    inFlight = tracked;
    return { started: true, promise: inFlight };
  }

  function trigger() {
    const state = start();
    if (state.started) {
      state.promise.catch((error) => log.warn('[pms-warmup] failed', {
        code: error?.code || 'warmup_failed',
        status: error?.response?.status || null
      }));
    }
    return { started: state.started, ...(state.reason ? { reason: state.reason } : {}) };
  }

  async function waitUntilReady({ force = false } = {}) {
    const state = start({ force });
    if (state.promise) return state.promise;
    if (state.reason === 'disabled') return { skipped: true, reason: 'disabled' };
    if (state.reason === 'not_configured') {
      throw Object.assign(new Error('pms_warmup_not_configured'), { code: 'pms_warmup_not_configured' });
    }
    if (state.reason === 'cooldown') return { skipped: true, reason: 'cooldown' };
    return { status: 200 };
  }

  async function run(operation) {
    try {
      return await operation();
    } catch (error) {
      if (!enabled || !isRetryablePmsStartupError(error)) throw error;
      await waitUntilReady({ force: true });
      return operation();
    }
  }

  return { trigger, waitUntilReady, run };
}

module.exports = { createPmsWarmup, isRetryablePmsStartupError };

