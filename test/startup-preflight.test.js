'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { runStartupPreflight } = require('../lib/pilot/startup-preflight');

test('preflight de arranque prueba HTTPS, HMAC y deduplicacion sin outbound ni IA', async () => {
  const calls = [];
  const interaction = { id: 'interaction-synthetic' };
  const pms = {
    capture: async (body) => {
      calls.push(['capture', body]);
      return calls.filter(([type]) => type === 'capture').length === 1
        ? { interaction, created_interaction: true, deduplicated: false }
        : { interaction, created_interaction: false, deduplicated: true };
    },
    retryableProcessing: async (limit) => {
      calls.push(['processing', limit]);
      return [];
    },
    retryableOutbound: async (limit) => {
      calls.push(['outbound-recovery', limit]);
      return [];
    }
  };
  const http = {
    get: async (url) => {
      calls.push(['health', new URL(url).pathname]);
      return { status: 200, data: { service: 'pms-lite' } };
    }
  };

  const result = await runStartupPreflight({
    http,
    pms,
    baseUrl: 'https://pms-preflight.invalid',
    now: () => 1784822000000
  });

  const captures = calls.filter(([type]) => type === 'capture');
  assert.equal(captures.length, 2);
  assert.equal(captures[0][1].external_message_id, captures[1][1].external_message_id);
  assert.equal(calls.some(([type]) => type === 'send'), false);
  assert.equal(calls.some(([type]) => type === 'openai'), false);
  assert.deepEqual(result, {
    ok: true,
    https_status: 200,
    hmac_recovery_ok: true,
    first_capture_created: true,
    duplicate_controlled: true,
    same_interaction: true,
    outbound_attempts: 0,
    openai_calls: 0
  });
});

test('preflight falla cerrado si el origen no es HTTPS', async () => {
  await assert.rejects(
    runStartupPreflight({
      http: {},
      pms: {},
      baseUrl: 'http://127.0.0.1:3040'
    }),
    { code: 'preflight_https_required' }
  );
});
