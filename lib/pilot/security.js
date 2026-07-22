'use strict';

const crypto = require('crypto');

function onlyDigits(value = '') { return String(value || '').replace(/[^\d]/g, ''); }

function normalizePhone(raw, defaultCountryCode = '57') {
  const digits = onlyDigits(raw);
  if (!digits) return null;
  if (digits.length >= 11 && digits.length <= 15) return digits;
  if (digits.length === 10) return `${defaultCountryCode}${digits}`;
  return digits;
}

function parseAllowlist(value) {
  return String(value || '').split(',').map((phone) => normalizePhone(phone.trim())).filter(Boolean);
}

function isAllowlisted(phone, allowlist) {
  const normalized = normalizePhone(phone);
  return Boolean(normalized && allowlist.includes(normalized));
}

function safeHexEqual(left, right) {
  const a = Buffer.from(String(left || ''), 'hex');
  const b = Buffer.from(String(right || ''), 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function validateMetaSignature({ rawBody, signatureHeader, appSecret, required }) {
  if (!required && (!signatureHeader || !appSecret)) return { ok: true, skipped: true };
  if (!appSecret) return { ok: false, status: 503, error: 'meta_app_secret_not_configured' };
  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) {
    return { ok: false, status: 401, error: 'meta_signature_missing' };
  }
  if (!Buffer.isBuffer(rawBody)) return { ok: false, status: 401, error: 'meta_raw_body_missing' };
  const expected = crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');
  const actual = signatureHeader.slice('sha256='.length);
  return safeHexEqual(actual, expected)
    ? { ok: true, skipped: false }
    : { ok: false, status: 401, error: 'meta_signature_invalid' };
}

function safetyIdentifier(phone, salt) {
  return crypto.createHmac('sha256', salt || 'pilot-local-safety').update(normalizePhone(phone) || 'unknown').digest('hex');
}

function maskPhone(phone) {
  const normalized = normalizePhone(phone);
  return normalized ? `***${normalized.slice(-4)}` : null;
}

module.exports = {
  normalizePhone, parseAllowlist, isAllowlisted, validateMetaSignature, safetyIdentifier, maskPhone
};
