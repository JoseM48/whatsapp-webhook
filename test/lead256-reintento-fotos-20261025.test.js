'use strict';

// LEAD 256 (2026-10-25): la presentacion de opciones se decidio en el PMS, pero
// la llamada del webhook vencio (dependency_timeout, 18,8 s). El reintento
// (beginCommercial del mismo mensaje, deduplicado) entrego la respuesta
// pendiente SIN su paquete: salio el texto, sin las portadas de los
// apartamentos (el camino viejo solo reconoce "LF-xxx: COP" y el bloque de
// precios v2 dice "LF-1109: $121.000"). Ahora el reintento entrega con el
// paquete guardado del turno: salen las portadas y el texto va tal cual.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createM0ClosedPilotDispatcher } = require('../lib/pilot/m0-closed-pilot');

const silencio = { info() {}, warn() {}, error() {} };
const guest = '573146892662', internal = '573006774425';
const config = { enabled: true, guestPhone: guest, internalPhone: internal, metaSignatureRequired: true,
  pmsM0Enabled: true, controlledIngressEnabled: true, pmsConfigured: true, receiptsEnabled: true,
  internalTemplateName: 'm0_internal_escalation_v1', internalTemplateLanguage: 'es_CO' };

const TEXTO = 'Tengo estas opciones del 30 de noviembre al 28 de diciembre para 1 persona:\n'
  + 'LF-1109: $121.000 por noche · total 28 noches: $3.397.216\n'
  + 'Estos dos apartaestudios tienen el mismo valor: $114.000 por noche · total 28 noches: $3.197.216\n• LF-210: balcón\n• LF-510: balcón';
const paquete = { packet_version: 2, action: 'PROPUESTA PRESENTADA', deterministic_text: TEXTO, numbers: [], dates: [],
  apartments: ['LF-1109', 'LF-210', 'LF-510'], required_facts: [], facts: [], notes: [], forbidden_claims: [],
  accepts: { superseded: true, media_url: true, media_reason: true, writer_provenance: true },
  ui: { message_kind: 'text', photo_target_codes: [] },
  presentation: { mode: 'candidates', min: 1, max: 3, cover_codes: ['LF-1109', 'LF-210', 'LF-510'],
    candidates: [{ code: 'LF-1109' }, { code: 'LF-210' }, { code: 'LF-510' }] } };

function montar(beginResult) {
  const fotos = [], textos = [], completados = [];
  let redactorLlamado = false;
  const pms = {
    async beginClosedPilotCommercial() { return beginResult; },
    async claimClosedPilotOutbound(id) { return { outbox_id: id, claimable: true, recipient_kind: 'guest', recipient_phone: guest,
      message_kind: 'text', message_text: TEXTO }; },
    async validateAuthorizedResponse() { return { valid: true }; },
    async completeClosedPilotOutbound(body) { completados.push(body); }
  };
  const dispatcher = createM0ClosedPilotDispatcher({ config, pms, logger: silencio,
    async sendText(to, body) { textos.push(body); return 'wamid.text'; },
    async sendPhoto(to, url) { fotos.push(url); return `wamid.photo.${fotos.length}`; },
    writerProvider: { model: 'm', async structured() { redactorLlamado = true; return { output: { reply: 'otro texto', presented_codes: [] }, usage: {} }; } } });
  return { dispatcher, fotos, textos, completados, redactor: () => redactorLlamado };
}
const arranque = (m) => m.dispatcher.beginCommercial({ phone: guest, messageId: 'wamid.l256', occurredAt: new Date().toISOString() });

test('reintento deduplicado con paquete guardado: salen las portadas presentadas y el texto va tal cual (sin redactor)', async () => {
  const m = montar({ deduplicated: true, processing_claimed: true, authorized_response_packet: paquete, outboxes: [{ id: 4137 }] });
  await arranque(m);
  assert.deepEqual(m.textos, [TEXTO]);
  assert.equal(m.redactor(), false);
  assert.equal(m.fotos.length, 3);
  assert.ok(m.fotos[0].includes('/LF-1109/01-portada.jpg'));
  assert.deepEqual(m.completados[0].presented_codes, ['LF-1109', 'LF-210', 'LF-510']);
  assert.deepEqual(m.completados[0].media_sent.map((x) => [x.code, x.kind, x.ok]),
    [['LF-1109', 'cover', true], ['LF-210', 'cover', true], ['LF-510', 'cover', true]]);
});

test('la entrega diferida del acuse (deliverCommercialOutboxes) usa el mismo paquete guardado', async () => {
  const begin = { deduplicated: true, authorized_response_packet: paquete, outboxes: [{ id: 4137 }] };
  const m = montar(begin);
  await m.dispatcher.deliverCommercialOutboxes(begin.outboxes, begin);
  assert.equal(m.fotos.length, 3);
});

test('control: sin deduplicar (primer arranque, acuses) no se usa paquete: comportamiento de siempre', async () => {
  const m = montar({ deduplicated: false, processing_claimed: true, authorized_response_packet: paquete, outboxes: [{ id: 1 }] });
  await arranque(m);
  assert.deepEqual(m.textos, [TEXTO]);
  assert.equal(m.fotos.length, 0);
  assert.equal(m.redactor(), false);
});
