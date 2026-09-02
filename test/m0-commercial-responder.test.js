'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createM0CommercialResponder } = require('../lib/pilot/m0-commercial-responder');
const { createPmsWarmup } = require('../lib/pilot/pms-warmup');

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

test('un fallo de acuse posterior a la captura no pierde ni rechaza el inbound (Incremento 062: nunca en silencio)', async () => {
  const failures = [];
  const admissionErrors = [];
  const delivered = [];
  const responder = createM0CommercialResponder({
    async capture() { return { captured: true, interaction_id: 10 }; },
    ai: { async interpret() {} },
    closedPilot: {
      async beginCommercial() { throw Object.assign(new Error('pms_down'), { code: 'ETIMEDOUT' }); },
      async deliverCommercialOutboxes(outboxes) { delivered.push(outboxes); return outboxes.map(() => ({ status: 'submitted' })); }
    },
    pms: {
      async processingFailure(body) { failures.push(body); },
      async recordM0AdmissionError(body) {
        admissionErrors.push(body);
        return { first_occurrence: true, outboxes: [{ id: 1, recipient_kind: 'internal' }, { id: 2, recipient_kind: 'guest' }] };
      }
    },
    logger: { error() {}, info() {} }
  });
  const result = await responder.captureAndAcknowledge(input);
  assert.equal(result.captured, true);
  assert.equal(result.processing_claimed, false);
  assert.equal(result.admission_error_handled, true);
  assert.deepEqual(failures, [{ external_message_id: input.messageId, error_code: 'ETIMEDOUT', retryable: true }]);
  assert.equal(admissionErrors.length, 1);
  assert.equal(admissionErrors[0].external_message_id, input.messageId);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].length, 2);
});

test('Incremento 062: si el registro durable del error de admisión también falla, sí se relanza (5xx real)', async () => {
  const responder = createM0CommercialResponder({
    async capture() { throw Object.assign(new Error('pms_unreachable'), { code: 'ECONNREFUSED' }); },
    ai: { async interpret() { throw new Error('not_expected'); } },
    closedPilot: { async beginCommercial() {}, async deliverCommercialOutboxes() { return []; } },
    pms: {
      async processingFailure() {},
      async recordM0AdmissionError() { throw new Error('pms_totally_down'); }
    },
    logger: { error() {}, info() {} }
  });
  await assert.rejects(() => responder.captureAndAcknowledge(input), /pms_unreachable/);
});

test('Incremento 062: un mismo external_message_id no produce una segunda alerta ni una segunda respuesta', async () => {
  const admissionErrorCalls = [];
  const deliveredBatches = [];
  let firstOccurrence = true;
  const responder = createM0CommercialResponder({
    async capture() { throw Object.assign(new Error('capture_failed'), { code: 'm0_commercial_capture_failed' }); },
    ai: { async interpret() { throw new Error('not_expected'); } },
    closedPilot: {
      async deliverCommercialOutboxes(outboxes) { deliveredBatches.push(outboxes); return outboxes.map(() => ({ status: 'submitted' })); }
    },
    pms: {
      async processingFailure() {},
      async recordM0AdmissionError(body) {
        admissionErrorCalls.push(body);
        const outcome = { first_occurrence: firstOccurrence, outboxes: firstOccurrence ? [{ id: 1 }, { id: 2 }] : [] };
        firstOccurrence = false;
        return outcome;
      }
    },
    logger: { error() {}, info() {} }
  });
  // Simula el mismo evento pasando dos veces por el mismo punto de manejo
  // (equivalente a un reintento real de Meta para el mismo wamid).
  const first = await responder.captureAndAcknowledge(input);
  const second = await responder.captureAndAcknowledge(input);
  assert.equal(first.admission_error_handled, true);
  assert.equal(second.admission_error_handled, true);
  assert.equal(admissionErrorCalls.length, 2);
  // Solo la primera vez (first_occurrence:true) entrega algo -- la
  // segunda vez PMS ya reportó first_occurrence:false, sin outboxes que
  // entregar de nuevo.
  assert.equal(deliveredBatches.length, 1);
  assert.equal(deliveredBatches[0].length, 2);
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

test('la recuperación 429 conserva el wamid y sólo crea un acuse lógico', async () => {
  let captureCalls = 0;
  let beginCalls = 0;
  const capturedIds = [];
  const warmup = createPmsWarmup({
    enabled: true,
    warm: async () => ({ status: 200 }),
    log: { info() {}, warn() {} }
  });
  const responder = createM0CommercialResponder({
    capture: (payload) => warmup.run(async () => {
      captureCalls += 1;
      capturedIds.push(payload.messageId);
      if (captureCalls === 1) throw { response: { status: 429 } };
      return { captured: true, deduplicated: false };
    }),
    ai: { async interpret() { throw new Error('not_expected'); } },
    closedPilot: {
      async beginCommercial() {
        beginCalls += 1;
        return { result: { processing_claimed: true, outboxes: [{ id: 91 }] }, deliveries: [] };
      }
    },
    pms: { async processingFailure() {} }
  });

  const result = await responder.captureAndAcknowledge(input);
  assert.equal(result.captured, true);
  assert.equal(captureCalls, 2);
  assert.deepEqual(capturedIds, [input.messageId, input.messageId]);
  assert.equal(beginCalls, 1);
  assert.deepEqual(result.acknowledgement_outboxes, [{ id: 91 }]);
});
