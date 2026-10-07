'use strict';

// RETOMAR CON PLANTILLA (2026-10-06): el PMS encola una plantilla al huesped
// (lf_retomar_consulta_v1) con [nombre, texto de Jose Manuel] y la entrega el
// poller. Aqui se fija el contrato: telefono del huesped resuelto por el PMS,
// nombre/idioma/parametros tal como vienen en el claim, nunca texto libre.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createM0ClosedPilotDispatcher } = require('../lib/pilot/m0-closed-pilot');

const guest = '573146892662', internal = '573006774425';
const config = { enabled: true, guestPhone: guest, internalPhone: internal, metaSignatureRequired: true,
  pmsM0Enabled: true, controlledIngressEnabled: true, pmsConfigured: true, receiptsEnabled: true,
  internalTemplateName: 'm0_internal_escalation_v1', internalTemplateLanguage: 'es_CO' };

function poller(claims) {
  let i = 0;
  const sent = [], templates = [], completed = [];
  const pms = {
    async claimClosedPilotOutbound() { return claims[i++] ?? { claimable: false, status: 'empty' }; },
    async completeClosedPilotOutbound(body) { completed.push(body); }
  };
  const d = createM0ClosedPilotDispatcher({ config, pms,
    async sendText(phone, text) { sent.push({ phone, text }); return 'wamid.t'; },
    async sendTemplate(phone, template) { templates.push({ phone, template }); return 'wamid.p'; },
    logger: { info() {}, warn() {}, error() {} } });
  return { d, sent, templates, completed };
}

const claimRetomar = (extra = {}) => ({ outbox_id: 41, claimable: true, recipient_kind: 'guest', recipient_role: 'huesped',
  message_kind: 'template', recipient_phone: guest,
  message_text: 'Hola Ana, soy José Manuel de Mío La Frontera. Sobre tu consulta de alojamiento: ya hay cupo. Si te interesa, respóndeme por este chat y seguimos.',
  template_name: 'lf_retomar_consulta_v1', template_parameters: ['Ana', 'ya hay cupo'], template_language: 'es_CO', ...extra });

test('la plantilla de retomar sale al telefono del huesped con nombre, idioma y parametros del PMS', async () => {
  const { d, sent, templates, completed } = poller([claimRetomar()]);
  const results = await d.pollPendingInternalOutbox();
  assert.equal(sent.length, 0, 'nunca como texto libre');
  assert.deepEqual(templates, [{ phone: guest, template: { name: 'lf_retomar_consulta_v1', language: 'es_CO',
    parameters: ['Ana', 'ya hay cupo'] } }]);
  assert.deepEqual(completed, [{ outbox_id: 41, status: 'submitted', provider_reference: 'wamid.p' }]);
  assert.equal(results[0].status, 'submitted');
});

test('el idioma del claim manda sobre el del aviso interno; los parametros se sanean para Meta', async () => {
  const { d, templates } = poller([claimRetomar({ template_language: 'es', template_parameters: ['Ana', 'a\nb\tc     d'] })]);
  await d.pollPendingInternalOutbox();
  assert.equal(templates[0].template.language, 'es');
  assert.deepEqual(templates[0].template.parameters, ['Ana', 'a b c d']);
});

test('sin telefono del huesped o sin parametros no se envia nada', async () => {
  const sinTelefono = poller([claimRetomar({ recipient_phone: null })]);
  await sinTelefono.d.pollPendingInternalOutbox();
  assert.equal(sinTelefono.templates.length, 0);
  assert.equal(sinTelefono.completed[0].status, 'unknown');

  const sinParametros = poller([claimRetomar({ template_parameters: [] })]);
  await sinParametros.d.pollPendingInternalOutbox();
  assert.equal(sinParametros.templates.length, 0);
  assert.equal(sinParametros.completed[0].status, 'failed');
});
