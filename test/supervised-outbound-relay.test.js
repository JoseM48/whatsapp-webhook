'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { destinationReferenceHash } = require('../lib/pilot/supervised-outbound-adapter');
const { runSupervisedReservationConfirmationRelay } = require('../lib/pilot/supervised-outbound-relay');

function fixture({ count = 1, destination = '573146892662' } = {}) {
  const calls = [];
  const pms = {
    async heldSupervisedOutboundSummary() {
      calls.push(['summary']);
      return { groups: [
        { template_key: 'operations_calendar_update', recipient_role: 'operaciones', status: 'held', count: 6 },
        { template_key: 'reservation_confirmed_lead', recipient_role: 'lead', status: 'held', count }
      ] };
    },
    async claimSupervisedOutbound(body) {
      calls.push(['claim', body]);
      return { delivery_id: 7, template_key: 'reservation_confirmed_lead', delivery_mode: 'template',
        destination_reference_hash: destinationReferenceHash(destination) };
    }
  };
  const adapter = {
    async deliver(input) { calls.push(['deliver', input]); return { status: 'submitted' }; },
    async rejectClaim(claim, code) { calls.push(['reject', claim, code]); }
  };
  return { pms, adapter, calls };
}

test('compuerta apagada no consulta ni reclama', async () => {
  const { pms, adapter, calls } = fixture();
  assert.deepEqual(await runSupervisedReservationConfirmationRelay({
    gateVersion: '', m0Enabled: true, pms, adapter, allowlist: ['573146892662']
  }), { executed: false, reason: 'gate_disabled' });
  assert.deepEqual(calls, []);
});

test('modo diagnóstico sólo consulta elegibilidad y nunca reclama ni entrega', async () => {
  const { pms, adapter, calls } = fixture();
  pms.heldSupervisedOutboundSummary = async () => {
    calls.push(['summary']);
    return { eligibility: { candidate_count: 1, route_missing: 0, permission_missing: 1,
      mode_missing: 0, fully_eligible: 0 } };
  };
  const result = await runSupervisedReservationConfirmationRelay({
    gateVersion: 'diagnostic', m0Enabled: true, pms, adapter, allowlist: ['573006774425'],
    logger: { info() {} }
  });
  assert.deepEqual(result, { executed: false, reason: 'diagnostic_only', eligibility: {
    candidate_count: 1, route_missing: 0, permission_missing: 1, mode_missing: 0, fully_eligible: 0
  } });
  assert.deepEqual(calls.map((item) => item[0]), ['summary']);
});

test('exige exactamente una confirmación retenida', async () => {
  const { pms, adapter, calls } = fixture({ count: 2 });
  await assert.rejects(runSupervisedReservationConfirmationRelay({
    gateVersion: 'v1', m0Enabled: true, pms, adapter, allowlist: ['573146892662']
  }), /confirmation_count_invalid/);
  assert.deepEqual(calls.map((item) => item[0]), ['summary']);
});

test('reclama sólo confirmación y entrega a un único teléfono autorizado', async () => {
  const { pms, adapter, calls } = fixture();
  const result = await runSupervisedReservationConfirmationRelay({
    gateVersion: 'v1', m0Enabled: true, pms, adapter,
    allowlist: ['573006774425', '573146892662'], logger: { info() {} }
  });
  assert.deepEqual(result, { executed: true, delivery_id: 7, template_key: 'reservation_confirmed_lead',
    delivery_mode: 'template', status: 'submitted', recipient_authorized: true });
  assert.deepEqual(calls.map((item) => item[0]), ['summary', 'claim', 'deliver']);
  assert.deepEqual(calls[1][1], { template_key: 'reservation_confirmed_lead' });
  assert.equal(calls[2][1].recipient, '573146892662');
});

test('un destino fuera de cohorte se rechaza antes de Meta', async () => {
  const { pms, adapter, calls } = fixture({ destination: '573001112233' });
  await assert.rejects(runSupervisedReservationConfirmationRelay({
    gateVersion: 'v1', m0Enabled: true, pms, adapter, allowlist: ['573006774425', '573146892662']
  }), /destination_not_authorized/);
  assert.deepEqual(calls.map((item) => item[0]), ['summary', 'claim', 'reject']);
});
