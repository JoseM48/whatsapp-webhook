'use strict';

// CATEGORÍAS DE CLIENTE (José Manuel, 2026-11-12; PMS migración 1440): a un VIP
// no se le cobra early check-in ni late check-out. Paridad (dominio 25): el chat
// pasa los beneficios del PMS a get_policy; la llamada no menciona cobro.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createInterpretationRouter } = require('../lib/pilot/llm/interpretation-router.js');
const { lineasSalidaVoz } = require('../lib/voz/cami-voz.js');

const TEST_PHONE = '573146892662';
const ON = { NEW_LLM_CONVERSATIONAL_ROUTE_ENABLED: 'true', NEW_LLM_CONVERSATIONAL_ROUTE_PHONES: TEST_PHONE };
const silencio = { log() {}, warn() {}, error() {} };
const V2_MINIMO = {
  intent: 'search', language: 'es',
  stay: { arrival: { kind: 'exact', date: '2026-10-15', precision: 'day', confidence: 0.9 },
    duration: { nights: 90, kind: 'exact', confidence: 0.9 }, guests: { total: 2, confidence: 0.9 } },
  references: [], budget: { amount_cop: null, period: 'absent' },
  preferences: [], requirements: [], knowledge_topics: [], corrections: [],
  ambiguity: [], unmapped_meaning: [], requests_human: false, exception_request: false
};
const legacy = { interpret: async () => ({ language: 'es', _fallback: false }), present: async () => ({}), redact: async () => ({}), structured: async () => ({}) };

test('chat: los beneficios_estadia del PMS viajan en el contexto de get_policy (no los pone el modelo)', async () => {
  const vistos = [];
  let n = 0;
  const provider = { name: 'openai', model: 'm', structured: async () => (++n === 1
    ? { output: null, tool_calls: [{ id: 't1', name: 'get_policy', arguments: { policy_key: 'salida_late_checkout_v1', beneficios_estadia: { sin_cobro_late: false } }, _raw: {} }], usage: {}, meta: {} }
    : { output: V2_MINIMO, tool_calls: [], usage: { input_tokens: 1, output_tokens: 1 } }) };
  const router = createInterpretationRouter({ legacyAi: legacy, provider,
    pmsClient: { conversationalTool: async (tool, args, context) => { vistos.push({ tool, context }); return { status: 'ok', data: {} }; } },
    env: ON, logger: silencio });
  const b = { sin_cobro_early: true, sin_cobro_late: true, regla: 'x' };
  await router.interpret({ text: 'y el late?', phone: TEST_PHONE, today: '2026-11-12', context: { beneficios_estadia: b } });
  assert.equal(vistos[0].tool, 'get_policy');
  assert.deepEqual(vistos[0].context, { as_of: '2026-11-12', proposal_snapshot: null, beneficios_estadia: b });
  // Sin beneficios: el contexto de siempre (sin la clave).
  vistos.length = 0; n = 0;
  await router.interpret({ text: 'y el late?', phone: TEST_PHONE, today: '2026-11-12', context: {} });
  assert.deepEqual(vistos[0].context, { as_of: '2026-11-12', proposal_snapshot: null });
});

test('llamada: a quien no se le cobra early/late no se le dice que se cobran; nunca se nombra la categoría', () => {
  const base = { regla: 'La salida es a más tardar a las 11:00 a. m.', late_checkout_habilitado: true, early_checkin_habilitado: true };
  const normal = lineasSalidaVoz({ ...base, cobra_late_checkout: true, cobra_early_checkin: true }).join('\n');
  assert.match(normal, /se cobran y puedes decir su valor/);
  assert.match(normal, /opción con costo sujeta a disponibilidad/);
  assert.doesNotMatch(normal, /NO se le cobra/);
  // PMS viejo (sin las banderas): igual que siempre.
  assert.equal(lineasSalidaVoz(base).join('\n'), normal);
  const vip = lineasSalidaVoz({ ...base, cobra_late_checkout: false, cobra_early_checkin: false }).join('\n');
  assert.match(vip, /A esta persona NO se le cobra el early check-in y el late check-out/);
  assert.match(vip, /nunca menciones cobro, precio ni pago/);
  assert.match(vip, /no le digas que tiene una categoría ni un trato especial/);
  assert.match(vip, /SIEMPRE sujeto a disponibilidad/);
  assert.doesNotMatch(vip, /VIP/);
  assert.match(vip, /opción sujeta a disponibilidad/);
  assert.doesNotMatch(vip, /opción con costo/);
  const sinHerramienta = lineasSalidaVoz({ ...base, cobra_late_checkout: false, cobra_early_checkin: false }, false).join('\n');
  assert.doesNotMatch(sinHerramienta, /le llega el cobro/);
});
