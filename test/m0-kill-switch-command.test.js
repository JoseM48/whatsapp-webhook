'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveM0ControlCommand } = require('../lib/pilot/m0-kill-switch-command');

test('solo el teléfono gerente resuelve la frase exacta de pausa', () => {
  const base = { enabled: true, phone: '573000001111', managerPhone: '+57 300 000 1111',
    messageId: 'wamid-control-001', occurredAt: '2026-08-24T18:00:00.000Z' };
  const pause = resolveM0ControlCommand({ ...base, text: '  detener   piloto m0 ' });
  assert.deepEqual({ state: pause.state, reason_code: pause.reason_code },
    { state: 'paused', reason_code: 'OPERATOR_WHATSAPP_STOP' });
  assert.match(pause.command_id, /^m0-whatsapp-[a-f0-9]{32}$/);
  assert.match(pause.source_event_hash, /^[A-F0-9]{64}$/);
  assert.equal(pause.source_type, 'meta_admin_message');
  assert.equal(pause.occurred_at, base.occurredAt);
  assert.equal(resolveM0ControlCommand({ ...base, phone: '573000009999', text: 'DETENER PILOTO M0' }), null);
  assert.equal(resolveM0ControlCommand({ ...base, text: 'DETENER PILOTO' }), null);
  assert.equal(resolveM0ControlCommand({ ...base, text: 'REANUDAR PILOTO M0' }), null);
});

test('el id del comando es determinista para deduplicar reintentos Meta', () => {
  const input = { enabled: true, phone: '573000001111', managerPhone: '573000001111',
    text: 'DETENER PILOTO M0', messageId: 'wamid-control-002', occurredAt: '2026-08-24T18:00:00.000Z' };
  assert.equal(resolveM0ControlCommand(input).command_id, resolveM0ControlCommand(input).command_id);
  assert.equal(resolveM0ControlCommand(input).source_event_hash, resolveM0ControlCommand(input).source_event_hash);
});
