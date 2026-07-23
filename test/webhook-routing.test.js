'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseAllowlist } = require('../lib/pilot/security');
const { selectWebhookRoute } = require('../lib/pilot/webhook-routing');

const quarantineAllowlist = parseAllowlist('3000000001,+573000000002');
const pilotAllowlist = parseAllowlist('3000000001,+573000000002');

function route(overrides = {}) {
  return selectWebhookRoute({
    phone: '+57 300 000 0001',
    pmsEnabled: false,
    mvpEnabled: false,
    quarantineAllowlist,
    pilotAllowlist,
    ...overrides
  });
}

test('cuarentena un telefono autorizado cuando el piloto esta apagado', () => {
  assert.deepEqual(route(), {
    action: 'quarantine',
    status: 200,
    reason: 'pilot_disabled'
  });
});

test('cuarentena si cualquiera de las dos banderas permanece apagada', () => {
  assert.equal(route({ pmsEnabled: true, mvpEnabled: false }).action, 'quarantine');
  assert.equal(route({ pmsEnabled: false, mvpEnabled: true }).action, 'quarantine');
});

test('un reintento recibe nuevamente 200 sin desviarse al flujo heredado', () => {
  const attempts = [
    route(),
    route()
  ];
  assert.equal(attempts.every((result) => result.action === 'quarantine'), true);
  assert.equal(attempts.every((result) => result.status === 200), true);
  assert.equal(attempts.some((result) => result.action === 'legacy'), false);
});

test('preserva la ruta piloto que delega deduplicacion a PMS Lite', () => {
  const result = route({ pmsEnabled: true, mvpEnabled: true });
  assert.equal(result.action, 'pilot');
  assert.equal(result.status, null);
});

test('preserva el flujo heredado para telefonos fuera de la allowlist', () => {
  const result = route({
    phone: '+57 300 000 0099',
    pmsEnabled: false,
    mvpEnabled: false
  });
  assert.equal(result.action, 'legacy');
});
