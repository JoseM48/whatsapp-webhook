'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PilotAi, deterministicInterpret, deterministicPresentation, minimizeUserText, parseDayOrdinal } = require('../lib/pilot/ai');

test('fallback interpreta consulta completa en español', () => {
  const parsed = deterministicInterpret('Busco del 2026-08-01 al 2026-08-05 para 2 personas, prefiero balcón');
  assert.equal(parsed.check_in, '2026-08-01');
  assert.equal(parsed.check_out, '2026-08-05');
  assert.equal(parsed.guests, 2);
  assert.deepEqual(parsed.preferences, ['balcony']);
  assert.deepEqual(parsed.missing_fields, []);
  assert.equal(parsed.check_in_status, 'valid');
  assert.equal(parsed.check_out_status, 'valid');
  assert.equal(parsed.check_in_source, 'user_explicit');
});

test('minimiza correo y teléfono antes de enviar texto a IA', () => {
  const minimized = minimizeUserText('Escríbeme a prueba@example.com o +57 300 000 0000');
  assert.doesNotMatch(minimized, /prueba@example\.com|300 000 0000/);
  assert.match(minimized, /\[email-redacted\]|\[phone-redacted\]/);
});

test('conserva fechas ISO al minimizar datos sensibles', () => {
  const minimized = minimizeUserText('Del 2026-08-01 al 2026-08-05 para 2 personas');
  assert.match(minimized, /2026-08-01/);
  assert.match(minimized, /2026-08-05/);
});

test('fallback detecta datos obligatorios faltantes e inglés', () => {
  const parsed = deterministicInterpret('Hello, I need an apartment with air conditioning');
  assert.equal(parsed.language, 'en');
  assert.deepEqual(parsed.missing_fields, ['check_in', 'check_out_or_nights', 'guests']);
});

test('marca una fecha calendario invalida sin aceptarla', () => {
  const parsed = deterministicInterpret('Busco del 2026-02-30 al 2026-03-04 para 2 personas');
  assert.equal(parsed.check_in, null);
  assert.equal(parsed.check_in_status, 'invalid');
  assert.equal(parsed.check_out, '2026-03-04');
  assert.deepEqual(parsed.missing_fields, ['check_in']);
});

test('marca fechas ambiguas para aclaracion', () => {
  const parsed = deterministicInterpret('Busco del 01/08/2026 al 05/08/2026 para 2 personas');
  assert.equal(parsed.check_in_status, 'ambiguous');
  assert.equal(parsed.check_out_status, 'ambiguous');
  assert.equal(parsed.needs_clarification, true);
});

test('un mes sin dias exactos obliga a aclarar la estadia', () => {
  const parsed = deterministicInterpret('Hola, estoy buscando un alojamiento para dos personas en septiembre', {
    today: '2026-08-27'
  });
  assert.equal(parsed.check_in, null);
  assert.equal(parsed.check_out, null);
  assert.equal(parsed.check_in_status, 'ambiguous');
  assert.equal(parsed.check_out_status, 'absent');
  assert.equal(parsed.guests, 2);
  assert.equal(parsed.needs_clarification, true);
  assert.deepEqual(parsed.missing_fields, ['check_in', 'check_out_or_nights']);
});

test('normaliza fechas con barras solo cuando el orden es inequivoco', () => {
  const parsed = deterministicInterpret('Busco del 15/08/2026 al 18/08/2026 para 2 personas');
  assert.equal(parsed.check_in, '2026-08-15');
  assert.equal(parsed.check_out, '2026-08-18');
  assert.equal(parsed.check_in_status, 'valid');
  assert.equal(parsed.check_out_status, 'valid');
  assert.deepEqual(parsed.missing_fields, []);
});

test('interpreta fechas naturales explicitas en español', () => {
  const explicit = deterministicInterpret(
    'Busco del 15 de agosto de 2026 al 18 de agosto de 2026 para 2 personas'
  );
  assert.equal(explicit.check_in, '2026-08-15');
  assert.equal(explicit.check_out, '2026-08-18');

  const compact = deterministicInterpret('Busco del 15 al 18 de agosto de 2026 para 2 personas');
  assert.equal(compact.check_in, '2026-08-15');
  assert.equal(compact.check_out, '2026-08-18');
});

test('reconoce "primero" y ordinales abreviados como día del mes', () => {
  assert.equal(parseDayOrdinal('primero'), 1);
  assert.equal(parseDayOrdinal('primer'), 1);
  assert.equal(parseDayOrdinal('primera'), 1);
  assert.equal(parseDayOrdinal('1ro'), 1);
  assert.equal(parseDayOrdinal('1er'), 1);
  assert.equal(parseDayOrdinal('2do'), 2);
  assert.equal(parseDayOrdinal('3ro'), 3);
  assert.equal(parseDayOrdinal('15'), 15);
  assert.equal(parseDayOrdinal('nunca'), null);
});

test('interpreta fechas dichas con ordinales, igual que la transcripción real de un audio', () => {
  const parsed = deterministicInterpret(
    'Hola, quiero el 210 del primero de octubre del año 2026 al 1ro de noviembre del año 2026 para dos personas'
  );
  assert.equal(parsed.check_in, '2026-10-01');
  assert.equal(parsed.check_out, '2026-11-01');
  assert.equal(parsed.check_in_status, 'valid');
  assert.equal(parsed.check_out_status, 'valid');
  assert.equal(parsed.guests, 2);
  assert.deepEqual(parsed.missing_fields, []);
});

test('no inventa el año de una fecha natural incompleta', () => {
  const parsed = deterministicInterpret('Busco del 15 de agosto al 18 de agosto para 2 personas');
  assert.equal(parsed.check_in, null);
  assert.equal(parsed.check_out, null);
  assert.equal(parsed.check_in_status, 'ambiguous');
  assert.equal(parsed.check_out_status, 'ambiguous');
  assert.equal(parsed.needs_clarification, true);
});

test('resuelve hoy y mañana solo con fecha de referencia explicita', () => {
  const parsed = deterministicInterpret('Busco desde hoy hasta mañana para 2 personas', {
    today: '2026-07-27'
  });
  assert.equal(parsed.check_in, '2026-07-27');
  assert.equal(parsed.check_out, '2026-07-28');
  assert.equal(parsed.check_in_source, 'calculated');
  assert.equal(parsed.check_out_source, 'calculated');

  const withoutReference = deterministicInterpret('Busco desde hoy hasta mañana para 2 personas');
  assert.equal(withoutReference.check_in_status, 'ambiguous');
  assert.equal(withoutReference.check_out_status, 'ambiguous');
});

test('acepta duracion sin inventar fechas exactas', () => {
  const parsed = deterministicInterpret('Necesito alojamiento por 4 noches para 2 personas');
  assert.equal(parsed.nights, 4);
  assert.equal(parsed.check_in, null);
  assert.equal(parsed.check_out, null);
  assert.deepEqual(parsed.missing_fields, ['check_in']);
});

test('rechaza fechas naturales y con barras imposibles', () => {
  const natural = deterministicInterpret(
    'Busco del 31 de febrero de 2026 al 4 de marzo de 2026 para 2 personas'
  );
  assert.equal(natural.check_in_status, 'invalid');
  assert.equal(natural.check_out, '2026-03-04');

  const slash = deterministicInterpret('Busco del 31/02/2026 al 15/03/2026 para 2 personas');
  assert.equal(slash.check_in_status, 'invalid');
  assert.equal(slash.check_out, '2026-03-15');
});

test('rechaza salida igual o anterior a la llegada', () => {
  const reversed = deterministicInterpret(
    'Busco del 18 de agosto de 2026 al 15 de agosto de 2026 para 2 personas'
  );
  assert.equal(reversed.check_in, '2026-08-18');
  assert.equal(reversed.check_out, null);
  assert.equal(reversed.check_out_status, 'invalid');
  assert.deepEqual(reversed.missing_fields, ['check_out_or_nights']);

  const sameDay = deterministicInterpret('Busco del 2026-08-18 al 2026-08-18 para 2 personas');
  assert.equal(sameDay.check_out_status, 'invalid');
});

test('extrae y normaliza el codigo de apartamento solicitado', () => {
  const cases = [
    ['LF-210', 'LF-210'],
    ['LF 210', 'LF-210'],
    ['LF210', 'LF-210'],
    ['LF 404', 'LF-404'],
    ['lf1208', 'LF-1208']
  ];
  for (const [code, expected] of cases) {
    const parsed = deterministicInterpret(`Quiero ${code}`);
    assert.equal(parsed.requested_apartment_code_status, 'provided');
    assert.equal(parsed.requested_apartment_code, expected);
  }
});

test('reconcilia IA y no pierde fechas ISO explicitas', async () => {
  const modelResult = {
    intent: 'lodging_search', language: 'es', check_in: null, check_out: null,
    check_in_status: 'absent', check_out_status: 'absent',
    check_in_source: 'none', check_out_source: 'none',
    nights: null, guests: null, requested_apartment_code: null,
    requested_apartment_code_status: 'absent', preferences: [], requirements: [],
    uncertainty: 0.8, needs_clarification: true,
    missing_fields: ['check_in', 'check_out_or_nights', 'guests']
  };
  const http = { post: async () => ({ data: { output_text: JSON.stringify(modelResult) } }) };
  const ai = new PilotAi({ http, apiKey: 'test-key', safetySalt: 'test-salt' });
  const parsed = await ai.interpret({
    phone: '570000000000', today: '2026-07-25',
    text: 'Quiero LF-210 del 2026-08-01 al 2026-08-05 para 2 personas'
  });
  assert.equal(parsed.check_in, '2026-08-01');
  assert.equal(parsed.check_out, '2026-08-05');
  assert.equal(parsed.guests, 2);
  assert.equal(parsed.requested_apartment_code, 'LF-210');
  assert.deepEqual(parsed.missing_fields, []);
});

test('reconcilia IA y no pierde fechas naturales explicitas', async () => {
  const modelResult = {
    intent: 'lodging_search', language: 'es', check_in: null, check_out: null,
    check_in_status: 'absent', check_out_status: 'absent',
    check_in_source: 'none', check_out_source: 'none',
    nights: null, guests: null, requested_apartment_code: null,
    requested_apartment_code_status: 'absent', preferences: [], requirements: [],
    uncertainty: 0.8, needs_clarification: true,
    missing_fields: ['check_in', 'check_out_or_nights', 'guests']
  };
  const http = { post: async () => ({ data: { output_text: JSON.stringify(modelResult) } }) };
  const ai = new PilotAi({ http, apiKey: 'test-key', safetySalt: 'test-salt' });
  const parsed = await ai.interpret({
    phone: '570000000000', today: '2026-07-27',
    text: 'Quiero LF210 del 15 al 18 de agosto de 2026 para 2 personas'
  });
  assert.equal(parsed.check_in, '2026-08-15');
  assert.equal(parsed.check_out, '2026-08-18');
  assert.equal(parsed.guests, 2);
  assert.equal(parsed.requested_apartment_code, 'LF-210');
  assert.deepEqual(parsed.missing_fields, []);
});

test('reconciliacion rechaza fechas que la IA inventa para un mes parcial', async () => {
  const modelResult = {
    intent: 'lodging_search', language: 'es', check_in: '2026-09-01', check_out: '2026-09-30',
    check_in_status: 'valid', check_out_status: 'valid',
    check_in_source: 'model_interpreted', check_out_source: 'model_interpreted',
    nights: 29, guests: 2, requested_apartment_code: null,
    requested_apartment_code_status: 'absent', preferences: [], requirements: [],
    budget_cop: null, budget_period: 'absent', knowledge_topics: [],
    provided_fields: ['check_in', 'check_out', 'nights', 'guests'], corrections: [],
    requests_human: false, uncertainty: 0.1, needs_clarification: false, missing_fields: []
  };
  const http = { post: async () => ({ data: { output_text: JSON.stringify(modelResult) } }) };
  const ai = new PilotAi({ http, apiKey: 'test-key', safetySalt: 'test-salt' });
  const parsed = await ai.interpret({
    phone: '570000000000', today: '2026-08-27',
    text: 'Hola, estoy buscando un alojamiento para dos personas en septiembre'
  });
  assert.equal(parsed.check_in, null);
  assert.equal(parsed.check_out, null);
  assert.equal(parsed.check_in_status, 'ambiguous');
  assert.equal(parsed.check_out_status, 'absent');
  assert.equal(parsed.guests, 2);
  assert.equal(parsed.needs_clarification, true);
  assert.deepEqual(parsed.missing_fields, ['check_in', 'check_out_or_nights']);
});

test('fallback de IA conserva la fecha de referencia para hoy y mañana', async () => {
  const ai = new PilotAi({
    http: { post: async () => { throw new Error('simulated_offline'); } },
    apiKey: 'test-key',
    safetySalt: 'test-salt'
  });
  const parsed = await ai.interpret({
    phone: '570000000000',
    today: '2026-07-27',
    text: 'Busco desde hoy hasta mañana para 2 personas'
  });
  assert.equal(parsed._fallback, true);
  assert.equal(parsed.check_in, '2026-07-27');
  assert.equal(parsed.check_out, '2026-07-28');
  assert.deepEqual(parsed.missing_fields, []);
});

test('extrae contrato comercial ampliado desde lenguaje natural', () => {
  const parsed = deterministicInterpret(
    'Busco LF 1208 del 2026-09-10 al 2026-09-17 para dos personas, presupuesto total 3.000.000 y necesito aire acondicionado'
  );
  assert.equal(parsed.requested_apartment_code, 'LF-1208');
  assert.equal(parsed.guests, 2);
  assert.equal(parsed.budget_cop, 3000000);
  assert.equal(parsed.budget_period, 'total');
  assert.deepEqual(parsed.preferences, ['air_conditioning']);
  assert.deepEqual(parsed.requirements, ['air_conditioning']);
  assert.deepEqual(parsed.missing_fields, []);
});

test('interpreta respuesta corta usando solamente la pregunta pendiente', () => {
  const parsed = deterministicInterpret('dos', {
    today: '2026-08-25', context: { pending_fields: ['guests'] }
  });
  assert.equal(parsed.guests, 2);
  assert.deepEqual(parsed.provided_fields, ['guests']);
  assert.equal(parsed.nights, null);
});

test('marca una corrección explícita para reemplazar el dato previo', () => {
  const parsed = deterministicInterpret('Perdón, para tres personas', {
    today: '2026-08-25', context: { pending_fields: [] }
  });
  assert.equal(parsed.guests, 3);
  assert.deepEqual(parsed.corrections, ['guests']);
});

test('clasifica preguntas comerciales sin convertirlas en búsqueda completa', () => {
  const parsed = deterministicInterpret('¿El LF-210 tiene balcón y parqueadero?');
  assert.equal(parsed.intent, 'lodging_question');
  assert.deepEqual(parsed.knowledge_topics, ['parking', 'balcony']);
  assert.equal(parsed.requested_apartment_code, 'LF-210');
});

test('Incremento D2: reconoce horario de check-in/check-out y depósito como conceptos propios de conocimiento', () => {
  const schedule = deterministicInterpret('¿A qué hora es el check-in y el check-out?');
  assert.deepEqual(schedule.knowledge_topics, ['check_in_out_schedule']);

  const deposit = deterministicInterpret('¿Cuál es el depósito?');
  assert.deepEqual(deposit.knowledge_topics, ['deposit']);
});

test('Incremento D2: una solicitud de factura activa exception_request sin convertirse en tema de conocimiento', () => {
  const parsed = deterministicInterpret('Necesito que me generen una factura de mi estadía');
  assert.equal(parsed.exception_request, true);
  assert.deepEqual(parsed.knowledge_topics, []);
});

test('reconoce una petición de fotos como un tema de conocimiento propio, no una búsqueda', () => {
  const parsed = deterministicInterpret('¿Tienes fotos del LF-210?');
  assert.equal(parsed.intent, 'lodging_question');
  assert.deepEqual(parsed.knowledge_topics, ['photos']);
  assert.equal(parsed.requested_apartment_code, 'LF-210');

  const english = deterministicInterpret('Do you have pictures of the apartment?');
  assert.deepEqual(english.knowledge_topics, ['photos']);

  const plural = deterministicInterpret('Mándame más imágenes por favor');
  assert.deepEqual(plural.knowledge_topics, ['photos']);
});

test('una fecha sola, con check-in ya valido y check-out pendiente, se lee como check-out en vez de sobrescribir el check-in', () => {
  // Bug real reportado 2026-08-31: José Manuel dio "3 de septiembre" y luego,
  // en un mensaje aparte, "5 de octubre" -- el check-out se leía como un
  // nuevo check-in y borraba el 3 de septiembre, dejando el sistema pidiendo
  // la fecha de salida en un ciclo sin fin.
  const context = { check_in: '2026-09-03', check_in_status: 'valid', pending_fields: ['check_out_or_nights', 'guests'] };
  const parsed = deterministicInterpret('5 de octubre de 2026', { today: '2026-09-01', context });
  assert.equal(parsed.check_in, null);
  assert.equal(parsed.check_in_status, 'absent');
  assert.equal(parsed.check_out, '2026-10-05');
  assert.equal(parsed.check_out_status, 'valid');
  assert.deepEqual(parsed.provided_fields, ['check_out']);
});

test('una fecha sola anterior al check-in ya guardado se marca invalida, no se acepta como check-out', () => {
  const context = { check_in: '2026-09-03', check_in_status: 'valid', pending_fields: ['check_out_or_nights', 'guests'] };
  const parsed = deterministicInterpret('1 de septiembre de 2026', { today: '2026-09-01', context });
  assert.equal(parsed.check_out_status, 'invalid');
});

test('una fecha sola sin contexto de check-in pendiente conserva el comportamiento anterior (se lee como check-in)', () => {
  const parsed = deterministicInterpret('5 de octubre de 2026', { today: '2026-09-01', context: {} });
  assert.equal(parsed.check_in, '2026-10-05');
  assert.deepEqual(parsed.provided_fields, ['check_in']);
});

test('fallo de IA conserva inbound interpretable mediante fallback seguro', async () => {
  const ai = new PilotAi({
    http: { post: async () => { throw Object.assign(new Error('offline'), { code: 'ECONNABORTED' }); } },
    apiKey: 'test-key', safetySalt: 'test-salt'
  });
  const parsed = await ai.interpret({
    phone: '570000000000', today: '2026-08-25',
    text: 'Necesito alojamiento por una semana para dos personas'
  });
  assert.equal(parsed._fallback, true);
  assert.equal(parsed.nights, 7);
  assert.equal(parsed.guests, 2);
  assert.deepEqual(parsed.missing_fields, ['check_in']);
  assert.equal(parsed._dependency.code, 'ECONNABORTED');
});

test('un medio no textual se escala localmente sin invocar IA ni inventar contenido', async () => {
  let calls = 0;
  const ai = new PilotAi({
    http: { post: async () => { calls += 1; } }, apiKey: 'test-key', safetySalt: 'test-salt'
  });
  const parsed = await ai.interpret({ phone: '570000000000', today: '2026-08-25',
    text: '[M0_UNSUPPORTED_INBOUND:audio]' });
  assert.equal(calls, 0);
  assert.equal(parsed.intent, 'unknown');
  assert.equal(parsed._fallback, true);
  assert.equal(parsed._error_code, 'unsupported_inbound_type');
});

test('presentación determinista separa alternativa de confirmación', () => {
  const result = deterministicPresentation({
    action: 'present', language: 'es',
    alternatives: [{ item_id: '1', public_title: 'Estudio con balcón', summary: 'Alojamiento privado.', cover_media: { id: '10' } }],
    presentation_contract: {
      text: 'Texto exacto gobernado.', selected_item_ids: ['1'], selected_media_ids: ['10']
    }
  });
  assert.equal(result.text, 'Texto exacto gobernado.');
  assert.deepEqual(result.selected_item_ids, ['1']);
  assert.deepEqual(result.selected_media_ids, ['10']);
});

test('descarta una paráfrasis generativa y conserva el contrato exacto', async () => {
  const http = {
    post: async () => ({
      data: {
        output_text: JSON.stringify({
          text: 'Paráfrasis no autorizada.', selected_item_ids: ['1'], selected_media_ids: ['10']
        })
      }
    })
  };
  const ai = new PilotAi({ http, apiKey: 'test-key', safetySalt: 'test-salt' });
  const result = await ai.present({
    phone: '570000000000',
    decision: {
      action: 'present', language: 'es', alternatives: [],
      presentation_contract: {
        text: 'Texto exacto gobernado.', selected_item_ids: ['1'], selected_media_ids: ['10']
      }
    }
  });
  assert.equal(result.text, 'Texto exacto gobernado.');
  assert.equal(result._error_code, 'ai_presentation_contract_fallback');
});
