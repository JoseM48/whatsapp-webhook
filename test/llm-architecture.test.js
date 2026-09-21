'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildConversationContext, needsSummaryRefresh } = require('../lib/pilot/llm/context-builder.js');
const { toolsForModel, isReadTool, ACTION_NAMES } = require('../lib/pilot/llm/tools.js');
const { runToolLoop } = require('../lib/pilot/llm/tool-runner.js');
const { projectToLegacyInterpretation } = require('../lib/pilot/llm/interpretation-schema-v2.js');
const { evaluateConfirmationNeed, resolveConfirmation, actionIsBlocked, STATUS }
  = require('../lib/pilot/llm/semantic-confirmation.js');
const { AnthropicProvider, OpenAiProvider, LlmError, stripUnsupported,
  ANTHROPIC_UNSUPPORTED_SCHEMA_KEYS } = require('../lib/pilot/llm/provider.js');
const { createFakePms } = require('../harness/fake-pms.js');

// --------------------------------------------------------------------------
// Contexto conversacional
// --------------------------------------------------------------------------
test('el contexto incluye los turnos recientes -- que es lo que hoy falta', () => {
  const { context, meta } = buildConversationContext({
    today: '2026-10-05',
    commercialContext: { guests: 2 },
    transcript: [
      { role: 'guest', text: 'Hola', at: '2026-10-05T10:00:00Z' },
      { role: 'cami', text: 'Hola, soy Cami', at: '2026-10-05T10:00:05Z' },
      { role: 'guest', text: 'busco apartamento', at: '2026-10-05T10:01:00Z' }
    ]
  });
  assert.equal(context.recent_turns.length, 3);
  assert.equal(context.recent_turns[2].text, 'busco apartamento');
  assert.equal(meta.turns_available, 3);
});

test('la ventana recorta lo ANTIGUO, nunca el turno actual', () => {
  const transcript = Array.from({ length: 20 }, (_, i) => ({ role: 'guest', text: `mensaje ${i}`, at: `2026-10-05T10:${String(i).padStart(2, '0')}:00Z` }));
  const { context } = buildConversationContext({ today: '2026-10-05', transcript }, { windowTurns: 6 });
  assert.equal(context.recent_turns.length, 6);
  assert.equal(context.recent_turns[5].text, 'mensaje 19');
});

test('el contexto NO crece con la conversacion', () => {
  const short = buildConversationContext({ today: '2026-10-05', transcript: Array.from({ length: 6 }, () => ({ role: 'guest', text: 'x'.repeat(100) })) });
  const long = buildConversationContext({ today: '2026-10-05', transcript: Array.from({ length: 300 }, () => ({ role: 'guest', text: 'x'.repeat(100) })) });
  assert.ok(long.meta.estimated_tokens <= short.meta.estimated_tokens * 1.2,
    'una conversacion de 300 turnos no puede costar mas que una de 6');
});

test('PII: correos y telefonos se redactan en TODOS los turnos, no solo el ultimo', () => {
  const { context } = buildConversationContext({
    today: '2026-10-05',
    transcript: [
      { role: 'guest', text: 'escribeme a juan@example.com' },
      { role: 'guest', text: 'o al +57 300 1234567' }
    ]
  });
  assert.ok(!context.recent_turns[0].text.includes('@example.com'));
  assert.ok(context.recent_turns[1].text.includes('[phone-redacted]'));
});

test('el contexto nunca lleva identificadores internos al modelo', () => {
  const { context } = buildConversationContext({
    today: '2026-10-05',
    commercialContext: { guests: 2, phone_hash: 'A'.repeat(64), lead_id: 99, content_version_id: 42 }
  });
  assert.equal(context.known.guests, 2);
  assert.ok(!('phone_hash' in context.known));
  assert.ok(!('lead_id' in context.known));
  assert.ok(!('content_version_id' in context.known));
});

test('el resumen se regenera solo cuando algo sale de la ventana', () => {
  assert.equal(needsSummaryRefresh({ transcript: new Array(4).fill({ role: 'guest', text: 'x' }) }), false);
  assert.equal(needsSummaryRefresh({ transcript: new Array(10).fill({ role: 'guest', text: 'x' }), olderSummary: null }), true);
  assert.equal(needsSummaryRefresh({ transcript: new Array(10).fill({ role: 'guest', text: 'x' }), olderSummary: { text: 'r', covers_turns: 4 } }), false);
});

// --------------------------------------------------------------------------
// Separacion READ / ACTION
// --------------------------------------------------------------------------
test('ninguna ACTION COMMAND viaja jamas a la API', () => {
  const exposed = toolsForModel().map((t) => t.name);
  for (const action of ACTION_NAMES) assert.ok(!exposed.includes(action), `${action} no debe exponerse`);
  assert.ok(exposed.includes('resolve_apartment_reference'));
});

test('prepare_pre_reservation no es una read tool', () => {
  assert.equal(isReadTool('prepare_pre_reservation'), false);
  assert.equal(isReadTool('check_availability'), true);
});

// --------------------------------------------------------------------------
// Lazo de tools
// --------------------------------------------------------------------------
function providerStub(script) {
  let turn = 0;
  return { structured: async () => script[Math.min(turn++, script.length - 1)] };
}

test('el lazo ejecuta una tool y devuelve la salida final', async () => {
  const pms = createFakePms();
  const result = await runToolLoop({
    provider: providerStub([
      { output: null, tool_calls: [{ id: 't1', name: 'resolve_apartment_reference', arguments: { raw: 'el 210', hint_type: 'number_fragment', hint_value: '210' }, _raw: {} }], usage: {}, meta: {} },
      { output: { intent: 'lodging_search' }, tool_calls: [], usage: { input_tokens: 10, output_tokens: 5 }, meta: {} }
    ]),
    system: 's', input: 'i', executor: pms.execute, logger: { warn() {}, info() {} }
  });
  assert.equal(result.output.intent, 'lodging_search');
  assert.equal(result.trace.length, 1);
  assert.equal(result.trace[0].status, 'ok');
});

test('el lazo BLOQUEA una action command pedida por el modelo y sigue', async () => {
  const pms = createFakePms();
  const result = await runToolLoop({
    provider: providerStub([
      { output: null, tool_calls: [{ id: 't1', name: 'prepare_pre_reservation', arguments: {}, _raw: {} }], usage: {}, meta: {} },
      { output: { intent: 'other' }, tool_calls: [], usage: {}, meta: {} }
    ]),
    system: 's', input: 'i', executor: pms.execute, logger: { warn() {}, info() {} }
  });
  assert.equal(result.trace[0].status, 'not_authorized');
  assert.equal(pms.calls.length, 0, 'la action no debe llegar nunca al PMS');
  assert.equal(result.output.intent, 'other');
});

test('el lazo tiene tope de iteraciones y no se cuelga', async () => {
  const pms = createFakePms();
  const result = await runToolLoop({
    provider: providerStub([{ output: null, tool_calls: [{ id: 't', name: 'get_current_proposal', arguments: {}, _raw: {} }], usage: {}, meta: {} }]),
    system: 's', input: 'i', executor: pms.execute, maxIterations: 3, logger: { warn() {}, info() {} }
  });
  assert.equal(result.stop_reason, 'max_iterations_exceeded');
  assert.equal(result.output, null, 'sin respuesta final no se inventa una');
  assert.equal(result.iterations, 3);
});

test('una tool que revienta no rompe el turno', async () => {
  const result = await runToolLoop({
    provider: providerStub([
      { output: null, tool_calls: [{ id: 't1', name: 'check_availability', arguments: {}, _raw: {} }], usage: {}, meta: {} },
      { output: { intent: 'unknown' }, tool_calls: [], usage: {}, meta: {} }
    ]),
    system: 's', input: 'i',
    executor: async () => { throw new Error('boom'); },
    logger: { warn() {}, info() {} }
  });
  assert.equal(result.trace[0].status, 'error');
  assert.equal(result.output.intent, 'unknown');
});

// --------------------------------------------------------------------------
// Schema V2 -> proyeccion legacy
// --------------------------------------------------------------------------
const v2Base = {
  intent: 'lodging_search', language: 'es',
  stay: {
    arrival: { kind: 'exact', date: '2026-10-10', precision: 'day', confidence: 0.95 },
    duration: { nights: 30, kind: 'exact', confidence: 0.9 },
    guests: { total: 2, adults: 2, children: 0, infants: 0, confidence: 0.9 }
  },
  references: [], budget: { amount_cop: null, period: 'absent' },
  preferences: [], requirements: [], knowledge_topics: [], corrections: [],
  ambiguity: [], unmapped_meaning: null,
  requests_human: false, exception_request: false, suggests_confirmation: false
};

test('la proyeccion a legacy conserva lo que pms-lite ya entiende', () => {
  const legacy = projectToLegacyInterpretation(v2Base);
  assert.equal(legacy.check_in, '2026-10-10');
  assert.equal(legacy.check_in_status, 'valid');
  assert.equal(legacy.nights, 30);
  assert.equal(legacy.guests, 2);
  assert.deepEqual(legacy.missing_fields, []);
});

test('una llegada aproximada se proyecta como ambigua, no como valida', () => {
  const legacy = projectToLegacyInterpretation({ ...v2Base,
    stay: { ...v2Base.stay, arrival: { kind: 'approximate', date: '2026-10-01', precision: 'month', confidence: 0.4 } } });
  assert.equal(legacy.check_in_status, 'ambiguous');
  assert.ok(legacy.missing_fields.includes('check_in'));
});

test('el schema V2 SI puede representar "un mes, tal vez mas"', () => {
  const v2 = { ...v2Base, stay: { ...v2Base.stay, duration: { nights: 30, kind: 'minimum', confidence: 0.85 } } };
  assert.equal(v2.stay.duration.kind, 'minimum');
  assert.equal(projectToLegacyInterpretation(v2)._v2.stay.duration.kind, 'minimum');
});

test('el significado no mapeable se conserva en vez de descartarse', () => {
  const legacy = projectToLegacyInterpretation({ ...v2Base, unmapped_meaning: 'viaja con mascota de servicio' });
  assert.equal(legacy._v2.unmapped_meaning, 'viaja con mascota de servicio');
});

// --------------------------------------------------------------------------
// Confirmacion semantica
// --------------------------------------------------------------------------
test('una conversacion normal NO pide confirmacion', () => {
  const e = evaluateConfirmationNeed(v2Base, {}, {});
  assert.equal(e.required, false);
});

test('antes de una accion economica la confirmacion es OBLIGATORIA', () => {
  const e = evaluateConfirmationNeed(v2Base, {}, { pendingAction: 'prepare_pre_reservation' });
  assert.equal(e.required, true);
  assert.ok(e.triggers.includes('before_action'));
});

test('confianza baja en un campo que mueve dinero dispara confirmacion', () => {
  const e = evaluateConfirmationNeed({ ...v2Base,
    stay: { ...v2Base.stay, duration: { nights: 90, kind: 'exact', confidence: 0.4 } } }, {}, {});
  assert.ok(e.triggers.includes('low_confidence'));
  assert.ok(e.fields.includes('duration'));
});

test('cambiar la duracion CON propuesta vigente dispara confirmacion', () => {
  const e = evaluateConfirmationNeed({ ...v2Base, corrections: ['duration'] },
    { proposal_snapshot: { proposals: [{ apartment_code: 'LF-210' }] } }, {});
  assert.ok(e.triggers.includes('price_affecting_change'));
});

test('la sugerencia del modelo se registra pero NO decide', () => {
  const e = evaluateConfirmationNeed({ ...v2Base, suggests_confirmation: true }, {}, {});
  assert.equal(e.required, false, 'solo las reglas deterministas disparan');
  assert.equal(e.model_suggested, true, 'pero queda registrada para poder medirla');
});

test('un "si" resuelve la confirmacion y desbloquea la accion', () => {
  const r = resolveConfirmation({ status: STATUS.AWAITING, snapshot: {} }, v2Base, { affirmative: true });
  assert.equal(r.outcome, STATUS.CONFIRMED);
  assert.equal(r.blocks_action, false);
});

test('una correccion actualiza el estado y MANTIENE la accion bloqueada', () => {
  const r = resolveConfirmation({ status: STATUS.AWAITING, snapshot: {} },
    { ...v2Base, corrections: ['duration'] }, { affirmative: null });
  assert.equal(r.outcome, STATUS.CORRECTED);
  assert.equal(r.blocks_action, true);
});

test('el silencio NO se interpreta como confirmacion', () => {
  const r = resolveConfirmation({ status: STATUS.AWAITING, snapshot: {} }, v2Base, { affirmative: null });
  assert.equal(r.outcome, STATUS.AMBIGUOUS);
  assert.equal(r.blocks_action, true);
});

test('con una confirmacion abierta, ninguna accion economica sale', () => {
  assert.equal(actionIsBlocked({ status: STATUS.AWAITING }), true);
  assert.equal(actionIsBlocked({ status: STATUS.CONFIRMED }), false);
  assert.equal(actionIsBlocked(null), false);
});

// --------------------------------------------------------------------------
// Provider adapter
// --------------------------------------------------------------------------
test('Anthropic recibe el schema sin las claves que rechaza', () => {
  const clean = stripUnsupported({ type: 'array', maxItems: 3, items: { type: 'string', maxLength: 10 } },
    ANTHROPIC_UNSUPPORTED_SCHEMA_KEYS);
  assert.ok(!('maxItems' in clean));
  assert.ok(!('maxLength' in clean.items));
  assert.equal(clean.type, 'array');
});

test('el adapter normaliza la salida de Anthropic al contrato unico', async () => {
  const provider = new AnthropicProvider({ model: 'claude-sonnet-5', client: {
    messages: { create: async () => ({ content: [{ type: 'text', text: '{"intent":"greeting"}' }],
      usage: { input_tokens: 11, output_tokens: 3 }, stop_reason: 'end_turn' }) }
  } });
  const r = await provider.structured({ schema: { type: 'object' }, system: 's', input: 'i' });
  assert.equal(r.output.intent, 'greeting');
  assert.equal(r.usage.input_tokens, 11);
  assert.equal(r.meta.provider, 'anthropic');
  assert.ok(typeof r.meta.latency_ms === 'number');
});

test('el adapter normaliza tool_use de Anthropic', async () => {
  const provider = new AnthropicProvider({ client: {
    messages: { create: async () => ({ content: [{ type: 'tool_use', id: 'tu_1', name: 'quote_stay', input: { nights: 30 } }], usage: {} }) }
  } });
  const r = await provider.structured({ system: 's', input: 'i' });
  assert.equal(r.tool_calls.length, 1);
  assert.equal(r.tool_calls[0].name, 'quote_stay');
  assert.equal(r.tool_calls[0].arguments.nights, 30);
});

test('un error de proveedor se normaliza y distingue lo reintentable', async () => {
  const provider = new AnthropicProvider({ client: {
    messages: { create: async () => { const e = new Error('rate'); e.status = 429; e.type = 'rate_limit_error'; throw e; } }
  } });
  await assert.rejects(() => provider.structured({ system: 's', input: 'i' }), (error) => {
    assert.ok(error instanceof LlmError);
    assert.equal(error.retryable, true);
    assert.equal(error.status, 429);
    return true;
  });
});

test('un 400 por schema invalido NO se marca reintentable', async () => {
  const provider = new AnthropicProvider({ client: {
    messages: { create: async () => { const e = new Error('bad'); e.status = 400; e.type = 'invalid_request_error'; throw e; } }
  } });
  await assert.rejects(() => provider.structured({ system: 's', input: 'i' }),
    (error) => error.retryable === false);
});

test('OpenAI normaliza al MISMO contrato que Anthropic', async () => {
  const provider = new OpenAiProvider({ apiKey: 'test-key', http: {
    post: async () => ({ data: { output: [{ type: 'message', content: [{ type: 'output_text', text: '{"intent":"greeting"}' }] }],
      usage: { input_tokens: 7, output_tokens: 2 }, status: 'completed' } })
  } });
  const r = await provider.structured({ schema: { type: 'object' }, system: 's', input: 'i' });
  assert.equal(r.output.intent, 'greeting');
  assert.equal(r.meta.provider, 'openai');
  assert.equal(r.usage.input_tokens, 7);
});

test('el timeout es parte del contrato en ambos proveedores', async () => {
  const provider = new AnthropicProvider({ client: {
    messages: { create: (_req, opts) => new Promise((_resolve, reject) => {
      opts.signal.addEventListener('abort', () => reject(new Error('aborted')));
    }) }
  } });
  await assert.rejects(() => provider.structured({ system: 's', input: 'i', timeoutMs: 40 }),
    (error) => error.code === 'llm_timeout' && error.retryable === true);
});
