'use strict';

// OBJECION DE PRECIO (decision de Jose Manuel, 2026-10-05, punto 6). El webhook
// solo marca la senal `price_objection` y extrae el presupuesto; el PMS decide
// (preguntar presupuesto, escalar a Jose Manuel o responder con el "desde").

const test = require('node:test');
const assert = require('node:assert/strict');
const { interpretationSchemaV2, projectToLegacyInterpretation } = require('../lib/pilot/llm/interpretation-schema-v2.js');
const { PMS_INTERPRETATION_FIELDS } = require('../lib/pilot/llm/interpretation-router.js');
const { interpretationSchema, deterministicInterpret, reconcileInterpretation } = require('../lib/pilot/ai.js');
const { SYSTEM_PROMPT } = require('../lib/pilot/llm/conversational-engine.js');
const { WRITER_SYSTEM_PROMPT } = require('../lib/pilot/llm/writer.js');

const V2 = {
  intent: 'other', language: 'es',
  stay: { arrival: { kind: 'none', date: null }, duration: { kind: 'none', nights: null }, guests: { total: null } },
  references: [], budget: { amount_cop: null, period: 'absent' }, preferences: [], requirements: [],
  knowledge_topics: [], corrections: [], ambiguity: [], unmapped_meaning: null,
  requests_human: false, exception_request: false, cancellation_request: false, payment_reported: false,
  price_objection: false, visitors_question: false, suggests_confirmation: false
};

test('esquema v2: price_objection es booleano y obligatorio (el modelo siempre lo decide)', () => {
  assert.deepEqual(interpretationSchemaV2.properties.price_objection, { type: 'boolean' });
  assert.ok(interpretationSchemaV2.required.includes('price_objection'));
});

test('proyeccion: la senal y el presupuesto llegan al PMS', () => {
  const out = projectToLegacyInterpretation({ ...V2, price_objection: true, budget: { amount_cop: 2800000, period: 'monthly' } });
  assert.equal(out.price_objection, true);
  assert.equal(out.budget_cop, 2800000);
  assert.equal(out.budget_period, 'monthly');
  assert.ok(out.provided_fields.includes('budget'));
  assert.equal(projectToLegacyInterpretation(V2).price_objection, false);
});

test('router: price_objection viaja al PMS (lista explicita)', () => {
  assert.ok(PMS_INTERPRETATION_FIELDS.includes('price_objection'));
  const out = projectToLegacyInterpretation({ ...V2, price_objection: true });
  const sobran = Object.keys(out).filter((k) => !PMS_INTERPRETATION_FIELDS.includes(k) && !k.startsWith('_'));
  assert.deepEqual(sobran, []);
});

test('ruta legada: esquema sincronizado y senal determinista', () => {
  assert.deepEqual(interpretationSchema.properties.price_objection, { type: 'boolean' });
  assert.ok(interpretationSchema.required.includes('price_objection'));
  const today = '2026-10-05';
  for (const t of ['Uy, está muy caro', 'Es muy costoso para mí', 'Se sale de mi presupuesto', 'fuera de mi presupuesto', 'No me alcanza']) {
    assert.equal(deterministicInterpret(t, { today }).price_objection, true, t);
  }
  for (const t of ['¿Cuánto cuesta el 210?', 'Hola, busco apartamento', 'Quiero ver fotos', '¿Cuál es el más barato?']) {
    assert.equal(deterministicInterpret(t, { today }).price_objection, false, t);
  }
  assert.equal(reconcileInterpretation('ok', { price_objection: true }, { today }).price_objection, true);
  assert.equal(reconcileInterpretation('ok', {}, { today }).price_objection, false);
});

test('prompt del interprete: regla de objecion de precio y presupuesto esperado', () => {
  assert.match(SYSTEM_PROMPT, /PRICE OBJECTION: set price_objection/);
  assert.match(SYSTEM_PROMPT, /awaiting_budget/);
  assert.match(SYSTEM_PROMPT, /not exception_request/);
});

test('prompt del redactor: los cinco desenlaces, sin numeros ni descuentos', () => {
  for (const accion of ['PREGUNTAR PRESUPUESTO', 'EVALUAR MEJOR OFERTA', 'PRESUPUESTO POR DEBAJO', 'MEJOR OFERTA EN REVISIÓN', 'PRECIO DESDE']) {
    assert.ok(WRITER_SYSTEM_PROMPT.includes(`"${accion}"`), accion);
  }
  assert.match(WRITER_SYSTEM_PROMPT, /never offer or hint at a discount/);
  assert.match(WRITER_SYSTEM_PROMPT, /write NO numbers at all/);
  assert.match(WRITER_SYSTEM_PROMPT, /never say you will keep their contact/);
});
