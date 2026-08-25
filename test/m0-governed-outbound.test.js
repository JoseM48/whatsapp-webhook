'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { sendGovernedM0 } = require('../lib/pilot/m0-governed-outbound');

function pmsFixture(overrides = {}) {
  const calls = [];
  const pms = {
    async authorizeM0Outbound(body) { calls.push(['authorize', body]); return { outbound_event_id: 7, status: 'authorized', send_allowed: true }; },
    async beginM0Outbound(body) { calls.push(['begin', body]); return { status: 'submission_started', send_allowed: true }; },
    async completeM0Outbound(body) { calls.push(['complete', body]); return { status: 'submitted' }; },
    async markM0OutboundUnknown(body) { calls.push(['unknown', body]); return { status: 'submission_unknown' }; },
    async failM0Outbound(body) { calls.push(['fail', body]); return { status: 'failed' }; },
    ...overrides
  };
  return { pms, calls };
}

test('persiste autorización e inicio antes de una única llamada Meta y luego confirma', async () => {
  const { pms, calls } = pmsFixture();
  let sends = 0;
  const result = await sendGovernedM0({ pms, interactionId: 3, responseKind: 'request_receipt',
    response: 'Respuesta segura', recipient: '573000000111',
    async sendText() { sends += 1; calls.push(['meta']); return 'wamid.provider.001'; } });
  assert.equal(result.status, 'submitted');
  assert.equal(sends, 1);
  assert.deepEqual(calls.map(([name]) => name), ['authorize', 'begin', 'meta', 'complete']);
  assert.match(calls[0][1].response_hash, /^[A-F0-9]{64}$/);
  assert.match(calls[1][1].submission_attempt_hash, /^[A-F0-9]{64}$/);
});

test('una deduplicación presentada nunca vuelve a llamar Meta', async () => {
  const { pms, calls } = pmsFixture({ async authorizeM0Outbound(body) {
    calls.push(['authorize', body]); return { outbound_event_id: 7, status: 'submitted', send_allowed: false };
  } });
  const result = await sendGovernedM0({ pms, interactionId: 3, responseKind: 'request_receipt',
    response: 'Respuesta segura', recipient: '573000000111', async sendText() { throw new Error('must_not_send'); } });
  assert.deepEqual(result, { sent: true, deduplicated: true, status: 'submitted' });
  assert.deepEqual(calls.map(([name]) => name), ['authorize']);
});

test('un timeout queda incierto y nunca completa ni reintenta', async () => {
  const { pms, calls } = pmsFixture();
  const result = await sendGovernedM0({ pms, interactionId: 3, responseKind: 'consent_notice',
    response: 'Aviso', recipient: '573000000111', async sendText() {
      throw Object.assign(new Error('timeout'), { code: 'ECONNABORTED' });
    } });
  assert.equal(result.status, 'submission_unknown');
  assert.deepEqual(calls.map(([name]) => name), ['authorize', 'begin', 'unknown']);
});

test('una respuesta Meta sin id de proveedor queda incierta porque pudo haberse enviado', async () => {
  const { pms, calls } = pmsFixture();
  const result = await sendGovernedM0({ pms, interactionId: 3, responseKind: 'consent_notice',
    response: 'Aviso', recipient: '573000000111', async sendText() { return null; } });
  assert.equal(result.status, 'submission_unknown');
  assert.deepEqual(calls.map(([name]) => name), ['authorize', 'begin', 'unknown']);
});

test('un 5xx de Meta queda incierto porque cruzó la red y pudo haberse enviado', async () => {
  const { pms, calls } = pmsFixture();
  const result = await sendGovernedM0({ pms, interactionId: 3, responseKind: 'consent_notice',
    response: 'Aviso', recipient: '573000000111', async sendText() {
      throw Object.assign(new Error('provider unavailable'), { response: { status: 503 } });
    } });
  assert.equal(result.status, 'submission_unknown');
  assert.deepEqual(calls.map(([name]) => name), ['authorize', 'begin', 'unknown']);
});

test('un rechazo definido queda fallido con código saneado', async () => {
  const { pms, calls } = pmsFixture();
  const result = await sendGovernedM0({ pms, interactionId: 3, responseKind: 'consent_notice',
    response: 'Aviso', recipient: '573000000111', async sendText() {
      throw Object.assign(new Error('rejected'), { response: { data: { error: { code: 'meta-400' } } } });
    } });
  assert.equal(result.status, 'failed');
  assert.deepEqual(calls.map(([name]) => name), ['authorize', 'begin', 'fail']);
  assert.equal(calls[2][1].failure_code, 'META_400');
});
