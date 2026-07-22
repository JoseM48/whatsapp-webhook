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
});

test('minimiza correo y teléfono antes de enviar texto a IA', () => {
  const minimized = minimizeUserText('Escríbeme a prueba@example.com o +57 300 000 0000');
  assert.doesNotMatch(minimized, /prueba@example\.com|300 000 0000/);
  assert.match(minimized, /\[email-redacted\]|\[phone-redacted\]/);
});

test('fallback detecta datos obligatorios faltantes e inglés', () => {
  const parsed = deterministicInterpret('Hello, I need an apartment with air conditioning');
  assert.equal(parsed.language, 'en');
  assert.deepEqual(parsed.missing_fields, ['check_in', 'check_out_or_nights', 'guests']);
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
