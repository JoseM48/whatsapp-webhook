'use strict';

// PRE-CONFIRMACION (decision de Jose Manuel, 2026-10-05, tarde). El webhook
// solo marca `accepts_offer` ("si", "confirmo", "dale") y le pasa al redactor la
// frase de presentacion y las unidades que van despues de las libres. El PMS
// decide todo lo demas (que oferta esta abierta, precio, retencion).

const test = require('node:test');
const assert = require('node:assert/strict');
const { interpretationSchemaV2, projectToLegacyInterpretation } = require('../lib/pilot/llm/interpretation-schema-v2.js');
const { PMS_INTERPRETATION_FIELDS } = require('../lib/pilot/llm/interpretation-router.js');
const { interpretationSchema, deterministicInterpret, reconcileInterpretation } = require('../lib/pilot/ai.js');
const { SYSTEM_PROMPT } = require('../lib/pilot/llm/conversational-engine.js');
const { WRITER_SYSTEM_PROMPT, writerViewOfPacket } = require('../lib/pilot/llm/writer.js');

const V2 = {
  intent: 'other', language: 'es',
  stay: { arrival: { kind: 'none', date: null }, duration: { kind: 'none', nights: null }, guests: { total: null } },
  references: [], budget: { amount_cop: null, period: 'absent' }, preferences: [], requirements: [],
  knowledge_topics: [], corrections: [], ambiguity: [], unmapped_meaning: null,
  requests_human: false, exception_request: false, cancellation_request: false, payment_reported: false,
  price_objection: false, accepts_offer: false, visitors_question: false, suggests_confirmation: false
};

test('esquema v2: accepts_offer es booleano y obligatorio; la proyeccion lo lleva al PMS', () => {
  assert.deepEqual(interpretationSchemaV2.properties.accepts_offer, { type: 'boolean' });
  assert.ok(interpretationSchemaV2.required.includes('accepts_offer'));
  assert.equal(projectToLegacyInterpretation({ ...V2, accepts_offer: true }).accepts_offer, true);
  assert.equal(projectToLegacyInterpretation(V2).accepts_offer, false);
  assert.ok(PMS_INTERPRETATION_FIELDS.includes('accepts_offer'));
  const out = projectToLegacyInterpretation({ ...V2, accepts_offer: true });
  assert.deepEqual(Object.keys(out).filter((k) => !PMS_INTERPRETATION_FIELDS.includes(k) && !k.startsWith('_')), []);
});

test('ruta legada: esquema sincronizado y "si" corto determinista', () => {
  assert.deepEqual(interpretationSchema.properties.accepts_offer, { type: 'boolean' });
  assert.ok(interpretationSchema.required.includes('accepts_offer'));
  const today = '2026-10-05';
  for (const t of ['Sí', 'Si, confirmo', 'Confirmo', 'Dale', 'Lo tomo', 'Listo, reconfirmo']) {
    assert.equal(deterministicInterpret(t, { today }).accepts_offer, true, t);
  }
  for (const t of ['¿Sí incluye limpieza?', 'No, gracias', 'Lo pienso y te aviso', 'Busco apartamento para 2 personas desde el 5 de noviembre por un mes']) {
    assert.equal(deterministicInterpret(t, { today }).accepts_offer, false, t);
  }
  assert.equal(reconcileInterpretation('vale', { accepts_offer: true }, { today }).accepts_offer, true);
  assert.equal(reconcileInterpretation('vale', {}, { today }).accepts_offer, false);
});

test('prompt del interprete: regla ACCEPTS OFFER', () => {
  assert.match(SYSTEM_PROMPT, /ACCEPTS OFFER \(decision 2026-10-05\): set accepts_offer/);
  assert.match(SYSTEM_PROMPT, /is NOT accepts_offer/);
});

test('redactor: frase de presentacion y unidades despues de las libres llegan a la vista del paquete', () => {
  const packet = { presentation: { mode: 'candidates', min: 3, max: 3, phrase: 'Estas son tres de las opciones que tenemos',
    candidates: [{ code: 'LF-210', bookable_now: true, options: [] }, { code: 'LF-404', bookable_now: true, options: [], premium: true }] } };
  const v = writerViewOfPacket(packet);
  assert.equal(v.presentation.phrase, 'Estas son tres de las opciones que tenemos');
  assert.equal(v.presentation.candidates[1].after_free_options, true);
  assert.equal('after_free_options' in v.presentation.candidates[0], false);
  // Sin datos nuevos (PMS con la politica apagada) la vista no cambia.
  const sin = writerViewOfPacket({ presentation: { mode: 'candidates', min: 1, max: 2,
    candidates: [{ code: 'LF-210', bookable_now: true, options: [] }] } });
  assert.equal('phrase' in sin.presentation, false);
  assert.equal('after_free_options' in sin.presentation.candidates[0], false);
});

test('prompt del redactor: pre-confirmacion, frase, orden y nada de desplazamiento', () => {
  assert.match(WRITER_SYSTEM_PROMPT, /PRE-CONFIRMATION \(decision 2026-10-05\)/);
  assert.match(WRITER_SYSTEM_PROMPT, /after_free_options=true must be presented only AFTER/);
  assert.match(WRITER_SYSTEM_PROMPT, /"PRE-CONFIRMACIÓN"/);
  assert.match(WRITER_SYSTEM_PROMPT, /Never mention other guests who might take it/);
  assert.match(WRITER_SYSTEM_PROMPT, /15 days before arrival/);
});
