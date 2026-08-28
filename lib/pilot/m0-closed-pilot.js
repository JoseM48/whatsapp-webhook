'use strict';

const { normalizePhone } = require('./security');

function closedError(code) { return Object.assign(new Error(code), { code }); }

function validateClosedPilotConfig(config) {
  const internal = normalizePhone(config.internalPhone);
  const templateConfigured = /^[a-z0-9_]{3,512}$/.test(String(config.internalTemplateName || '')) &&
    /^[a-z]{2,3}(?:_[A-Z]{2})?$/.test(String(config.internalTemplateLanguage || ''));
  if (!config.enabled) return { enabled: false, ready: false, receipts_enabled: config.receiptsEnabled === true,
    internal_template_configured: templateConfigured };
  // The guest side is deliberately open: any phone that is not the internal/staff
  // number is treated as a guest. Only the internal (staff) number stays gated —
  // it is the sole recipient allowed for internal-role escalations and commands.
  if (!internal || !config.metaSignatureRequired ||
    !config.pmsM0Enabled || !config.controlledIngressEnabled || !config.pmsConfigured ||
    config.receiptsEnabled !== true || !templateConfigured) throw closedError('m0_closed_webhook_configuration_invalid');
  return { enabled: true, ready: true, internal, receipts_enabled: true,
    internal_template_configured: true, internalTemplateName: config.internalTemplateName,
    internalTemplateLanguage: config.internalTemplateLanguage };
}

function uncertain(error) {
  return ['ECONNABORTED', 'ETIMEDOUT', 'ECONNRESET', 'provider_reference_missing'].includes(error?.code) ||
    Number(error?.response?.status) >= 500 || /timeout/i.test(error?.message || '');
}

function normalizedCommand(value) {
  return String(value || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .trim().toUpperCase().replace(/\s+/g, ' ');
}

// WhatsApp template parameters reject embedded newlines/tabs and 4+
// consecutive spaces. The internal message body is intentionally allowed to
// span multiple lines (it is readable in the outbox/audit trail), so it must
// be flattened here, right before it becomes a template parameter — not
// scattered across every place in PMS that builds one.
function sanitizeTemplateParameter(value) {
  return String(value).replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim();
}

function internalTemplateParameters(message) {
  const match = String(message || '').match(/^PILOTO M0\nPARA: ([^\n]+)\nCASO: ([^\n]+)\nAPARTAMENTO: ([^\n]+)\nACCIÓN SOLICITADA: ([^\n]+)\n\n([\s\S]+)$/);
  if (!match) throw closedError('m0_closed_internal_template_payload_invalid');
  return match.slice(1).map(sanitizeTemplateParameter);
}

function createM0ClosedPilotDispatcher({ config, pms, sendText, sendTemplate, logger = console }) {
  const status = validateClosedPilotConfig(config);
  async function deliver(outbox) {
    const claim = await pms.claimClosedPilotOutbound(outbox.id);
    if (!claim?.claimable) return { id: outbox.id, status: claim?.status || 'not_claimable', sent: false };
    // Guest recipients are resolved per-conversation by PMS (real phone of the
    // lead behind that case), never a fixed configured value. Internal recipients
    // stay pinned to the single configured staff number.
    const recipient = claim.recipient_kind === 'guest' ? normalizePhone(claim.recipient_phone || '')
      : claim.recipient_kind === 'internal' ? status.internal : null;
    const recipientValid = claim.recipient_kind === 'internal' ? recipient === status.internal
      : claim.recipient_kind === 'guest' ? Boolean(recipient) && recipient.length >= 10 : false;
    if (!recipientValid) throw closedError('m0_closed_recipient_missing_or_invalid');
    let providerReference = null;
    try {
      providerReference = claim.recipient_kind === 'internal'
        ? await sendTemplate(recipient, { name: status.internalTemplateName,
          language: status.internalTemplateLanguage, parameters: internalTemplateParameters(claim.message_text) })
        : await sendText(recipient, claim.message_text);
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
        // Meta's error body (message/code, no secrets or guest content) is
        // logged so a rejected send is diagnosable without re-deriving it
        // from scratch next time.
        logger.error('[m0-commercial] outbound_failed_after_durable_capture', {
          outbox_id: outbox.id, code: error?.code || 'commercial_outbound_failed',
          http_status: error?.response?.status || null,
          meta_error: error?.response?.data?.error?.message || error?.response?.data?.error?.error_data?.details || null
        });
        deliveries.push({ id: outbox.id, status: 'failed_or_unknown', sent: false,
          error_code: error?.code || 'commercial_outbound_failed' });
      }
    }
    return deliveries;
  }
  return {
    status: () => ({ ...status, internal: undefined,
      internalTemplateName: undefined, internalTemplateLanguage: undefined }),
    // Anyone who is not the internal/staff number is accepted as a guest.
    // PMS enforces the real gates: runtime state, cohort enrollment and cap,
    // and the apartment scope — this is only a cheap routing check.
    accepts(phone) { const value = normalizePhone(phone); return status.enabled && Boolean(value); },
    isControl(phone, text) {
      if (!status.enabled) return false;
      const value = normalizePhone(phone);
      if (value === status.internal) return true;
      const command = normalizedCommand(text);
      return command === 'NUEVA PRUEBA' || command === 'REINICIAR CASO' || command.startsWith('ESTADO CASO');
    },
    async beginCommercial({ phone, messageId, occurredAt, deliver = true }) {
      const normalizedPhone = normalizePhone(phone);
      if (!status.enabled) return { handled: false, deliveries: [] };
      if (!normalizedPhone) return { handled: true, quarantined: true, deliveries: [] };
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
      if (!normalizedPhone) return { handled: true, quarantined: true, deliveries: [] };
      if (!messageId) throw closedError('m0_closed_message_id_required');
      const result = await pms.closedPilotInbound({ phone: normalizedPhone, text,
        external_message_id: messageId, occurred_at: occurredAt });
      const deliveries = await deliverAll(result?.outboxes || []);
      return { handled: true, quarantined: false, result, deliveries };
    }
  };
}

module.exports = { createM0ClosedPilotDispatcher, validateClosedPilotConfig, internalTemplateParameters };
