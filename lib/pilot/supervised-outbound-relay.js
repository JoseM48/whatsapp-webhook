'use strict';

const { destinationReferenceHash } = require('./supervised-outbound-adapter');

async function runSupervisedReservationConfirmationRelay({
  gateVersion,
  m0Enabled,
  pms,
  adapter,
  allowlist,
  logger = console
}) {
  if (gateVersion !== 'v1') return { executed: false, reason: 'gate_disabled' };
  if (!m0Enabled || !pms || !adapter) throw new Error('m0_supervised_outbound_not_ready');

  const summary = await pms.heldSupervisedOutboundSummary();
  const matchingCount = (summary?.groups || [])
    .filter((group) => group.template_key === 'reservation_confirmed_lead'
      && group.recipient_role === 'lead' && ['held', 'pending'].includes(group.status))
    .reduce((sum, group) => sum + Number(group.count || 0), 0);
  if (matchingCount !== 1) {
    throw Object.assign(new Error('m0_supervised_outbound_confirmation_count_invalid'), {
      code: 'm0_supervised_outbound_confirmation_count_invalid'
    });
  }

  const claim = await pms.claimSupervisedOutbound({ template_key: 'reservation_confirmed_lead' });
  if (!claim || claim.template_key !== 'reservation_confirmed_lead') {
    throw Object.assign(new Error('m0_supervised_outbound_confirmation_claim_invalid'), {
      code: 'm0_supervised_outbound_confirmation_claim_invalid'
    });
  }
  const candidates = [...new Set((allowlist || []).map(String))]
    .filter((phone) => destinationReferenceHash(phone) === claim.destination_reference_hash);
  if (candidates.length !== 1) {
    await adapter.rejectClaim(claim, 'AUTHORIZED_DESTINATION_NOT_FOUND');
    throw Object.assign(new Error('m0_supervised_outbound_destination_not_authorized'), {
      code: 'm0_supervised_outbound_destination_not_authorized'
    });
  }

  const result = await adapter.deliver({ claim, recipient: candidates[0] });
  logger.info('[m0-supervised-outbound] completed', {
    delivery_id: String(claim.delivery_id),
    template_key: claim.template_key,
    delivery_mode: claim.delivery_mode,
    status: result?.status || null,
    recipient_authorized: true
  });
  return {
    executed: true,
    delivery_id: Number(claim.delivery_id),
    template_key: claim.template_key,
    delivery_mode: claim.delivery_mode,
    status: result?.status || null,
    recipient_authorized: true
  };
}

module.exports = { runSupervisedReservationConfirmationRelay };
