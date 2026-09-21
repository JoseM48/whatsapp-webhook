'use strict';

// BLOQUE C1/C2 -- pruebas de regresion del timeout y la observabilidad.
//
// Existen porque hasta el 2026-09-21 la llamada al LLM en produccion no tenia
// NINGUN timeout: una llamada lenta dejaba el turno colgado en vez de degradar
// al parser determinista. Si alguien lo vuelve a quitar, esto lo atrapa.

const test = require('node:test');
const assert = require('node:assert/strict');
const { PilotAi } = require('../lib/pilot/ai.js');

function hangingClient() {
  return {
    messages: {
      create: (_request, options) => new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => {
          const error = new Error('Request was aborted.');
          error.name = 'AbortError';
          reject(error);
        });
      })
    }
  };
}

test('una llamada colgada aborta al vencer el timeout', async () => {
  const ai = new PilotAi({ client: hangingClient(), timeoutMs: 50 });
  await assert.rejects(() => ai.structured({ schema: { type: 'object' }, system: 's', input: 'i' }),
    (error) => {
      assert.match(error.message, /anthropic_timeout_after_50ms/);
      assert.equal(error.status, 408, 'status 408 para que safeDependencyError lo clasifique');
      return true;
    });
});

test('el timeout degrada interpret() al parser determinista, no rompe el turno', async () => {
  const ai = new PilotAi({ client: hangingClient(), timeoutMs: 50 });
  const result = await ai.interpret({ text: 'Somos dos personas', phone: '57300', today: '2026-10-05', context: {} });
  assert.equal(result._fallback, true, 'cae a fallback, no lanza');
  assert.equal(result._error_code, 'ai_interpretation_fallback');
  assert.equal(result.guests, 2, 'el parser determinista sigue funcionando como red de seguridad');
});

test('el timeout tiene default explicito, nunca queda ausente', () => {
  const previous = process.env.PILOT_LLM_TIMEOUT_MS;
  delete process.env.PILOT_LLM_TIMEOUT_MS;
  const ai = new PilotAi({ client: {} });
  assert.equal(ai.timeoutMs, 20000, 'mismo valor que tenia el adaptador de OpenAI antes de la migracion');
  if (previous !== undefined) process.env.PILOT_LLM_TIMEOUT_MS = previous;
});

test('el timeout es configurable por variable de entorno', () => {
  const previous = process.env.PILOT_LLM_TIMEOUT_MS;
  process.env.PILOT_LLM_TIMEOUT_MS = '12345';
  const ai = new PilotAi({ client: {} });
  assert.equal(ai.timeoutMs, 12345);
  if (previous === undefined) delete process.env.PILOT_LLM_TIMEOUT_MS;
  else process.env.PILOT_LLM_TIMEOUT_MS = previous;
});

test('una llamada normal registra proveedor, modelo, tokens y latencia', async () => {
  const ai = new PilotAi({ timeoutMs: 5000, client: {
    messages: { create: async () => ({ content: [{ type: 'text', text: '{"ok":true}' }],
      usage: { input_tokens: 42, output_tokens: 7 } }) }
  } });
  const out = await ai.structured({ schema: { type: 'object' }, system: 's', input: 'i' });
  assert.equal(out.ok, true);
  assert.equal(ai.lastUsage.provider, 'anthropic');
  assert.equal(ai.lastUsage.input_tokens, 42);
  assert.equal(ai.lastUsage.output_tokens, 7);
  assert.ok(typeof ai.lastUsage.latency_ms === 'number');
});

test('la observabilidad NUNCA guarda texto del huesped ni del modelo', async () => {
  const ai = new PilotAi({ timeoutMs: 5000, client: {
    messages: { create: async () => ({ content: [{ type: 'text', text: '{"secreto":"dato sensible del huesped"}' }],
      usage: { input_tokens: 1, output_tokens: 1 } }) }
  } });
  await ai.structured({ schema: { type: 'object' }, system: 's', input: 'mensaje privado del huesped' });
  const serialized = JSON.stringify(ai.lastUsage);
  assert.ok(!serialized.includes('privado'));
  assert.ok(!serialized.includes('sensible'));
});

test('el timeout NO introduce reintentos: una sola generacion sigue siendo la regla', async () => {
  let calls = 0;
  const ai = new PilotAi({ timeoutMs: 50, client: {
    messages: { create: (_r, options) => { calls += 1; return new Promise((_res, rej) => {
      options.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }); } }
  } });
  await ai.interpret({ text: 'hola', phone: '57300', today: '2026-10-05', context: {} });
  assert.equal(calls, 1, 'exactamente una llamada, sin reintento');
});
