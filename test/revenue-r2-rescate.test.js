'use strict';

// REVENUE R2 (2026-10-12): rescate de cotizaciones en el webhook.
//  - Los botones de respuesta rapida de las plantillas del rescate llegan como
//    texto (solo esos textos exactos); el resto de botones de huesped no cambia.
//  - Una plantilla al huesped sin variables viaja con lista vacia explicita.
const test = require('node:test');
const assert = require('node:assert/strict');
const { textForMessage, BOTONES_RESCATE } = require('../lib/pilot/meta-inbound');
const { guestTemplatePayload } = require('../lib/pilot/m0-closed-pilot');

const status = { internalTemplateLanguage: 'es_CO' };

test('R2: los botones del rescate llegan como texto exacto', () => {
  for (const b of ['Sí, avísame', 'No, gracias', 'Ya reservé en otro lugar', 'Se sale de mi presupuesto',
    'Cambiaron mis planes', 'Busco algo diferente', 'Aún lo estoy decidiendo']) {
    assert.equal(textForMessage({ type: 'button', button: { text: b, payload: b } }), b);
    assert.ok(BOTONES_RESCATE.has(b));
    // Meta: 25 caracteres por boton de respuesta rapida.
    assert.ok(b.length <= 25, b);
  }
  assert.equal(textForMessage({ type: 'button', button: { text: '  Sí, avísame ' } }), 'Sí, avísame');
});

test('R2: los demas botones de plantillas de huesped siguen sin texto; "Ver detalle" igual', () => {
  assert.equal(textForMessage({ type: 'button', button: { text: 'Sí, me interesa' } }), null);
  assert.equal(textForMessage({ type: 'button', button: { text: 'sí, avísame (otro)' } }), null);
  assert.equal(textForMessage({ type: 'button', button: { text: 'Ver detalle', payload: 'Ver detalle' } }), 'Ver detalle');
});

test('R2: plantilla al huesped sin variables (lista vacia explicita); sin lista sigue siendo error', () => {
  assert.deepEqual(guestTemplatePayload({ template_name: 'lf_rescate_motivo_sn_v1', template_parameters: [] }, status),
    { name: 'lf_rescate_motivo_sn_v1', language: 'es_CO', parameters: [] });
  assert.throws(() => guestTemplatePayload({ template_name: 'lf_rescate_motivo_sn_v1' }, status), /parameters_missing/);
  assert.throws(() => guestTemplatePayload({ template_name: 'x_v1', template_parameters: ['   '] }, status), /parameters_missing/);
  assert.deepEqual(guestTemplatePayload({ template_name: 'lf_rescate_motivo_v1', template_parameters: ['Ana'], template_language: 'es_CO' }, status).parameters, ['Ana']);
});
