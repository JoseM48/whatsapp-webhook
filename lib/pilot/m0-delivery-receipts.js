'use strict';

const { normalizePhone } = require('./security');

function receiptError(code) { return Object.assign(new Error(code), { code }); }

function createM0DeliveryReceiptHandler({ config, pms, logger = console }) {
  const enabled = config?.enabled === true;
  const guest = normalizePhone(config?.guestPhone);
  const internal = normalizePhone(config?.internalPhone);
  const allowlist = [...new Set((config?.allowlist || []).map(normalizePhone).filter(Boolean))].sort();
  const exact = [guest, internal].filter(Boolean).sort();
  if (enabled && (!guest || !internal || guest === internal || allowlist.length !== 2 ||
    exact.length !== 2 || allowlist.join(',') !== exact.join(',') || config?.metaSignatureRequired !== true ||
    config?.pmsConfigured !== true)) throw receiptError('m0_closed_receipt_webhook_configuration_invalid');

  return {
    status() { return { enabled, ready: enabled && exact.length === 2 }; },
    async capture(statuses = []) {
      if (!enabled) return { enabled: false, processed: 0, quarantined: 0, results: [] };
      const results = [];
      let quarantined = 0;
      for (const status of statuses) {
        const recipient = normalizePhone(status.recipientId);
        if (!allowlist.includes(recipient)) { quarantined += 1; continue; }
        const persisted = await pms.recordClosedPilotDeliveryStatus({
          provider_reference: status.providerReference,
          recipient_id: recipient,
          status: status.status,
          occurred_at: status.timestamp,
          error_code: status.errorCode || null
        });
        results.push({
          matched: persisted?.matched === true,
          deduplicated: persisted?.deduplicated === true,
          provider_status: persisted?.provider_status || status.status,
          delivery_status: persisted?.delivery_status || null,
          reason_code: persisted?.reason_code || null
        });
      }
      if (quarantined) logger.warn('[m0-delivery] receipt_recipient_quarantined', { count: quarantined });
      return { enabled: true, processed: results.length, quarantined, results };
    }
  };
}

module.exports = { createM0DeliveryReceiptHandler };
