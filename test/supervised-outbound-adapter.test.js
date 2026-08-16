'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  SupervisedOutboundAdapter,
  destinationReferenceHash,
  renderSessionBody
} = require('../lib/pilot/supervised-outbound-adapter');

function fixture({ mode = 'template', hash, templateKey = 'operations_calendar_update' } = {}) {
  const calls = [];
  const authorization = {
    delivery_id: 31,
    destination_reference_hash: hash || destinationReferenceHash('573000000001'),
    delivery_mode: mode,
    template_key: templateKey,
    template_parameters: ['12', 'LF-210', 'extensión confirmada', '25/08/2026', '29/08/2026', 'reprogramado'],
    submission_attempt_hash: 'A'.repeat(64)
  };
  const pms = {
    async beginSupervisedSubmission(id) { calls.push(['begin', id]); return authorization; },
    async completeSupervisedSubmission(id, body) { calls.push(['complete', id, body]); return { status: 'submitted' }; },
    async markSupervisedSubmissionUnknown(id, attempt) { calls.push(['unknown', id, attempt]); return { status: 'submission_unknown' }; }
    ,async recordSupervisedDeliveryStatus(body) { calls.push(['failed', body]); return { status: 'failed' }; }
  };
  const adapter = new SupervisedOutboundAdapter({
    pms,
    sendTemplate: async (...args) => { calls.push(['template', ...args]); return 'wamid.synthetic.001'; },
    sendSessionText: async (...args) => { calls.push(['session', ...args]); return 'wamid.synthetic.002'; },
    logger: { error() {} }
  });
  return { adapter, calls, claim: {
    delivery_id: 31,
    destination_reference_hash: authorization.destination_reference_hash,
    delivery_mode: authorization.delivery_mode,
    template_key: authorization.template_key
  } };
}

test('autoriza durablemente antes de una única llamada Meta y luego confirma', async () => {
  const { adapter, calls, claim } = fixture();
  assert.deepEqual(await adapter.deliver({ claim, recipient: '+57 300 000 0001' }), { status: 'submitted' });
  assert.deepEqual(calls.map((item) => item[0]), ['begin', 'template', 'complete']);
  assert.equal(calls[1][2], 'lf_calendario_operaciones_v1');
  assert.match(calls[2][2].provider_reference_hash, /^[A-F0-9]{64}$/);
});

test('un timeout de Meta queda incierto y no realiza un segundo envío', async () => {
  const { adapter, calls, claim } = fixture();
  adapter.sendTemplate = async () => { calls.push(['template']); throw Object.assign(new Error('timeout'), { code: 'ECONNABORTED' }); };
  await assert.rejects(adapter.deliver({ claim, recipient: '573000000001' }), /supervised_submission_result_unknown/);
  assert.deepEqual(calls.map((item) => item[0]), ['begin', 'template', 'unknown']);
});

test('un destino distinto se bloquea antes de Meta y queda para reconciliación', async () => {
  const { adapter, calls, claim } = fixture();
  await assert.rejects(adapter.deliver({ claim, recipient: '573001112233' }), /supervised_destination_mismatch/);
  assert.deepEqual(calls.map((item) => item[0]), ['failed']);
});

test('modo sesión renderiza únicamente la plantilla gobernada', async () => {
  const { adapter, calls, claim } = fixture({ mode: 'session' });
  await adapter.deliver({ claim, recipient: '573000000001' });
  assert.deepEqual(calls.map((item) => item[0]), ['begin', 'session', 'complete']);
  assert.match(calls[1][2], /LF-210/);
  assert.equal(renderSessionBody('Hola {{1}}', ['José']), 'Hola José');
});

test('soporte al propietario no sale sin cabecera documental segura', async () => {
  const { adapter, calls, claim } = fixture({ templateKey: 'payment_evidence_owner_reconciliation' });
  claim.payload = { template_parameters: ['PR-1', 'LF-210', '500.000'] };
  await assert.rejects(adapter.deliver({ claim, recipient: '573000000001' }), /supervised_document_header_not_available/);
  assert.deepEqual(calls.map((item) => item[0]), ['failed']);
});

test('soporte cifrado sólo se entrega con referencia autorizada al iniciar', async () => {
  const { adapter, calls, claim } = fixture({ templateKey: 'payment_evidence_owner_reconciliation' });
  claim.payload = { support_asset_id: 7, template_parameters: ['PR-1', 'LF-210', '500.000'] };
  adapter.pms.beginSupervisedSubmission = async (id) => {
    calls.push(['begin', id]);
    return {
      delivery_id: id,
      destination_reference_hash: claim.destination_reference_hash,
      delivery_mode: 'template',
      template_key: claim.template_key,
      template_parameters: claim.payload.template_parameters,
      document_provider_reference: 'MIO_TEST_META_MEDIA_001',
      submission_attempt_hash: 'A'.repeat(64)
    };
  };
  await adapter.deliver({ claim, recipient: '573000000001' });
  assert.deepEqual(calls.map((item) => item[0]), ['begin', 'template', 'complete']);
  assert.equal(calls[1][4], 'MIO_TEST_META_MEDIA_001');
});
