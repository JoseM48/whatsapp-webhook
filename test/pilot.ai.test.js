'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PilotAi, deterministicInterpret, deterministicPresentation, minimizeUserText } = require('../lib/pilot/ai');

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
