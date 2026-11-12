'use strict';

// USO ACEPTABLE (José Manuel, 2026-10-24; PMS uso_aceptable_v1, migración 930).
// El modelo clasifica el pedido (chat y nota de voz: campo acceptable_use de la
// interpretación; llamada: herramienta evaluar_uso_aceptable) y el PMS decide.
// Aquí: el contrato del campo, que "permitido" no viaje, la nota de voz marcada
// como tal y la instrucción con los casos de la política.

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

// El SDK de Anthropic no está instalado en todos los checkouts (por eso fallan
// los archivos de la línea base que cargan ai.js): un doble mínimo basta para
// probar el esquema y la reconciliación, que no llaman a la API.
const resolverOriginal = Module._resolveFilename;
Module._resolveFilename = function resolver(request, ...rest) {
  if (request === '@anthropic-ai/sdk') return '@anthropic-ai/sdk';
  return resolverOriginal.call(this, request, ...rest);
};
require.cache['@anthropic-ai/sdk'] = { id: '@anthropic-ai/sdk', filename: '@anthropic-ai/sdk', loaded: true, exports: class AnthropicFalso {} };

const ua = require('../lib/pilot/uso-aceptable');
const { interpretationSchema, reconcileInterpretation } = require('../lib/pilot/ai');
const { interpretationSchemaV2, projectToLegacyInterpretation } = require('../lib/pilot/llm/interpretation-schema-v2');
const { SYSTEM_PROMPT } = require('../lib/pilot/llm/conversational-engine');
const { createM0CommercialResponder, publicInterpretation } = require('../lib/pilot/m0-commercial-responder');

test('el campo acceptable_use es obligatorio en los dos esquemas del chat', () => {
  for (const s of [interpretationSchema, interpretationSchemaV2]) {
    assert.ok(s.required.includes('acceptable_use'));
    assert.deepEqual(s.properties.acceptable_use.properties.decision.enum, ['permitido', 'restringido', 'prohibido']);
    assert.ok(s.properties.acceptable_use.properties.category.enum.includes('ninguna'));
  }
  assert.ok(SYSTEM_PROMPT.includes('ACCEPTABLE USE'));
});

test('normalizar: permitido no viaja; categorías inválidas van al genérico; el resumen no lleva teléfonos ni correos', () => {
  assert.equal(ua.normalizarUsoAceptable({ decision: 'permitido', category: 'ninguna', summary: null }), null);
  assert.equal(ua.normalizarUsoAceptable(null), null);
  assert.equal(ua.normalizarUsoAceptable({ decision: 'quizas' }), null);
  assert.deepEqual(ua.normalizarUsoAceptable({ decision: 'prohibido', category: 'inventada', summary: 'x' }),
    { decision: 'prohibido', category: 'otro_prohibido', summary: 'x' });
  assert.equal(ua.normalizarUsoAceptable({ decision: 'restringido', category: 'ninguna', summary: null }).category, 'otro_restringido');
  const r = ua.normalizarUsoAceptable({ decision: 'prohibido', category: 'armas_explosivos',
    summary: 'Pide conseguir una pistola, llamar al +57 300 000 0001 o escribir a x@y.co' }, { canal: 'nota_voz' });
  assert.equal(r.canal, 'nota_voz');
  assert.doesNotMatch(r.summary, /300|x@y\.co/);
});

test('reconciliación (ruta legacy): el campo del modelo pasa normalizado y el permitido se cae en publicInterpretation', () => {
  const r = reconcileInterpretation('Necesito un préstamo de 5 millones', { acceptable_use: { decision: 'restringido',
    category: 'credito_servicios_financieros', summary: 'Pide un préstamo' } }, { today: '2026-10-24' });
  assert.deepEqual(r.acceptable_use, { decision: 'restringido', category: 'credito_servicios_financieros', summary: 'Pide un préstamo' });
  const p = reconcileInterpretation('Busco apartamento del 1 al 30 de noviembre', { acceptable_use: { decision: 'permitido',
    category: 'ninguna', summary: null } }, { today: '2026-10-24' });
  assert.equal(p.acceptable_use, null);
  assert.equal('acceptable_use' in publicInterpretation(p), false, 'un PMS anterior (esquema estricto) no conoce la clave');
  assert.equal(publicInterpretation(r).acceptable_use.decision, 'restringido');
});

test('proyección V2: solo viaja si no es permitido', () => {
  const base = { intent: 'other', language: 'es', stay: { arrival: { kind: 'none' }, duration: {}, guests: {} } };
  assert.equal('acceptable_use' in projectToLegacyInterpretation({ ...base, acceptable_use: { decision: 'permitido', category: 'ninguna', summary: null } }), false);
  const p = projectToLegacyInterpretation({ ...base, acceptable_use: { decision: 'prohibido', category: 'medicamentos_formula', summary: 'Pide conseguir un medicamento con fórmula' } });
  assert.equal(p.acceptable_use.decision, 'prohibido');
  assert.equal(p.acceptable_use.category, 'medicamentos_formula');
});

test('nota de voz: el turno transcrito llega al PMS marcado canal nota_voz (chat por defecto)', async () => {
  const enviados = [];
  const responder = createM0CommercialResponder({
    capture: async () => ({}), pms: {}, logger: { info() {}, warn() {}, error() {} },
    ai: { async interpret() { return { intent: 'other', acceptable_use: { decision: 'prohibido', category: 'armas_explosivos', summary: 'Pide un arma' } }; } },
    closedPilot: { async completeCommercial(body) { enviados.push(body); return { deliveries: [] }; } }
  });
  await responder.processCaptured({ from: '573000000001', text: 'consígueme un revólver', messageId: 'wamid.UA1', today: '2026-10-24', canal: 'nota_voz' });
  await responder.processCaptured({ from: '573000000001', text: 'consígueme un revólver', messageId: 'wamid.UA2', today: '2026-10-24' });
  assert.equal(enviados[0].interpretation.acceptable_use.canal, 'nota_voz');
  assert.equal(enviados[1].interpretation.acceptable_use.canal, 'chat');
});

// Los casos que pidió José Manuel (2026-10-24), según lo verificado en la
// Resolución 0001 de 2015 del CNE: la soda cáustica SÍ está en el listado
// (uso masivo, registro en SICOQ), así que el jabón con soda cáustica es
// restringido; el ácido sulfónico (LABSA) y el hipoclorito no están.
test('la instrucción del modelo cubre los casos de la política (chat y voz)', () => {
  const chat = ua.INSTRUCCION_CHAT;
  for (const [patron, categoria] of [[/caustic soda/, 'quimicos_controlados'], [/firearms/, 'armas_explosivos'],
    [/loans, credit/, 'credito_servicios_financieros'], [/plumbing/, null], [/prescription or controlled medicines/, 'medicamentos_formula'],
    [/job postings/, 'empleo']]) {
    assert.match(chat, patron);
    if (categoria) assert.ok(chat.includes(`(${categoria})`) || chat.includes(categoria), categoria);
  }
  assert.match(chat, /soap, detergent or cleaning products when they mention caustic soda/);
  assert.match(chat, /LABSA or hypochlorite, which are not on the list/);
  assert.match(ua.INSTRUCCION_VOZ, /jabón o detergente con soda cáustica/);
  assert.match(ua.INSTRUCCION_VOZ, /NO ejecutes el pedido/);
  // Cada categoría nombrada en la instrucción del chat existe en el enum.
  for (const c of [...ua.CATEGORIAS_PROHIBIDAS, ...ua.CATEGORIAS_RESTRINGIDAS]) assert.ok(chat.includes(c), `falta ${c} en la instrucción`);
});

test('ruta conversacional: el filtro de campos del enrutador deja pasar acceptable_use solo si no es permitido', () => {
  const { PMS_INTERPRETATION_FIELDS } = require('../lib/pilot/llm/interpretation-router');
  assert.ok(PMS_INTERPRETATION_FIELDS.includes('acceptable_use'));
});
