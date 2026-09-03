'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isNaturalPresentationEnabled, resolveNaturalPresentation } = require('../lib/pilot/m0-natural-presentation');

// Incremento D3.3 (2026-09-03): pruebas de la orquestacion completa con
// PilotAi.redact() y el validador de D3.2 MOCKEADOS -- ninguna llamada real
// a OpenAI ni a pms-lite en este archivo. `ai`/`pms` son objetos fabricados
// a mano por cada prueba, siguiendo exactamente el contrato real de
// PilotAi.redact() (lib/pilot/ai.js) y PmsPilotClient.validateAuthorizedResponse()
// (lib/pilot/pms-client.js -- ese metodo solo hace un POST HTTP hacia el
// endpoint real de pms-lite que envuelve D3.2, nunca reimplementa su logica).

function basePacket(overrides = {}) {
  return {
    facts: [], numbers: [], dates: [], apartments: [], action: 'RESPONDER INFORMACIÓN APROBADA',
    components: [], pending: [], required_disclosures: [], forbidden_claims: [], questions_to_ask: [],
    knowledge_sources: [], ui: { message_kind: 'text', photo_target_codes: [] },
    deterministic_text: 'texto determinístico de referencia', presentation_source: 'deterministic',
    ...overrides
  };
}

function countingAi(redactImpl) {
  let calls = 0;
  return { calls: () => calls, redact: async (args) => { calls += 1; return redactImpl(args); } };
}

function pmsReturning(result) {
  let calls = 0;
  return { calls: () => calls, validateAuthorizedResponse: async () => { calls += 1; return result; } };
}

test('isNaturalPresentationEnabled: default seguro OFF cuando la variable no existe', () => {
  assert.equal(isNaturalPresentationEnabled({}), false);
});

test('isNaturalPresentationEnabled: OFF para cualquier valor que no sea exactamente "true"', () => {
  for (const value of ['false', '0', 'no', 'TRUE ', ' true', 'yes', '']) {
    assert.equal(isNaturalPresentationEnabled({ M0_NATURAL_PRESENTATION_ENABLED: value }), value.trim().toLowerCase() === 'true');
  }
});

test('isNaturalPresentationEnabled: ON solo con "true" (case-insensitive, sin espacios extra en el valor)', () => {
  assert.equal(isNaturalPresentationEnabled({ M0_NATURAL_PRESENTATION_ENABLED: 'true' }), true);
  assert.equal(isNaturalPresentationEnabled({ M0_NATURAL_PRESENTATION_ENABLED: 'True' }), true);
});

test('bandera OFF: cero llamadas a IA ni al validador, texto exactamente igual al determinístico', async () => {
  const packet = basePacket({ deterministic_text: 'Todos los apartamentos comercializados tienen parqueadero.' });
  const ai = countingAi(async () => { throw new Error('no debería llamarse con la bandera OFF'); });
  const pms = pmsReturning({ valid: true, failure_reasons: [], meta: {} });
  const result = await resolveNaturalPresentation({ packet, phone: '570000000000', ai, pms, enabled: false });
  assert.equal(result.text, packet.deterministic_text);
  assert.equal(result.presentation_source, 'deterministic');
  assert.equal(result.attempted, false);
  assert.equal(ai.calls(), 0);
  assert.equal(pms.calls(), 0);
});

test('bandera OFF: sin packet (o sin deterministic_text) también se comporta como determinístico, sin llamadas', async () => {
  const ai = countingAi(async () => { throw new Error('no debería llamarse'); });
  const pms = pmsReturning({ valid: true, failure_reasons: [], meta: {} });
  const result = await resolveNaturalPresentation({ packet: null, phone: '570000000000', ai, pms, enabled: true });
  assert.equal(result.text, null);
  assert.equal(result.presentation_source, 'deterministic');
  assert.equal(ai.calls(), 0);
  assert.equal(pms.calls(), 0);
});

test('1. bandera ON, paráfrasis válida -> ai_validated', async () => {
  const packet = basePacket({ deterministic_text: 'Todos los apartamentos comercializados tienen parqueadero.' });
  const ai = countingAi(async () => ({ text: '¡Claro! Todos cuentan con parqueadero.', model: 'gpt-5.6-luna', latency_ms: 420 }));
  const pms = pmsReturning({ valid: true, failure_reasons: [], meta: {} });
  const result = await resolveNaturalPresentation({ packet, phone: '570000000000', ai, pms, enabled: true });
  assert.equal(result.presentation_source, 'ai_validated');
  assert.equal(result.text, '¡Claro! Todos cuentan con parqueadero.');
  assert.equal(result.attempted, true);
  assert.equal(result.model, 'gpt-5.6-luna');
  assert.equal(result.latency_ms, 420);
  assert.deepEqual(result.failure_reasons, []);
  assert.equal(ai.calls(), 1);
  assert.equal(pms.calls(), 1);
});

test('2. precio modificado -> fallback', async () => {
  const packet = basePacket({ numbers: [{ id: 'deposit', label: 'depósito', formatted: 'COP 600.000' }],
    deterministic_text: 'El depósito es de COP 600.000.' });
  const ai = countingAi(async () => ({ text: 'El depósito es de COP 500.000.', model: 'gpt-5.6-luna', latency_ms: 300 }));
  const pms = pmsReturning({ valid: false, failure_reasons: ['number_missing:deposit', 'unauthorized_number:COP 500.000'], meta: {} });
  const result = await resolveNaturalPresentation({ packet, phone: '570000000000', ai, pms, enabled: true });
  assert.equal(result.presentation_source, 'ai_fallback');
  assert.equal(result.text, packet.deterministic_text);
  assert.deepEqual(result.failure_reasons, ['number_missing:deposit', 'unauthorized_number:COP 500.000']);
});

test('3. depósito modificado -> fallback', async () => {
  const packet = basePacket({ numbers: [{ id: 'deposit', label: 'depósito', formatted: 'COP 600.000' }],
    deterministic_text: 'Depósito: COP 600.000.' });
  const ai = countingAi(async () => ({ text: 'Depósito: COP 650.000.', model: 'gpt-5.6-luna', latency_ms: 280 }));
  const pms = pmsReturning({ valid: false, failure_reasons: ['number_missing:deposit', 'unauthorized_number:COP 650.000'], meta: {} });
  const result = await resolveNaturalPresentation({ packet, phone: '570000000000', ai, pms, enabled: true });
  assert.equal(result.presentation_source, 'ai_fallback');
  assert.equal(result.text, packet.deterministic_text);
});

test('4. apartamento inventado -> fallback', async () => {
  const packet = basePacket({ apartments: ['LF-210'], deterministic_text: 'LF-210 tiene balcón.' });
  const ai = countingAi(async () => ({ text: 'LF-210 y también LF-999 tienen balcón.', model: 'gpt-5.6-luna', latency_ms: 310 }));
  const pms = pmsReturning({ valid: false, failure_reasons: ['apartment_not_authorized:LF-999'], meta: {} });
  const result = await resolveNaturalPresentation({ packet, phone: '570000000000', ai, pms, enabled: true });
  assert.equal(result.presentation_source, 'ai_fallback');
  assert.equal(result.text, packet.deterministic_text);
});

test('5. disclosure omitido -> fallback', async () => {
  const packet = basePacket({ pending: [{ topic: 'exception', reason: 'pendiente de decisión humana' }],
    required_disclosures: [{ id: 'exception_pending', text: 'Claro. Voy a pedir a José Manuel que revise tu solicitud y continúe contigo.' }],
    deterministic_text: 'Claro. Voy a pedir a José Manuel que revise tu solicitud y continúe contigo.' });
  const ai = countingAi(async () => ({ text: '¡Con gusto! Cuenta con la condición especial que pediste.', model: 'gpt-5.6-luna', latency_ms: 260 }));
  const pms = pmsReturning({ valid: false, failure_reasons: ['disclosure_missing:exception_pending', 'pending_signal_missing:exception'], meta: {} });
  const result = await resolveNaturalPresentation({ packet, phone: '570000000000', ai, pms, enabled: true });
  assert.equal(result.presentation_source, 'ai_fallback');
  assert.equal(result.text, packet.deterministic_text);
});

test('6. excepción convertida en aprobación -> fallback', async () => {
  const packet = basePacket({ pending: [{ topic: 'exception', reason: 'pendiente de decisión humana' }],
    forbidden_claims: ['excepcion_aprobada'],
    required_disclosures: [{ id: 'exception_pending', text: 'queda pendiente, sin confirmar todavía.' }],
    deterministic_text: 'Sobre lo demás que preguntaste, queda pendiente, sin confirmar todavía.' });
  const ai = countingAi(async () => ({ text: 'Listo, te hago el descuento especial que pediste.', model: 'gpt-5.6-luna', latency_ms: 290 }));
  const pms = pmsReturning({ valid: false, failure_reasons: ['forbidden_claim:excepcion_aprobada', 'disclosure_missing:exception_pending'], meta: {} });
  const result = await resolveNaturalPresentation({ packet, phone: '570000000000', ai, pms, enabled: true });
  assert.equal(result.presentation_source, 'ai_fallback');
  assert.equal(result.text, packet.deterministic_text);
});

test('7. pregunta obligatoria omitida -> fallback', async () => {
  const packet = basePacket({ questions_to_ask: [{ id: 'guests', text: '¿Para cuántas personas sería?' }],
    deterministic_text: '¿Para cuántas personas sería?' });
  const ai = countingAi(async () => ({ text: 'Listo, ya tengo todo lo que necesito.', model: 'gpt-5.6-luna', latency_ms: 240 }));
  const pms = pmsReturning({ valid: false, failure_reasons: ['missing_question'], meta: {} });
  const result = await resolveNaturalPresentation({ packet, phone: '570000000000', ai, pms, enabled: true });
  assert.equal(result.presentation_source, 'ai_fallback');
  assert.equal(result.text, packet.deterministic_text);
});

test('8. texto vacío/degenerado -> fallback, sin siquiera llamar al validador', async () => {
  const packet = basePacket({ deterministic_text: 'Todos los apartamentos comercializados tienen parqueadero.' });
  const ai = countingAi(async () => ({ text: '', model: 'gpt-5.6-luna', latency_ms: 150 }));
  const pms = pmsReturning({ valid: true, failure_reasons: [], meta: {} }); // no debería ni consultarse
  const result = await resolveNaturalPresentation({ packet, phone: '570000000000', ai, pms, enabled: true });
  assert.equal(result.presentation_source, 'ai_fallback');
  assert.equal(result.text, packet.deterministic_text);
  assert.equal(pms.calls(), 0, 'un candidato vacío se descarta antes de consultar al validador');
});

test('9a. timeout/error de red en redact() -> fallback (contrato real: PilotAi.redact() nunca lanza, devuelve _fallback)', async () => {
  const packet = basePacket({ deterministic_text: 'Todos los apartamentos comercializados tienen parqueadero.' });
  const ai = countingAi(async () => ({ text: null, _fallback: true, _error_code: 'ai_redaction_failed',
    _dependency: { status: null, code: 'ETIMEDOUT', type: 'timeout' }, model: 'gpt-5.6-luna', latency_ms: 20000 }));
  const pms = pmsReturning({ valid: true, failure_reasons: [], meta: {} });
  const result = await resolveNaturalPresentation({ packet, phone: '570000000000', ai, pms, enabled: true });
  assert.equal(result.presentation_source, 'ai_fallback');
  assert.equal(result.text, packet.deterministic_text);
  assert.equal(pms.calls(), 0);
});

test('9b. excepción inesperada lanzada por redact() (defensa adicional) -> fallback, nunca se propaga', async () => {
  const packet = basePacket({ deterministic_text: 'Todos los apartamentos comercializados tienen parqueadero.' });
  const ai = countingAi(async () => { throw new Error('unexpected_throw'); });
  const pms = pmsReturning({ valid: true, failure_reasons: [], meta: {} });
  const result = await resolveNaturalPresentation({ packet, phone: '570000000000', ai, pms, enabled: true });
  assert.equal(result.presentation_source, 'ai_fallback');
  assert.equal(result.text, packet.deterministic_text);
});

test('9c. excepción lanzada por el validador (fallo de red hacia pms-lite) -> fallback', async () => {
  const packet = basePacket({ deterministic_text: 'Todos los apartamentos comercializados tienen parqueadero.' });
  const ai = countingAi(async () => ({ text: 'Sí, todos tienen parqueadero.', model: 'gpt-5.6-luna', latency_ms: 200 }));
  const pms = { calls: () => 1, validateAuthorizedResponse: async () => { throw new Error('ECONNRESET'); } };
  const result = await resolveNaturalPresentation({ packet, phone: '570000000000', ai, pms, enabled: true });
  assert.equal(result.presentation_source, 'ai_fallback');
  assert.equal(result.text, packet.deterministic_text);
});

test('10. respuesta válida multicomponente (búsqueda + conocimiento + excepción) -> ai_validated', async () => {
  const packet = basePacket({
    facts: [{ topic: 'parking', text: 'Todos los apartamentos comercializados tienen parqueadero.' }],
    dates: [{ id: 'check_in', formatted: '2026-10-10' }, { id: 'check_out', formatted: '2027-01-08' }],
    apartments: ['LF-210'], components: ['search', 'knowledge', 'exception'],
    pending: [{ topic: 'exception', reason: 'pendiente de decisión humana' }],
    required_disclosures: [{ id: 'exception_pending', text: 'queda pendiente, sin confirmar todavía.' }],
    deterministic_text: 'LF-210 del 2026-10-10 al 2027-01-08. Todos los apartamentos comercializados tienen parqueadero.\n\nqueda pendiente, sin confirmar todavía.'
  });
  const candidateText = 'Del 2026-10-10 al 2027-01-08 en LF-210 sí tienen parqueadero. Sobre el resto, queda pendiente, sin confirmar todavía.';
  const ai = countingAi(async () => ({ text: candidateText, model: 'gpt-5.6-luna', latency_ms: 480 }));
  const pms = pmsReturning({ valid: true, failure_reasons: [], meta: {} });
  const result = await resolveNaturalPresentation({ packet, phone: '570000000000', ai, pms, enabled: true });
  assert.equal(result.presentation_source, 'ai_validated');
  assert.equal(result.text, candidateText);
});

test('11. conocimiento parcialmente resuelto -> el candidato aceptado conserva lo pendiente explícito', async () => {
  const packet = basePacket({
    facts: [{ topic: 'pets', text: 'Solo se aceptan mascotas pequeñas.' }],
    pending: [{ topic: 'cancellation', reason: 'sin fuente aprobada' }],
    required_disclosures: [{ id: 'knowledge_gap', text: 'No tengo una fuente aprobada suficiente para confirmar el resto. Voy a pedir a José Manuel que lo valide.' }],
    deterministic_text: 'Solo se aceptan mascotas pequeñas.\n\nNo tengo una fuente aprobada suficiente para confirmar el resto. Voy a pedir a José Manuel que lo valide.'
  });
  const candidateText = 'Sobre mascotas: solo las pequeñas. Y sobre cancelar: No tengo una fuente aprobada suficiente para confirmar el resto. Voy a pedir a José Manuel que lo valide.';
  const ai = countingAi(async () => ({ text: candidateText, model: 'gpt-5.6-luna', latency_ms: 350 }));
  const pms = pmsReturning({ valid: true, failure_reasons: [], meta: {} });
  const result = await resolveNaturalPresentation({ packet, phone: '570000000000', ai, pms, enabled: true });
  assert.equal(result.presentation_source, 'ai_validated');
  assert.match(result.text, /No tengo una fuente aprobada suficiente/);
});

test('12. Flow/UI permanece intacto -- resolveNaturalPresentation nunca lee ni muta packet.ui', async () => {
  const packet = basePacket({ questions_to_ask: [{ id: 'check_in', text: '¿Cuál es la fecha exacta de llegada, incluyendo el año?' }],
    ui: { message_kind: 'flow', photo_target_codes: [] },
    deterministic_text: 'Toca el botón de abajo para indicarme tu fecha de llegada, tu fecha de salida (o el plan que prefieras) y cuántas personas serían.' });
  const uiSnapshot = JSON.stringify(packet.ui);
  const ai = countingAi(async () => ({ text: '¿Me confirmas la fecha de llegada, con el año?', model: 'gpt-5.6-luna', latency_ms: 220 }));
  const pms = pmsReturning({ valid: true, failure_reasons: [], meta: {} });
  const result = await resolveNaturalPresentation({ packet, phone: '570000000000', ai, pms, enabled: true });
  assert.equal(result.presentation_source, 'ai_validated');
  assert.equal(JSON.stringify(packet.ui), uiSnapshot, 'ui no debe mutarse');
  assert.ok(!('ui' in result), 'resolveNaturalPresentation no devuelve ni decide nada sobre ui -- eso sigue siendo responsabilidad exclusiva de deliver()');
});

test('LIMITACIÓN CONOCIDA (heredada de D3.2, no resuelta aquí): una inversión semántica todavía puede pasar como ai_validated', async () => {
  // Mismo caso que la prueba 18 de tests/m0-response-validator.test.js en
  // pms-lite: D3.2 no entiende significado, asi que un candidato que invierte
  // un hecho binario ("si" -> "no") sin tocar ningun numero/fecha/apartamento/
  // disclosure/pending pasa la validacion. Se documenta aqui explicitamente
  // para que D3.3 NUNCA se use como argumento de que la inversion/negacion ya
  // esta resuelta -- sigue reservada para D3.4, sin excepcion.
  const packet = basePacket({
    facts: [{ topic: 'parking', text: 'Sí, todos los apartamentos comercializados tienen parqueadero.' }],
    deterministic_text: 'Sí, todos los apartamentos comercializados tienen parqueadero.'
  });
  const invertedText = 'No, ningún apartamento tiene parqueadero disponible.';
  const ai = countingAi(async () => ({ text: invertedText, model: 'gpt-5.6-luna', latency_ms: 300 }));
  // Refleja fielmente lo que la implementacion REAL de validateAuthorizedResponse
  // (pms-lite, D3.2) devuelve para este mismo texto -- ver esa prueba 18.
  const pms = pmsReturning({ valid: true, failure_reasons: [],
    meta: { semantic_check: { performed: false, note: 'D3.2 no detecta inversión/negación de hechos binarios -- reservado para D3.4.' } } });
  const result = await resolveNaturalPresentation({ packet, phone: '570000000000', ai, pms, enabled: true });
  assert.equal(result.presentation_source, 'ai_validated');
  assert.equal(result.text, invertedText);
});

test('nunca reintenta una segunda generación tras un candidato rechazado', async () => {
  const packet = basePacket({ numbers: [{ id: 'deposit', label: 'depósito', formatted: 'COP 600.000' }],
    deterministic_text: 'Depósito: COP 600.000.' });
  const ai = countingAi(async () => ({ text: 'Depósito: COP 700.000.', model: 'gpt-5.6-luna', latency_ms: 300 }));
  const pms = pmsReturning({ valid: false, failure_reasons: ['number_missing:deposit'], meta: {} });
  await resolveNaturalPresentation({ packet, phone: '570000000000', ai, pms, enabled: true });
  assert.equal(ai.calls(), 1, 'una sola llamada a redact(), nunca un segundo intento automático');
});

test('costo/latencia: con la bandera ON se hace como máximo una llamada a IA y una al validador; con OFF, cero', async () => {
  const packet = basePacket({ deterministic_text: 'texto de referencia.' });
  const ai = countingAi(async () => ({ text: 'texto redactado.', model: 'gpt-5.6-luna', latency_ms: 500 }));
  const pms = pmsReturning({ valid: true, failure_reasons: [], meta: {} });
  const onResult = await resolveNaturalPresentation({ packet, phone: '570000000000', ai, pms, enabled: true });
  assert.equal(ai.calls(), 1);
  assert.equal(pms.calls(), 1);
  assert.equal(onResult.latency_ms, 500);
  const ai2 = countingAi(async () => ({ text: 'no debería llamarse', model: 'gpt-5.6-luna', latency_ms: 1 }));
  const pms2 = pmsReturning({ valid: true, failure_reasons: [], meta: {} });
  await resolveNaturalPresentation({ packet, phone: '570000000000', ai: ai2, pms: pms2, enabled: false });
  assert.equal(ai2.calls(), 0);
  assert.equal(pms2.calls(), 0);
});
