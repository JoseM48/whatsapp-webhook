'use strict';

const crypto = require('crypto');
const { normalizePhone } = require('./security');

function normalizeControlCommand(value) {
  const command = String(value || '').normalize('NFKC').trim().replace(/\s+/g, ' ').toUpperCase();
  if (command === 'DETENER PILOTO M0') return { state: 'paused', reason_code: 'OPERATOR_WHATSAPP_STOP' };
  return null;
}

function resolveM0ControlCommand({ enabled, phone, managerPhone, text, messageId, occurredAt }) {
  if (!enabled) return null;
  const manager = normalizePhone(managerPhone);
  if (!manager || normalizePhone(phone) !== manager || !messageId || !occurredAt) return null;
  const command = normalizeControlCommand(text);
  if (!command) return null;
  const sourceHash = crypto.createHash('sha256').update(String(messageId)).digest('hex').toUpperCase();
  return { ...command, command_id: `m0-whatsapp-${sourceHash.toLowerCase().slice(0, 32)}`,
    source_event_hash: sourceHash, source_type: 'meta_admin_message', occurred_at: occurredAt };
}

module.exports = { normalizeControlCommand, resolveM0ControlCommand };
