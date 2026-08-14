'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createPhase2cPhoneTestCapture, normalizeCommand } = require('../lib/pilot/phase2c-phone-test');

const owner = '+57 300 000 0001';
const manager = '+57 300 000 0002';

function create(overrides = {}) {
  return createPhase2cPhoneTestCapture({
    enabled: true,
    runtimeSafe: true,
    allowlist: [owner, manager],
    managerPhone: manager,
    ...overrides
  });
}

test('normaliza unicamente los cuatro comandos autorizados', () => {
  assert.equal(normalizeCommand('  rechazar  '), 'reject');
  assert.equal(normalizeCommand('airbnb   bloqueado'), 'airbnb_blocked');
  assert.equal(normalizeCommand('APROBAR'), 'approve');
  assert.equal(normalizeCommand('detener prueba'), 'stop');
  assert.equal(normalizeCommand('aprobar por favor'), null);
});

test('permanece fail-closed si la flag, el runtime o el mapeo no son seguros', () => {
  assert.equal(create({ enabled: false }).status().ready, false);
  assert.equal(create({ runtimeSafe: false }).capture({ phone: owner, text: 'RECHAZAR', messageId: '1' }).reason, 'misconfigured');
  assert.equal(create({ allowlist: [owner] }).status().ready, false);
  assert.equal(create({ managerPhone: '+57 300 000 0099' }).status().ready, false);
});

test('captura la secuencia propietario a gerente sin registrar telefonos ni texto libre', () => {
  const capture = create();
  const rejected = capture.capture({ phone: owner, text: 'RECHAZAR', messageId: 'wamid.owner.reject' });
  assert.deepEqual({ captured: rejected.captured, role: rejected.role, command: rejected.command, state: rejected.state }, {
    captured: true, role: 'propietario', command: 'reject', state: 'owner_rejected'
  });

  const verified = capture.capture({ phone: manager, text: 'AIRBNB BLOQUEADO', messageId: 'wamid.manager.verify' });
  assert.equal(verified.state, 'manager_airbnb_blocked');
  const approved = capture.capture({ phone: manager, text: 'APROBAR', messageId: 'wamid.manager.approve' });
  assert.equal(approved.state, 'manager_approved');
  assert.match(approved.message_id_fingerprint, /^[a-f0-9]{12}$/);
  assert.equal(Object.hasOwn(approved, 'phone'), false);
  assert.equal(Object.hasOwn(approved, 'text'), false);
});

test('rechaza rol incorrecto, secuencia invalida, texto libre y telefonos externos', () => {
  const capture = create();
  assert.equal(capture.capture({ phone: manager, text: 'RECHAZAR', messageId: '1' }).reason, 'wrong_role');
  assert.equal(capture.capture({ phone: manager, text: 'APROBAR', messageId: '2' }).reason, 'invalid_sequence');
  assert.equal(capture.capture({ phone: owner, text: 'hola', messageId: '3' }).reason, 'unsupported_command');
  assert.equal(capture.capture({ phone: '+57 300 000 0099', text: 'RECHAZAR', messageId: '4' }).reason, 'not_allowlisted');
});

test('deduplica mensajes y DETENER PRUEBA bloquea comandos posteriores', () => {
  const capture = create();
  const first = capture.capture({ phone: owner, text: 'RECHAZAR', messageId: 'same-id' });
  assert.equal(first.captured, true);
  assert.equal(capture.capture({ phone: owner, text: 'RECHAZAR', messageId: 'same-id' }).reason, 'duplicate');
  assert.equal(capture.capture({ phone: manager, text: 'DETENER PRUEBA', messageId: 'stop-id' }).state, 'stopped');
  assert.equal(capture.capture({ phone: manager, text: 'AIRBNB BLOQUEADO', messageId: 'later-id' }).reason, 'stopped');
});
