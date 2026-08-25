'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createM0CommercialResponder } = require('../lib/pilot/m0-commercial-responder');

const input = {
  from: '573146892662', text: 'Busco alojamiento para dos personas',
  messageId: 'wamid.m0.commercial.001', timestamp: '2026-08-25T15:00:00-05:00', name: 'Lead'
};

function interpretation(extra = {}) {
  return {
    intent: 'lodging_search', language: 'es', check_in: null, check_out: null,
    check_in_status: 'absent', check_out_status: 'absent', check_in_source: 'none', check_out_source: 'none',
    nights: null, guests: 2, requested_apartment_code: null, requested_apartment_code_status: 'absent',
    preferences: [], requirements: [], budget_cop: null, budget_period: 'absent', knowledge_topics: [],
    provided_fields: ['guests'], corrections: [], requests_human: false, uncertainty: 0.4,
    needs_clarification: true, missing_fields: ['check_in', 'check_out_or_nights'], ...extra
  };
}

test('captura durablemente antes de solicitar y entregar el acuse', async () => {
  const order = [];
  let now = 100;
  const responder = createM0CommercialResponder({
    async capture() { order.push('capture'); now += 4; return { captured: true }; },
    ai: { async interpret() { throw new Error('not_expected'); } },
    closedPilot: {
      async beginCommercial() {
        order.push('begin_and_queue_ack'); now += 7;
        return { result: { processing_claimed: true, context: { pending_fields: ['check_in'] }, outboxes: [{ id: 7 }] }, deliveries: [] };
      },
      async deliverCommercialOutboxes(outboxes) { order.push('deliver_ack'); return outboxes; }
    },
    pms: { async processingFailure() {} }, clock: () => now
  });
  const result = await responder.captureAndAcknowledge(input);
  assert.deepEqual(order, ['capture', 'begin_and_queue_ack']);
  assert.equal(result.captured, true);
  assert.equal(result.processing_claimed, true);
  assert.deepEqual(result.timings, { capture_ms: 4, acknowledge_ms: 11 });
  assert.deepEqual(result.acknowledgement_outboxes, [{ id: 7 }]);
  await responder.deliverAcknowledgement(result.acknowledgement_outboxes);
  assert.deepEqual(order, ['capture', 'begin_and_queue_ack', 'deliver_ack']);
});

test('un external_message_id ya reclamado no vuelve a invocar IA', async () => {
  let aiCalls = 0;
  const responder = createM0CommercialResponder({
    async capture() { return { captured: true, deduplicated: true }; },
    ai: { async interpret() { aiCalls += 1; } },
    closedPilot: { async beginCommercial() { return { result: { processing_claimed: false }, deliveries: [] }; } },
    pms: { async processingFailure() {} }
  });
  const begun = await responder.captureAndAcknowledge(input);
  const result = await responder.processCaptured({ ...input, today: '2026-08-25',
    processingClaimed: begun.processing_claimed });
  assert.equal(result.skipped, 'not_claimed');
  assert.equal(aiCalls, 0);
});

test('propaga fallback seguro sin exponer metadatos dentro del contrato PMS', async () => {
  let received;
  const responder = createM0CommercialResponder({
    async capture() { return { captured: true }; },
    ai: { async interpret() { return interpretation({ _fallback: true,
      _error_code: 'ai_interpretation_fallback', _dependency: { code: 'dependency_timeout' } }); } },
    closedPilot: {
      async beginCommercial() { return { result: { processing_claimed: true }, deliveries: [] }; },
      async completeCommercial(payload) { received = payload; return { result: { action: 'CLARIFICAR SOLICITUD' } }; }
    },
    pms: { async processingFailure() {} }
  });
  const result = await responder.processCaptured({ ...input, today: '2026-08-25', processingClaimed: true });
  assert.equal(result.ok, true);
  assert.equal(result.fallback, true);
  assert.equal(received.ai.fallback, true);
  assert.equal(received.ai.dependency_code, 'dependency_timeout');
  assert.equal(Object.hasOwn(received.interpretation, '_fallback'), false);
});

test('un fallo de acuse posterior a la captura no pierde ni rechaza el inbound', async () => {
  const failures = [];
  const responder = createM0CommercialResponder({
    async capture() { return { captured: true, interaction_id: 10 }; },
    ai: { async interpret() {} },
    closedPilot: { async beginCommercial() { throw Object.assign(new Error('pms_down'), { code: 'ETIMEDOUT' }); } },
    pms: { async processingFailure(body) { failures.push(body); } },
    logger: { error() {} }
  });
  const result = await responder.captureAndAcknowledge(input);
  assert.equal(result.captured, true);
  assert.equal(result.processing_claimed, false);
  assert.equal(result.error_code, 'ETIMEDOUT');
  assert.deepEqual(failures, [{ external_message_id: input.messageId, error_code: 'ETIMEDOUT', retryable: true }]);
});

test('un fallo inesperado de decisión queda marcado para recuperación', async () => {
  const failures = [];
  const responder = createM0CommercialResponder({
    async capture() { return { captured: true }; },
    ai: { async interpret() { return interpretation(); } },
    closedPilot: { async completeCommercial() { throw Object.assign(new Error('offline'), { code: 'ECONNRESET' }); } },
    pms: { async processingFailure(body) { failures.push(body); } },
    logger: { error() {} }
  });
  const result = await responder.processCaptured({ ...input, today: '2026-08-25', processingClaimed: true });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'ECONNRESET');
  assert.deepEqual(failures, [{ external_message_id: input.messageId, error_code: 'ECONNRESET', retryable: true }]);
});
