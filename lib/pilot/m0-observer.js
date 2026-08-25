'use strict';

function safeLeadState(lead = {}) {
  const audit = lead.audit || {};
  return {
    cohort_slot: Number(lead.cohort_slot),
    lead_id: Number(lead.lead_id),
    lead_status: lead.lead_status || null,
    last_interaction_id: lead.last_interaction_id == null ? null : Number(lead.last_interaction_id),
    last_interaction_at: lead.last_interaction_at || null,
    processing_state: lead.processing_state || null,
    m0_outbound_state: lead.m0_outbound_state || null,
    m0_outbound_updated_at: lead.m0_outbound_updated_at || null,
    last_error_code: lead.last_error_code || null,
    consent_notice_status: lead.consent_notice_status || null,
    audit: {
      inbound_registered: Number(audit.inbound_registered || 0),
      processing_records: Number(audit.processing_records || 0),
      unprocessed_inbound: Number(audit.unprocessed_inbound || 0),
      conversation_outbound: Number(audit.conversation_outbound || 0),
      conversation_outbound_sent: Number(audit.conversation_outbound_sent || 0),
      conversation_outbound_failed: Number(audit.conversation_outbound_failed || 0),
      unauthorized_conversation_outbound: Number(audit.unauthorized_conversation_outbound || 0),
      m0_outbound_ledger: Number(audit.m0_outbound_ledger || 0),
      m0_outbound_submitted: Number(audit.m0_outbound_submitted || 0),
      m0_outbound_uncertain: Number(audit.m0_outbound_uncertain || 0),
      m0_outbound_failed: Number(audit.m0_outbound_failed || 0),
      unledgered_m0_interactions: Number(audit.unledgered_m0_interactions || 0),
      unauthorized_m0_outbound: Number(audit.unauthorized_m0_outbound || 0),
      unobserved_interactions: Number(audit.unobserved_interactions || 0),
      max_first_observation_latency_seconds: Number(audit.max_first_observation_latency_seconds || 0),
      governed_outbound_attempts: Number(audit.governed_outbound_attempts || 0),
      unauthorized_governed_outbound: Number(audit.unauthorized_governed_outbound || 0)
    },
    recent_interventions: Array.isArray(lead.recent_interventions)
      ? lead.recent_interventions.map((item) => ({
        interaction_id: Number(item.interaction_id),
        received_at: item.received_at || null,
        processing_state: item.processing_state || null,
        processing_updated_at: item.processing_updated_at || null,
        outbound_state: item.outbound_state || null,
        outbound_updated_at: item.outbound_updated_at || null,
        m0_outbound_state: item.m0_outbound_state || null,
        first_observed_at: item.first_observed_at || null,
        first_observation_latency_seconds: item.first_observation_latency_seconds == null
          ? null : Number(item.first_observation_latency_seconds)
      })) : [],
    proposal_candidate_count: Number(lead.proposal_candidate_count || 0),
    proposal: lead.proposal ? { id: Number(lead.proposal.id), status: lead.proposal.status || null,
      apartment: lead.proposal.apartment || null, check_in: lead.proposal.check_in || null,
      check_out: lead.proposal.check_out || null } : null,
    pre_reservation: lead.pre_reservation ? { id: Number(lead.pre_reservation.id),
      status: lead.pre_reservation.status || null } : null,
    reservation: lead.reservation ? { id: Number(lead.reservation.id), status: lead.reservation.status || null } : null,
    last_activity_age_seconds: lead.last_activity_age_seconds == null
      ? null : Number(lead.last_activity_age_seconds),
    attention_required: lead.attention_required === true
  };
}

function safeCounts(counts = {}) {
  return Object.fromEntries([
    'leads','active_cohort_leads','active_pre_reservations','confirmed_reservations','held_commands',
    'held_scheduler_runs','held_outbound','m0_outbound_ledger','m0_outbound_submitted','m0_outbound_uncertain'
  ].map((key) => [key, Number(counts[key] || 0)]));
}

async function observeM0({ enabled, pms, reason, logger = console }) {
  if (!enabled) return { observed: false, reason: 'disabled' };
  try {
    const panel = await pms.supervisedPanel();
    const snapshot = {
      reason: String(reason || 'unspecified'),
      snapshot_generated_at: panel?.snapshot_generated_at || new Date().toISOString(),
      processing_attention_target_seconds: Number(panel?.processing_attention_target_seconds || 120),
      scope: Array.isArray(panel?.scope) ? panel.scope : [],
      counts: safeCounts(panel?.counts),
      m0_runtime_state: ['active', 'paused'].includes(panel?.counts?.m0_runtime_state)
        ? panel.counts.m0_runtime_state : 'unknown',
      leads: Array.isArray(panel?.leads) ? panel.leads.map(safeLeadState) : [],
      data_classification: 'pseudonymized_operational_data',
      access_requirement: 'authenticated_supervisor_only',
      human_acknowledgement_recorded: panel?.human_acknowledgement_recorded === true,
      machine_observation_evidence: panel?.machine_observation_evidence === true
    };
    logger.info('[m0-monitor] snapshot', snapshot);
    return { observed: true, snapshot };
  } catch (error) {
    logger.error('[m0-monitor] unavailable', {
      reason: String(reason || 'unspecified'),
      status: error?.response?.status || null,
      code: error?.code || 'm0_monitor_unavailable'
    });
    return { observed: false, reason: 'unavailable' };
  }
}

module.exports = { observeM0, safeLeadState, safeCounts };
