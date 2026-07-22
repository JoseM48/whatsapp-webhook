'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { parseAllowlist, isAllowlisted, validateMetaSignature } = require('../lib/pilot/security');

test('allowlist normaliza y limita el piloto', () => {
  const allowlist = parseAllowlist('3000000001,+573000000002');
  assert.equal(allowlist.length, 2);
  assert.equal(isAllowlisted('+57 300 000 0001', allowlist), true);
  assert.equal(isAllowlisted('+57 300 000 0099', allowlist), false);
});

test('firma Meta válida sobre el cuerpo original', () => {
  const rawBody = Buffer.from('{"entry":[]}');
  const appSecret = 'app-secret-ficticio';
  const signature = crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');
  assert.equal(validateMetaSignature({
    rawBody, signatureHeader: `sha256=${signature}`, appSecret, required: true
  }).ok, true);
});

test('firma Meta inválida o ausente falla cerrado cuando es obligatoria', () => {
  const rawBody = Buffer.from('{"entry":[]}');
  assert.equal(validateMetaSignature({
    rawBody, signatureHeader: `sha256=${'0'.repeat(64)}`, appSecret: 'secret', required: true
  }).status, 401);
  assert.equal(validateMetaSignature({ rawBody, appSecret: 'secret', required: true }).status, 401);
  assert.equal(validateMetaSignature({ rawBody, required: true }).status, 503);
});

test('modo compatible no rompe el flujo legado si aún falta App Secret', () => {
  const result = validateMetaSignature({
    rawBody: Buffer.from('{}'), signatureHeader: `sha256=${'0'.repeat(64)}`,
    appSecret: '', required: false
  });
  assert.equal(result.ok, true);
  assert.equal(result.skipped, true);
});
