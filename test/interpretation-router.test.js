'use strict';

// Enrutador de interpretacion y ejecutor real -- BLOQUE C, secciones F/G/H.
//
// Dos cosas se prueban con mas insistencia que el resto:
//   1. que TODA duda termine en legacy;
//   2. que lo devuelto no lleve ni una clave de mas, porque
//      publicInterpretation() reenvia al PMS todo lo que no sea `_fallback`,
//      `_error_code` o `_dependency`.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createInterpretationRouter, PMS_INTERPRETATION_FIELDS } = require('../lib/pilot/llm/interpretation-router.js');
const { createPmsToolExecutor } = require('../lib/pilot/llm/pms-executor.js');

const TEST_PHONE = '573146892662';
const ON = { NEW_LLM_CONVERSATIONAL_ROUTE_ENABLED: 'true',
  NEW_LLM_CONVERSATIONAL_ROUTE_PHONES: TEST_PHONE };

const silencio = { log() {}, warn() {}, error() {} };

function legacySpy(result = { language: 'es', _fallback: false }) {
  const calls = [];
  return {
    calls,
    interpret: async (args) => { calls.push(args); return result; },
    present: async () => ({}), redact: async () => ({}), structured: async () => ({})
  };
}

// Proveedor que responde sin pedir tools: basta para el contrato del enrutador.
function providerThatAnswers(output) {
  return { name: 'openai', model: 'modelo-de-prueba',
    structured: async () => ({ output, tool_calls: [], usage: { input_tokens: 1, output_tokens: 1 } }) };
}

const V2_MINIMO = {
  intent: 'search', language: 'es',
  stay: {
    arrival: { kind: 'exact', date: '2026-10-15', precision: 'day', confidence: 0.9 },
    duration: { nights: 90, kind: 'exact', confidence: 0.9 },
    guests: { total: 2, confidence: 0.9 }
  },
  references: [], budget: { amount_cop: null, period: 'absent' },
  preferences: [], requirements: [], knowledge_topics: [], corrections: [],
  ambiguity: [], unmapped_meaning: [], requests_human: false, exception_request: false
};

test('con la ruta apagada, contesta la legacy y no se toca el proveedor', async () => {
  const legacy = legacySpy();
  const provider = { name: 'openai', structured: async () => { throw new Error('no debe llamarse'); } };
  const router = createInterpretationRouter({ legacyAi: legacy, provider, pmsClient: {}, env: {}, logger: silencio });

  await router.interpret({ text: 'hola', phone: TEST_PHONE, today: '2026-09-22', context: {} });
  assert.equal(legacy.calls.length, 1);
});

test('un telefono fuera de la lista va a legacy aunque la ruta este encendida', async () => {
  const legacy = legacySpy();
  const provider = { name: 'openai', structured: async () => { throw new Error('no debe llamarse'); } };
  const router = createInterpretationRouter({ legacyAi: legacy, provider, pmsClient: {}, env: ON, logger: silencio });

  await router.interpret({ text: 'hola', phone: '573001112233', today: '2026-09-22', context: {} });
  assert.equal(legacy.calls.length, 1);
});

test('con el telefono autorizado, interpreta por la ruta nueva', async () => {
  const legacy = legacySpy();
  const router = createInterpretationRouter({ legacyAi: legacy, provider: providerThatAnswers(V2_MINIMO),
    pmsClient: { conversationalTool: async () => ({ status: 'ok' }) }, env: ON, logger: silencio });

  const out = await router.interpret({ text: 'tres meses desde el 15 de octubre',
    phone: TEST_PHONE, today: '2026-09-22', context: {} });

  assert.equal(legacy.calls.length, 0, 'la legacy no debe intervenir');
  assert.equal(out.nights, 90);
  assert.equal(out.guests, 2);
  assert.equal(out._fallback, false);
});

test('no devuelve NI UNA clave que no devuelva tambien la legacy', async () => {
  const router = createInterpretationRouter({ legacyAi: legacySpy(), provider: providerThatAnswers(V2_MINIMO),
    pmsClient: { conversationalTool: async () => ({ status: 'ok' }) }, env: ON, logger: silencio });

  const out = await router.interpret({ text: 'hola', phone: TEST_PHONE, today: '2026-09-22', context: {} });

  // Trazas, uso, v2 y confirmacion son observabilidad: van al log. Si
  // aparecieran aqui, viajarian al PMS como si fueran interpretacion.
  for (const prohibida of ['tool_trace', 'usage', 'v2', 'shadow', 'confirmation',
    'context_meta', 'iterations', 'latency_ms', 'ok']) {
    assert.ok(!(prohibida in out), `no debe viajar al PMS: ${prohibida}`);
  }
});

test('si el proveedor falla, responde la legacy y el huesped no se entera', async () => {
  const legacy = legacySpy();
  const provider = { name: 'openai', structured: async () => { throw Object.assign(new Error('boom'), { code: 'timeout' }); } };
  const router = createInterpretationRouter({ legacyAi: legacy, provider,
    pmsClient: { conversationalTool: async () => ({ status: 'ok' }) }, env: ON, logger: silencio });

  await router.interpret({ text: 'hola', phone: TEST_PHONE, today: '2026-09-22', context: {} });
  assert.equal(legacy.calls.length, 1);
});

test('si el proveedor no esta configurado, responde la legacy', async () => {
  const legacy = legacySpy();
  const router = createInterpretationRouter({ legacyAi: legacy, provider: null,
    pmsClient: {}, env: ON, logger: silencio });

  await router.interpret({ text: 'hola', phone: TEST_PHONE, today: '2026-09-22', context: {} });
  assert.equal(legacy.calls.length, 1);
});

test('sin instancia legacy no arranca: es un fallo de arranque, no de un turno', () => {
  assert.throws(() => createInterpretationRouter({ legacyAi: null, provider: null, pmsClient: {} }),
    /legacy_ai_required/);
});

// --- ejecutor real ---------------------------------------------------------

test('el ejecutor rechaza una action command sin tocar la red', async () => {
  let llamado = false;
  const executor = createPmsToolExecutor({
    pmsClient: { conversationalTool: async () => { llamado = true; return { status: 'ok' }; } },
    logger: silencio
  });

  const r = await executor('prepare_pre_reservation', {});
  assert.equal(r.status, 'not_authorized');
  assert.equal(llamado, false, 'no debe salir un solo paquete');
});

test('el ejecutor pasa el contexto del llamante, no el del modelo', async () => {
  let visto = null;
  const executor = createPmsToolExecutor({
    pmsClient: { conversationalTool: async (tool, args, context) => { visto = { tool, args, context }; return { status: 'ok' }; } },
    context: { as_of: '2026-09-22' }, logger: silencio
  });

  // El modelo intenta colar su propio `as_of` como argumento.
  await executor('quote_stay', { nights: 90, as_of: '2030-01-01' });
  assert.equal(visto.context.as_of, '2026-09-22');
  assert.equal(visto.tool, 'quote_stay');
});

test('un cliente sin puente no arranca', () => {
  assert.throws(() => createPmsToolExecutor({ pmsClient: {} }),
    /pms_client_without_conversational_bridge/);
});

// EL CONTRATO CON pms-lite, atado a su fuente.
//
// commercialInterpretationSchema es `.strict()`: una clave de mas rechaza el
// turno entero con 400. projectToLegacyInterpretation() adjunta `_v2` para
// observabilidad y publicInterpretation() no lo retira, asi que sin el filtro
// el PRIMER mensaje del telefono de prueba habria sido rechazado.
//
// Esta prueba lee el esquema del PMS en el disco. Si alguien cambia alli el
// contrato, falla aqui -- que es exactamente lo que debe pasar.
test('lo devuelto encaja EXACTAMENTE con el esquema estricto del PMS', async () => {
  const fs = require('node:fs');
  const ruta = 'D:/DESARROLLOS/_WORKTREES/llm-pms/src/modules/supervised-pilot/m0-closed-pilot.service.js';
  if (!fs.existsSync(ruta)) return; // el checkout del PMS puede no estar presente

  const fuente = fs.readFileSync(ruta, 'utf8');
  const desde = fuente.indexOf('const commercialInterpretationSchema');
  const bloque = fuente.slice(desde, fuente.indexOf('}).strict()', desde));
  const declarados = [];
  const patron = /([a-z_]+)\s*:\s*z\./g;
  let encontrado;
  while ((encontrado = patron.exec(bloque)) !== null) declarados.push(encontrado[1]);

  assert.deepEqual(declarados.slice().sort(), PMS_INTERPRETATION_FIELDS.slice().sort(),
    'la lista del enrutador se desincronizo del esquema real del PMS');

  const router = createInterpretationRouter({ legacyAi: legacySpy(), provider: providerThatAnswers(V2_MINIMO),
    pmsClient: { conversationalTool: async () => ({ status: 'ok' }) }, env: ON, logger: silencio });
  const out = await router.interpret({ text: 'hola', phone: TEST_PHONE, today: '2026-09-22', context: {} });

  const sobran = Object.keys(out).filter((k) => !PMS_INTERPRETATION_FIELDS.includes(k)
    && !['_fallback', '_error_code', '_dependency'].includes(k));
  assert.deepEqual(sobran, [], 'estas claves harian que el PMS rechace el turno');
});
