'use strict';

const { normalizePhone } = require('./security');

function closedError(code) { return Object.assign(new Error(code), { code }); }

function validateClosedPilotConfig(config) {
  if (!config.enabled) return { enabled: false, ready: false };
  const guest = normalizePhone(config.guestPhone);
  const internal = normalizePhone(config.internalPhone);
  const allowlist = [...new Set((config.allowlist || []).map(normalizePhone).filter(Boolean))].sort();
  const exact = [guest, internal].filter(Boolean).sort();
  if (!guest || !internal || guest === internal || allowlist.length !== 2 ||
    exact.length !== 2 || allowlist.join(',') !== exact.join(',') || !config.metaSignatureRequired ||
    !config.pmsM0Enabled || !config.controlledIngressEnabled || !config.pmsConfigured) throw closedError('m0_closed_webhook_configuration_invalid');
  return { enabled: true, ready: true, guest, internal, allowlist };
}

function uncertain(error) {
  return ['ECONNABORTED', 'ETIMEDOUT', 'ECONNRESET', 'provider_reference_missing'].includes(error?.code) ||
    Number(error?.response?.status) >= 500 || /timeout/i.test(error?.message || '');
}

function normalizedCommand(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .trim().toUpperCase().replace(/\s+/g, ' ');
}

function createM0ClosedPilotDispatcher({ config, pms, sendText, logger = console }) {
  const status = validateClosedPilotConfig(config);
  async function deliver(outbox) {
    const claim = await pms.claimClosedPilotOutbound(outbox.id);
    if (!claim?.claimable) return { id: outbox.id, status: claim?.status || 'not_claimable', sent: false };
    const recipient = claim.recipient_kind === 'guest' ? status.guest
      : claim.recipient_kind === 'internal' ? status.internal : null;
    if (!recipient || !status.allowlist.includes(recipient)) throw closedError('m0_closed_recipient_outside_exact_allowlist');
    let providerReference = null;
    try {
      providerReference = await sendText(recipient, claim.message_text);
      if (!providerReference) throw closedError('provider_reference_missing');
      await pms.completeClosedPilotOutbound({ outbox_id: claim.outbox_id, status: 'submitted',
        provider_reference: providerReference });
      return { id: outbox.id, status: 'submitted', sent: true };
    } catch (error) {
      const state = providerReference || uncertain(error) ? 'unknown' : 'failed';
      try { await pms.completeClosedPilotOutbound({ outbox_id: claim.outbox_id, status: state }); }
      catch (persistenceError) { logger.error('[m0-closed] outbound_state_persistence_failed', { state,
        code: persistenceError?.code || 'persistence_failed' }); }
      throw error;
    }
  }
  async function deliverAll(outboxes = []) {
    const deliveries = [];
    for (const outbox of outboxes) deliveries.push(await deliver(outbox));
    return deliveries;
  }
  async function deliverAllSafe(outboxes = []) {
    const deliveries = [];
    for (const outbox of outboxes) {
      try { deliveries.push(await deliver(outbox)); }
      catch (error) {
        logger.error('[m0-commercial] outbound_failed_after_durable_capture', {
          outbox_id: outbox.id, code: error?.code || 'commercial_outbound_failed'
        });
        deliveries.push({ id: outbox.id, status: 'failed_or_unknown', sent: false,
          error_code: error?.code || 'commercial_outbound_failed' });
      }
    }
    return deliveries;
  }
  return {
    status: () => ({ ...status, guest: undefined, internal: undefined, allowlist: undefined }),
    accepts(phone) { const value = normalizePhone(phone); return status.enabled && status.allowlist.includes(value); },
    isControl(phone, text) {
      const value = normalizePhone(phone);
      if (!status.enabled || !status.allowlist.includes(value)) return false;
      if (value === status.internal) return true;
      const command = normalizedCommand(text);
      return command === 'NUEVA PRUEBA' || command === 'REINICIAR CASO' || command.startsWith('ESTADO CASO');
    },
    async beginCommercial({ phone, messageId, occurredAt, deliver = true }) {
      const normalizedPhone = normalizePhone(phone);
      if (!status.enabled) return { handled: false, deliveries: [] };
      if (!status.allowlist.includes(normalizedPhone)) return { handled: true, quarantined: true, deliveries: [] };
      if (!messageId) throw closedError('m0_closed_message_id_required');
      const result = await pms.beginClosedPilotCommercial({ phone: normalizedPhone,
        external_message_id: messageId, occurred_at: occurredAt });
      return { handled: true, quarantined: false, result,
        deliveries: deliver ? await deliverAllSafe(result?.outboxes || []) : [] };
    },
    deliverCommercialOutboxes(outboxes) { return deliverAllSafe(outboxes); },
    async completeCommercial({ externalMessageId, interpretation, ai }) {
      const result = await pms.processClosedPilotCommercial({ external_message_id: externalMessageId,
        interpretation, ai });
      return { handled: true, result, deliveries: await deliverAllSafe(result?.outboxes || []) };
    },
    async process({ phone, text, messageId, occurredAt }) {
      if (!status.enabled) return { handled: false };
      const normalizedPhone = normalizePhone(phone);
      if (!status.allowlist.includes(normalizedPhone)) return { handled: true, quarantined: true, deliveries: [] };
      if (!messageId) throw closedError('m0_closed_message_id_required');
      const result = await pms.closedPilotInbound({ phone: normalizedPhone, text,
        external_message_id: messageId, occurred_at: occurredAt });
      const deliveries = await deliverAll(result?.outboxes || []);
      return { handled: true, quarantined: false, result, deliveries };
    }
  };
}

module.exports = { createM0ClosedPilotDispatcher, validateClosedPilotConfig };
