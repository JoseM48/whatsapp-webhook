'use strict';

// AVISOS INTERNOS POR ROL (2026-10-06): el aviso interno sale como TEXTO con
// saltos de linea cuando el PMS dice que la ventana de 24 h del numero interno
// esta abierta; si no, como plantilla con los parametros legibles que manda el
// PMS (o la plantilla corta aprobada); un PMS anterior sigue funcionando igual.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createM0ClosedPilotDispatcher, internalDelivery } = require('../lib/pilot/m0-closed-pilot');
const { textForMessage } = require('../lib/pilot/meta-inbound');

const internal = '573006774425';
const config = { enabled: true, guestPhone: '573146892662', internalPhone: internal, metaSignatureRequired: true,
  pmsM0Enabled: true, controlledIngressEnabled: true, pmsConfigured: true, receiptsEnabled: true,
  internalTemplateName: 'm0_internal_escalation_v1', internalTemplateLanguage: 'es_CO' };
const status = { internalTemplateName: 'm0_internal_escalation_v1', internalTemplateLanguage: 'es_CO' };
const SOBRE = 'PILOTO M0\nPARA: PROPIETARIO\nCASO: M0-1\nAPARTAMENTO: LF-210\nACCIÓN SOLICITADA: VALIDAR\n\nRevisar\nsolicitud.';

function dispatcherCon(claim) {
  const sent = [], templates = [], completed = [];
  const pms = {
    async closedPilotInbound() { return { outboxes: [{ id: 7 }] }; },
    async claimClosedPilotOutbound() { return { outbox_id: 7, claimable: true, recipient_kind: 'internal', message_text: SOBRE, ...claim }; },
    async completeClosedPilotOutbound(body) { completed.push(body); }
  };
  const d = createM0ClosedPilotDispatcher({ config, pms,
    async sendText(phone, text) { sent.push({ phone, text }); return 'wamid.t'; },
    async sendTemplate(phone, template) { templates.push({ phone, template }); return 'wamid.p'; } });
  return { d, sent, templates, completed };
}

test('ventana abierta: el aviso sale como texto, con sus saltos de linea, al numero interno', async () => {
  const texto = 'ADMINISTRADOR · URGENTE · Lead #114 · Cami no sabe responder\nSin apartamento aún\n\nQué pasó\n¿Laureles?';
  const { d, sent, templates, completed } = dispatcherCon({ internal_delivery: 'text', internal_text: texto });
  await d.process({ phone: internal, text: 'hola', messageId: 'wamid.in.1', occurredAt: new Date().toISOString() });
  assert.deepEqual(sent, [{ phone: internal, text: texto }]);
  assert.equal(templates.length, 0);
  assert.equal(completed[0].status, 'submitted');
});

test('ventana cerrada: plantilla de siempre con los 5 parametros legibles del PMS (saneados)', async () => {
  const params = ['ADMINISTRADOR · URGENTE · Lead #114', 'Lead #114', 'Sin apartamento aún', 'Cami no sabe responder', 'a | b\nc'];
  const { d, sent, templates } = dispatcherCon({ internal_delivery: 'template', internal_template_parameters: params });
  await d.process({ phone: internal, text: 'x', messageId: 'wamid.in.2', occurredAt: new Date().toISOString() });
  assert.equal(sent.length, 0);
  assert.deepEqual(templates[0].template, { name: 'm0_internal_escalation_v1', language: 'es_CO',
    parameters: ['ADMINISTRADOR · URGENTE · Lead #114', 'Lead #114', 'Sin apartamento aún', 'Cami no sabe responder', 'a | b c'] });
});

test('plantilla corta aprobada: usa su nombre y sus 4 parametros', () => {
  const plan = internalDelivery({ internal_delivery: 'template', internal_template_name: 'mio_aviso_interno_v2',
    internal_template_language: 'es_CO', internal_template_parameters: ['ADMINISTRADOR · URGENTE', '114', 'Cami no sabe responder', '2'] }, status);
  assert.deepEqual(plan, { mode: 'template', template: { name: 'mio_aviso_interno_v2', language: 'es_CO',
    parameters: ['ADMINISTRADOR · URGENTE', '114', 'Cami no sabe responder', '2'] } });
});

test('PMS anterior (sin campos nuevos): se parte el sobre como siempre', () => {
  const plan = internalDelivery({ message_text: SOBRE }, status);
  assert.deepEqual(plan.template.parameters, ['PROPIETARIO', 'M0-1', 'LF-210', 'VALIDAR', 'Revisar solicitud.']);
  // Un nombre de plantilla invalido nunca se usa.
  const malo = internalDelivery({ message_text: SOBRE, internal_template_name: 'Mal Nombre!', internal_template_parameters: ['a'] }, status);
  assert.equal(malo.template.name, 'm0_internal_escalation_v1');
  assert.deepEqual(malo.template.parameters, ['PROPIETARIO', 'M0-1', 'LF-210', 'VALIDAR', 'Revisar solicitud.']);
});

test('el boton de respuesta rapida de una plantilla ("Ver detalle") llega como texto', () => {
  assert.equal(textForMessage({ type: 'button', button: { text: 'Ver detalle', payload: 'Ver detalle' } }), 'Ver detalle');
  assert.equal(textForMessage({ type: 'button', button: {} }), null);
  // Otros botones de plantilla (de huesped) no cambian de comportamiento.
  assert.equal(textForMessage({ type: 'button', button: { text: 'Sí, me interesa' } }), null);
});

// --- FASE 3: respuestas con numero ---------------------------------------
const { isLiteralCommand } = require('../lib/pilot/llm/manager-intent');
const { extractMetaMessages } = require('../lib/pilot/meta-inbound');

test('fase 3: las respuestas a un aviso no pasan por el modelo del gerente', () => {
  for (const t of ['114 1', 'Sí 96', 'no 96', 'DESHACER', 'deshacer 114', '114: Hola, soy José Manuel', 'Ver detalle', 'APROBAR 96', 'conciliar 96', 'FACTURA ENTREGADA 3'])
    assert.equal(isLiteralCommand(t), true, t);
  for (const t of ['no', '¿qué pasó con el lead 114?', 'aprueba lo de Ana', '8:30 llego', 'CANCELAR 96']) assert.equal(isLiteralCommand(t), false, t);
});

test('fase 3: el id del mensaje citado viaja al PMS solo desde el numero interno', async () => {
  const msgs = extractMetaMessages({ entry: [{ changes: [{ value: { messages: [
    { from: internal, id: 'wamid.in.9', timestamp: '1760000000', type: 'text', text: { body: '1' }, context: { id: 'wamid.aviso.1' } }] } }] }] });
  assert.equal(msgs[0].replyTo, 'wamid.aviso.1');
  const bodies = [];
  const pms = { async closedPilotInbound(body) { bodies.push(body); return { outboxes: [] }; } };
  const d = createM0ClosedPilotDispatcher({ config, pms, async sendText() {} });
  await d.process({ phone: internal, text: '1', messageId: 'wamid.in.9', occurredAt: new Date().toISOString(), replyTo: 'wamid.aviso.1' });
  await d.process({ phone: '573146892662', text: 'NUEVA PRUEBA', messageId: 'wamid.in.10', occurredAt: new Date().toISOString(), replyTo: 'wamid.x' });
  assert.equal(bodies[0].reply_to_message_id, 'wamid.aviso.1');
  assert.equal('reply_to_message_id' in bodies[1], false);
});

// --- FASE 4: factura en PDF desde el numero interno ------------------------
test('fase 4: un archivo del numero interno va al PMS como documento y se entregan sus salidas', async () => {
  const bodies = [], sent = [];
  const pms = {
    async closedPilotInternalDocument(body) { bodies.push(body); return { action: 'FACTURA RECIBIDA', outboxes: [{ id: 5 }] }; },
    async claimClosedPilotOutbound() { return { outbox_id: 5, claimable: true, recipient_kind: 'internal', message_text: SOBRE,
      internal_delivery: 'text', internal_text: 'CONTADORA · INFO · Lead #3 · Factura recibida' }; },
    async completeClosedPilotOutbound() {}
  };
  const d = createM0ClosedPilotDispatcher({ config, pms, async sendText(phone, text) { sent.push(text); return 'wamid.x'; } });
  const r = await d.internalDocument({ phone: internal, messageId: 'wamid.doc.1', occurredAt: new Date().toISOString(),
    caption: '3', replyTo: null, adjunto: { tipo: 'document', estado: 'guardado' } });
  assert.equal(r.handled, true);
  assert.equal(bodies[0].caption, '3');
  assert.equal(bodies[0].phone, internal);
  assert.deepEqual(sent, ['CONTADORA · INFO · Lead #3 · Factura recibida']);
  // Un huesped nunca entra por aqui.
  assert.equal((await d.internalDocument({ phone: '573146892662', messageId: 'w', occurredAt: new Date().toISOString(), adjunto: {} })).handled, false);
});
