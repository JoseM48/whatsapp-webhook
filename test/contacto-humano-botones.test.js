'use strict';

// CONTACTO CON UNA PERSONA (2026-10-14): fila 'buttons' del PMS. Texto fijo
// aprobado (nunca lo redacta el modelo, aunque el turno traiga paquete v2) con
// botones de respuesta rapida; sin botones validos sale como texto simple.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createM0ClosedPilotDispatcher } = require('../lib/pilot/m0-closed-pilot');

const guest = '573000000001', internal = '573006774425';
const config = { enabled: true, guestPhone: guest, internalPhone: internal, metaSignatureRequired: true,
  pmsM0Enabled: true, controlledIngressEnabled: true, pmsConfigured: true, receiptsEnabled: true,
  internalTemplateName: 'm0_internal_escalation_v1', internalTemplateLanguage: 'es_CO' };
const OFERTA = 'Si lo prefieres, José Manuel te atiende personalmente: te puede llamar desde este mismo número o escribirte él directamente.';
const BOTONES = [{ id: 'contacto_llamada', title: '📞 Que me llamen' }, { id: 'contacto_chat', title: '💬 Hablar con José' },
  { id: 'contacto_seguir', title: 'Seguir con Cami' }];

function pmsCon(claims, completados) {
  return {
    async processClosedPilotCommercial() {
      return { outboxes: claims.map((c) => ({ id: c.outbox_id })), authorized_response_packet: { packet_version: 2, action: 'PROPUESTA PRESENTADA',
        deterministic_text: 'LF-210: COP 3.300.000', ui: { message_kind: 'text', photo_target_codes: [] }, presentation: null,
        accepts: { superseded: true } } };
    },
    async claimClosedPilotOutbound(id) { return { claimable: true, ...claims.find((c) => c.outbox_id === id) }; },
    async completeClosedPilotOutbound(body) { completados.push(body); }
  };
}

test('una fila buttons sale como mensaje con botones, con el texto fijo (el redactor no la toca)', async () => {
  const enviados = [], textos = [], completados = [];
  let redactorLlamado = 0;
  const claims = [{ outbox_id: 70, recipient_kind: 'guest', recipient_phone: guest, message_kind: 'buttons', message_text: OFERTA, buttons: BOTONES }];
  const dispatcher = createM0ClosedPilotDispatcher({ config, pms: pmsCon(claims, completados),
    async sendText(phone, text) { textos.push(text); return 'wamid.t'; },
    async sendButtons(phone, payload) { enviados.push({ phone, payload }); return 'wamid.b'; },
    async sendPhoto() { throw new Error('no debe enviar fotos'); },
    writerProvider: { async write() { redactorLlamado += 1; return { text: 'otra cosa' }; } } });
  const r = await dispatcher.completeCommercial({ externalMessageId: 'wamid.in1', interpretation: {}, ai: {},
    writerInput: { guestText: 'x', transcript: [] } });
  assert.equal(redactorLlamado, 0);
  assert.equal(textos.length, 0);
  assert.equal(enviados.length, 1);
  assert.equal(enviados[0].phone, guest);
  assert.deepEqual(enviados[0].payload, { bodyText: OFERTA, buttons: BOTONES });
  assert.equal(r.deliveries[0].sent, true);
  assert.equal(completados[0].status, 'submitted');
});

test('sin botones (lista vacia o titulo de mas de 20) o sin emisor, sale el mismo texto como texto simple', async () => {
  for (const [buttons, conEmisor] of [[[], true], [[{ id: 'x', title: 'Un título demasiado largo para Meta' }], true], [BOTONES, false]]) {
    const textos = [], botones = [], completados = [];
    const claims = [{ outbox_id: 71, recipient_kind: 'guest', recipient_phone: guest, message_kind: 'buttons',
      message_text: `${OFERTA}\n\nResponde «Que me llamen», «Hablar con José» o «Seguir con Cami».`, buttons }];
    const dispatcher = createM0ClosedPilotDispatcher({ config, pms: pmsCon(claims, completados),
      async sendText(phone, text) { textos.push(text); return 'wamid.t'; },
      ...(conEmisor ? { async sendButtons() { botones.push(1); return 'wamid.b'; } } : {}) });
    await dispatcher.completeCommercial({ externalMessageId: `wamid.in-${textos.length}-${buttons.length}`, interpretation: {}, ai: {} });
    assert.equal(botones.length, 0);
    assert.deepEqual(textos, [claims[0].message_text]);
  }
});

test('sin poder poner botones, envía el texto de respaldo del PMS (con la pista de qué escribir)', async () => {
  const textos = [], completados = [];
  const respaldo = `${OFERTA}

Responde «Que me llamen», «Hablar con José» o «Seguir con Cami».`;
  const claims = [{ outbox_id: 72, recipient_kind: 'guest', recipient_phone: guest, message_kind: 'buttons', message_text: OFERTA,
    buttons: BOTONES, fallback_text: respaldo }];
  const dispatcher = createM0ClosedPilotDispatcher({ config, pms: pmsCon(claims, completados),
    async sendText(phone, text) { textos.push(text); return 'wamid.t'; } });
  await dispatcher.completeCommercial({ externalMessageId: 'wamid.in-respaldo', interpretation: {}, ai: {} });
  assert.deepEqual(textos, [respaldo]);
});

test('el claim declara que este webhook sabe enviar botones', () => {
  const PmsClient = require('../lib/pilot/pms-client');
  const fuente = require('node:fs').readFileSync(require.resolve('../lib/pilot/pms-client'), 'utf8');
  assert.ok(PmsClient);
  assert.match(fuente, /'X-M0-Accepts': 'document, image, buttons'/);
});
