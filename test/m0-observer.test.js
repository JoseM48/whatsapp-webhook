'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { observeM0 } = require('../lib/pilot/m0-observer');

test('no consulta PMS cuando M0 está apagado', async () => {
  let calls = 0;
  const result = await observeM0({ enabled: false, pms: { async supervisedPanel() { calls += 1; } } });
  assert.deepEqual(result, { observed: false, reason: 'disabled' });
  assert.equal(calls, 0);
});

test('registra un snapshot seudonimizado con trazabilidad sin propagar contenido personal', async () => {
  const logs = [];
  const result = await observeM0({
    enabled: true,
    reason: 'inbound_captured',
    pms: { async supervisedPanel() {
      return {
        snapshot_generated_at: '2026-08-24T19:00:00.000Z', processing_attention_target_seconds: 120,
        data_classification: 'pseudonymized_operational_data', human_acknowledgement_recorded: false,
        scope: ['LF-210', 'LF-404', 'LF-1208'], counts: { active_cohort_leads: 1,
          m0_runtime_state: 'active', telefono: 99 },
        leads: [{ cohort_slot: 1, lead_id: 9, processing_state: 'received',
          audit: { inbound_registered: 1, processing_records: 1, unprocessed_inbound: 0 },
          recent_interventions: [{ interaction_id: 10, received_at: '2026-08-24T18:59:56.000Z',
            processing_state: 'received' }], proposal_candidate_count: 0,
          last_activity_age_seconds: 4, attention_required: false,
          proposal: { id: 4, status: 'selected', apartment: 'LF-210', check_in: '2026-09-01',
            check_out: '2026-09-03', telefono: '573009999999' },
          pre_reservation: { id: 5, status: 'pending', mensaje: 'secreto' },
          reservation: { id: 6, status: 'confirmada', nombre: 'Persona anidada' },
          telefono: '573001112233', mensaje: 'contenido privado', nombre: 'Persona' }]
      };
    } },
    logger: { info(...args) { logs.push(args); }, error() {} }
  });
  assert.equal(result.observed, true);
  assert.equal(logs.length, 1);
  assert.equal(logs[0][0], '[m0-monitor] snapshot');
  assert.deepEqual(logs[0][1].leads, [{
    cohort_slot: 1, lead_id: 9, lead_status: null, last_interaction_id: null,
    last_interaction_at: null, processing_state: 'received', last_error_code: null,
    m0_outbound_state: null, m0_outbound_updated_at: null,
    consent_notice_status: null,
    audit: { inbound_registered: 1, processing_records: 1, unprocessed_inbound: 0,
      conversation_outbound: 0, conversation_outbound_sent: 0, conversation_outbound_failed: 0,
      unauthorized_conversation_outbound: 0, governed_outbound_attempts: 0,
      unauthorized_governed_outbound: 0, m0_outbound_ledger: 0, m0_outbound_submitted: 0,
      m0_outbound_uncertain: 0, m0_outbound_failed: 0, unledgered_m0_interactions: 0,
      unauthorized_m0_outbound: 0, unobserved_interactions: 0,
      max_first_observation_latency_seconds: 0 },
    recent_interventions: [{ interaction_id: 10, received_at: '2026-08-24T18:59:56.000Z',
      processing_state: 'received', processing_updated_at: null, outbound_state: null,
      outbound_updated_at: null, m0_outbound_state: null, first_observed_at: null,
      first_observation_latency_seconds: null }], proposal_candidate_count: 0,
    proposal: { id: 4, status: 'selected', apartment: 'LF-210', check_in: '2026-09-01', check_out: '2026-09-03' },
    pre_reservation: { id: 5, status: 'pending' }, reservation: { id: 6, status: 'confirmada' },
    last_activity_age_seconds: 4, attention_required: false
  }]);
  assert.equal(logs[0][1].data_classification, 'pseudonymized_operational_data');
  assert.equal(logs[0][1].m0_runtime_state, 'active');
  assert.equal(logs[0][1].human_acknowledgement_recorded, false);
  assert.doesNotMatch(JSON.stringify(logs), /573001112233|573009999999|contenido privado|secreto|Persona|telefono|mensaje|nombre/);
});

test('un fallo de observación nunca bloquea el flujo del cliente', async () => {
  const errors = [];
  const result = await observeM0({ enabled: true, reason: 'inbound_captured',
    pms: { async supervisedPanel() { throw Object.assign(new Error('down'), { code: 'ECONNRESET' }); } },
    logger: { info() {}, error(...args) { errors.push(args); } }
  });
  assert.deepEqual(result, { observed: false, reason: 'unavailable' });
  assert.equal(errors[0][0], '[m0-monitor] unavailable');
  assert.equal(errors[0][1].code, 'ECONNRESET');
});
