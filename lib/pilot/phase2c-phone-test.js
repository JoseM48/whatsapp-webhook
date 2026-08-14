'use strict';

const crypto = require('crypto');
const { normalizePhone } = require('./security');

const COMMANDS = Object.freeze({
  RECHAZAR: 'reject',
  'AIRBNB BLOQUEADO': 'airbnb_blocked',
  APROBAR: 'approve',
  'DETENER PRUEBA': 'stop'
});

function normalizeCommand(value) {
  const normalized = String(value || '')
    .normalize('NFKC')
    .trim()
    .replace(/\s+/g, ' ')
    .toUpperCase();
  return COMMANDS[normalized] || null;
}

function uniquePhones(values = []) {
  return [...new Set(values.map((value) => normalizePhone(value)).filter(Boolean))];
}

function fingerprintMessageId(value) {
  if (!value) return null;
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 12);
}

function createPhase2cPhoneTestCapture({
  enabled = false,
  runtimeSafe = false,
  allowlist = [],
  managerPhone,
  maxSeenMessageIds = 100
} = {}) {
  const phones = uniquePhones(allowlist);
  const manager = normalizePhone(managerPhone);
  const ready = Boolean(enabled && runtimeSafe && phones.length === 2 && manager && phones.includes(manager));
  const seenMessageIds = new Set();
  let state = 'awaiting_owner_reject';

  function rememberMessageId(messageId) {
    seenMessageIds.add(messageId);
    if (seenMessageIds.size <= maxSeenMessageIds) return;
    seenMessageIds.delete(seenMessageIds.values().next().value);
  }

  function status() {
    return {
      enabled: Boolean(enabled),
      ready,
      runtime_safe: Boolean(runtimeSafe),
      allowlist_count: phones.length,
      manager_in_allowlist: Boolean(manager && phones.includes(manager)),
      state
    };
  }

  function capture({ phone, text, messageId } = {}) {
    if (!enabled) return { captured: false, reason: 'disabled', state };
    if (!ready) return { captured: false, reason: 'misconfigured', state };

    const normalizedPhone = normalizePhone(phone);
    if (!phones.includes(normalizedPhone)) return { captured: false, reason: 'not_allowlisted', state };

    const role = normalizedPhone === manager ? 'gerente' : 'propietario';
    if (state === 'stopped') return { captured: false, reason: 'stopped', role, state };
    if (!messageId) return { captured: false, reason: 'message_id_missing', role, state };
    if (seenMessageIds.has(messageId)) {
      return {
        captured: false,
        reason: 'duplicate',
        role,
        state,
        message_id_fingerprint: fingerprintMessageId(messageId)
      };
    }

    const command = normalizeCommand(text);
    if (!command) return { captured: false, reason: 'unsupported_command', role, state };

    const allowedByRole = role === 'propietario'
      ? ['reject', 'stop']
      : ['airbnb_blocked', 'approve', 'stop'];
    if (!allowedByRole.includes(command)) {
      return { captured: false, reason: 'wrong_role', role, command, state };
    }

    if (command === 'stop') {
      rememberMessageId(messageId);
      state = 'stopped';
      return {
        captured: true,
        role,
        command,
        state,
        message_id_fingerprint: fingerprintMessageId(messageId)
      };
    }

    const expected = {
      awaiting_owner_reject: { role: 'propietario', command: 'reject', next: 'owner_rejected' },
      owner_rejected: { role: 'gerente', command: 'airbnb_blocked', next: 'manager_airbnb_blocked' },
      manager_airbnb_blocked: { role: 'gerente', command: 'approve', next: 'manager_approved' }
    }[state];

    if (!expected || expected.role !== role || expected.command !== command) {
      return { captured: false, reason: 'invalid_sequence', role, command, state };
    }

    rememberMessageId(messageId);
    state = expected.next;
    return {
      captured: true,
      role,
      command,
      state,
      message_id_fingerprint: fingerprintMessageId(messageId)
    };
  }

  return { capture, status };
}

module.exports = { createPhase2cPhoneTestCapture, normalizeCommand };
