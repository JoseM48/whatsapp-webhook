'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PilotOrchestrator } = require('../lib/pilot/orchestrator');

function fixture() {
  const calls = [];
  const pms = {
    capture: async (body) => { calls.push(['capture', body]); return { created_interaction: true }; },
    decide: async () => ({
      action: 'present', language: 'es', context_hash: 'a'.repeat(64),
      alternatives: [{ item_id: '1', public_title: 'Estudio', summary: 'Resumen', cover_media: { id: '10' } }]
    }),
    verify: async () => ({ outbox_id: '20' }),
    claim: async () => ({ claimed: true, payload: { text: 'Respuesta segura', media_ids: ['10'] } }),
    mediaUrl: (id) => `https://private.example/media/${id}`,
    status: async (body) => { calls.push(['status', body]); },
    processingFailure: async (body) => { calls.push(['failure', body]); }
  };
  const ai = {
    interpret: async () => ({ intent: 'lodging_search', language: 'es', guests: 2, check_in: '2026-08-01', nights: 4 }),
    present: async () => ({ text: 'Respuesta segura', selected_item_ids: ['1'], selected_media_ids: ['10'] })
  };
  const orchestrator = new PilotOrchestrator({
    pms, ai,
    brainSync: async (body) => { calls.push(['brain', body]); },
    sendImage: async (to, url) => { calls.push(['image', { to, url }]); },
    sendText: async (to, text) => { calls.push(['text', { to, text }]); return 'wamid.outbound.test'; },
    logger: { info() {}, warn() {}, error() {} }
  });
  return { orchestrator, calls, pms };
}

test('captura durable ocurre antes del procesamiento', async () => {
  const { orchestrator, calls } = fixture();
  await orchestrator.capture({
    from: '573000000001', text: 'Consulta ficticia', messageId: 'wamid.inbound.test',
    timestamp: '2026-07-22T15:00:00.000Z', name: 'Lead test'
  });
  assert.equal(calls[0][0], 'capture');
  assert.equal(calls[0][1].external_message_id, 'wamid.inbound.test');
});

test('recorrido integrado verifica, reclama y registra envío', async () => {
  const { orchestrator, calls } = fixture();
  const result = await orchestrator.processCaptured({
    from: '573000000001', text: 'Consulta ficticia', messageId: 'wamid.inbound.test', today: '2026-07-22'
  });
  assert.equal(result.ok, true);
  assert.equal(calls.some(([type]) => type === 'brain'), true);
  assert.equal(calls.some(([type]) => type === 'image'), true);
  assert.equal(calls.some(([type]) => type === 'text'), true);
  const status = calls.find(([type]) => type === 'status')[1];
  assert.equal(status.status, 'sent');
  assert.equal(status.meta_message_id, 'wamid.outbound.test');
});

test('claim rechazado evita un outbound duplicado', async () => {
  const { orchestrator, calls, pms } = fixture();
  pms.claim = async () => ({ claimed: false });
  const result = await orchestrator.deliverClaimed({ outboxId: '20', recipient: '573000000001' });
  assert.equal(result.skipped, 'already_claimed');
  assert.equal(calls.some(([type]) => type === 'text'), false);
});

test('fallo después de persistir queda marcado para reproceso', async () => {
  const { orchestrator, calls, pms } = fixture();
  pms.decide = async () => { throw Object.assign(new Error('unavailable'), { code: 'ECONNREFUSED' }); };
  const result = await orchestrator.processCaptured({
    from: '573000000001', text: 'Consulta ficticia', messageId: 'wamid.inbound.test', today: '2026-07-22'
  });
  assert.equal(result.ok, false);
  const failure = calls.find(([type]) => type === 'failure')[1];
  assert.equal(failure.retryable, true);
});

test('entrega visual parcial no se reintenta automáticamente', async () => {
  const { orchestrator, calls } = fixture();
  let images = 0;
  orchestrator.sendImage = async () => {
    images += 1;
    if (images === 2) throw Object.assign(new Error('upstream'), { response: { status: 500 } });
  };
  orchestrator.pms.claim = async () => ({ claimed: true, payload: { text: 'Respuesta', media_ids: ['10', '11'] } });
  const result = await orchestrator.deliverClaimed({ outboxId: '20', recipient: '573000000001' });
  assert.equal(result.ok, false);
  const status = calls.find(([type]) => type === 'status')[1];
  assert.equal(status.status, 'failed');
  assert.equal(status.error_code, 'partial_delivery_unknown');
});
