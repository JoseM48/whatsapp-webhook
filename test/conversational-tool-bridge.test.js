'use strict';

// Puente de read tools, lado webhook -- BLOQUE C.
//
// Se prueba el contrato del cliente: que degrade en vez de tumbar el turno,
// que no invente un esquema de autenticacion, y que un intento de action
// command quede visible en la respuesta en vez de perderse.

const test = require('node:test');
const assert = require('node:assert/strict');
const { PmsPilotClient } = require('../lib/pilot/pms-client.js');

function clientWith(postImpl, extra = {}) {
  return new PmsPilotClient({
    http: { post: postImpl }, baseUrl: 'https://pms.test', inboundUrl: 'https://pms.test/in',
    secret: 's', conversationalToolsToken: 'tok', ...extra
  });
}

test('sin token configurado degrada, NO lanza', async () => {
  const client = clientWith(async () => { throw new Error('no deberia llamarse'); },
    { conversationalToolsToken: '' });
  const result = await client.conversationalTool('get_policy', { policy_key: 'x' });
  assert.equal(result.status, 'not_authorized');
  assert.equal(result.reason, 'conversational_tools_not_configured');
});

test('usa Bearer token, no la firma HMAC del resto de llamadas', async () => {
  let seen = null;
  const client = clientWith(async (_url, _body, options) => {
    seen = options.headers;
    return { data: { status: 'ok', data: {} } };
  });
  await client.conversationalTool('get_policy', { policy_key: 'duration_tier_v1' });
  assert.equal(seen.Authorization, 'Bearer tok');
  assert.ok(!seen['X-PMS-Signature'], 'este endpoint no usa firma HMAC');
});

test('pega en la ruta del puente y envia tool/arguments/context', async () => {
  let url = null; let body = null;
  const client = clientWith(async (u, b) => { url = u; body = b; return { data: { status: 'ok' } }; });
  await client.conversationalTool('check_availability', { nights: 30 }, { lead_id: 7 });
  assert.equal(url, 'https://pms.test/internal/conversational-tool');
  assert.equal(body.tool, 'check_availability');
  assert.equal(body.arguments.nights, 30);
  assert.equal(body.context.lead_id, 7);
});

test('tiene timeout propio y mas corto que el general', async () => {
  let timeout = null;
  const client = clientWith(async (_u, _b, options) => { timeout = options.timeout; return { data: {} }; });
  await client.conversationalTool('get_policy', {});
  assert.equal(timeout, 6000);
  assert.ok(timeout < 8000, 'mas corto que el general: esta llamada ocurre dentro del lazo de tools');
});

test('un 403 del puente se propaga como intento de action command, visible en la traza', async () => {
  const client = clientWith(async () => {
    const error = new Error('forbidden');
    error.response = { status: 403, data: { status: 'not_authorized' } };
    throw error;
  });
  const result = await client.conversationalTool('prepare_pre_reservation', {});
  assert.equal(result.status, 'not_authorized');
  assert.equal(result.reason, 'action_command_not_exposed_over_http');
});

test('un fallo de red devuelve contrato de error, no rompe el turno', async () => {
  const client = clientWith(async () => { throw Object.assign(new Error('boom'), { code: 'ECONNABORTED' }); });
  const result = await client.conversationalTool('quote_stay', { nights: 30 });
  assert.equal(result.status, 'error');
  assert.equal(result.reason, 'ECONNABORTED');
});

test('un 401 devuelve el cuerpo del servidor tal cual, sin enmascararlo', async () => {
  const client = clientWith(async () => {
    const error = new Error('unauthorized');
    error.response = { status: 401, data: { error: 'conversational_tools_token_invalid' } };
    throw error;
  });
  const result = await client.conversationalTool('get_policy', {});
  assert.equal(result.error, 'conversational_tools_token_invalid');
});
