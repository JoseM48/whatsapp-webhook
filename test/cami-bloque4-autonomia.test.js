'use strict';

// BLOQUE 4 (auditoria 2026-10-02): mas autonomia para Cami dentro de lo
// permitido.
//  4a: notas de Direccion llegan al redactor como contexto (no autoridad).
//  4b: Cami puede pedir fotos (send_photos); el sistema solo envia de unidades
//      autorizadas en el paquete, con tope por unidad, sin repetir la portada.

const test = require('node:test');
const assert = require('node:assert/strict');
const { writerViewOfPacket, WRITER_SYSTEM_PROMPT, WRITER_SCHEMA } = require('../lib/pilot/llm/writer.js');
const { createM0ClosedPilotDispatcher } = require('../lib/pilot/m0-closed-pilot');

const guest = '573146892662', internal = '573006774425';
const config = { enabled: true, guestPhone: guest, internalPhone: internal, metaSignatureRequired: true,
  pmsM0Enabled: true, controlledIngressEnabled: true, pmsConfigured: true, receiptsEnabled: true,
  internalTemplateName: 'm0_internal_escalation_v1', internalTemplateLanguage: 'es_CO' };

test('4a: la vista del redactor trae las notas de Direccion con su alcance', () => {
  const vista = writerViewOfPacket({ packet_version: 2,
    direction_notes: [{ alcance: 'esta_conversacion', texto: 'Ofrécele fotos del 404' }, { alcance: 'general', texto: 'Prioriza el 404' }] });
  assert.deepEqual(vista.direction_notes, [{ scope: 'esta_conversacion', note: 'Ofrécele fotos del 404' },
    { scope: 'general', note: 'Prioriza el 404' }]);
  assert.deepEqual(writerViewOfPacket({ packet_version: 2 }).direction_notes, []);
});

test('4a: el prompt deja claro que las notas guian pero no autorizan', () => {
  assert.match(WRITER_SYSTEM_PROMPT, /DIRECTION NOTES/);
  assert.match(WRITER_SYSTEM_PROMPT, /guidance, not facts and not authorization/);
});

test('4b: el esquema exige send_photos y el prompt explica cuando pedir fotos', () => {
  assert.ok(WRITER_SCHEMA.required.includes('send_photos'));
  assert.equal(WRITER_SCHEMA.properties.send_photos.maxItems, 2);
  assert.match(WRITER_SYSTEM_PROMPT, /"send_photos"/);
});

// Turno sin propuesta: el huesped pregunta como es el 404, ya cotizado antes.
const paquetePregunta = {
  packet_version: 2, action: 'RESPONDER CONOCIMIENTO', deterministic_text: 'El LF-404 es un estudio con balcón.',
  numbers: [], dates: [], apartments: ['LF-404', 'LF-1101'], required_facts: [], suggested_goals: [], facts: [], notes: [],
  forbidden_claims: [], semantic_claims: [], ui: { message_kind: 'text', photo_target_codes: [] },
  presentation: null, allowed_moves: [], unit_context: [], accepts: { writer_provenance: true }
};

function montar(salidaRedactor, packet = paquetePregunta) {
  const fotos = [], completados = [];
  const pms = {
    async processClosedPilotCommercial() { return { outboxes: [{ id: 90 }], authorized_response_packet: packet }; },
    async claimClosedPilotOutbound() { return { outbox_id: 90, claimable: true, recipient_kind: 'guest', recipient_phone: guest,
      message_kind: 'text', message_text: packet.deterministic_text }; },
    async validateAuthorizedResponse() { return { valid: true }; },
    async completeClosedPilotOutbound(body) { completados.push(body); }
  };
  const cola = [salidaRedactor];
  const dispatcher = createM0ClosedPilotDispatcher({ config, pms, logger: { info() {}, warn() {}, error() {} },
    async sendText() { return 'wamid.text'; },
    async sendPhoto(phone, url) { fotos.push(url); return `wamid.photo.${fotos.length}`; },
    writerProvider: { model: 'm', async structured() { return { output: cola.shift(), usage: {} }; } } });
  return { dispatcher, fotos, completados };
}
const turno = (id) => ({ externalMessageId: id, interpretation: {}, ai: {}, writerInput: { guestText: '¿cómo es el 404?', transcript: [] } });

test('4b: Cami pide fotos del 404 -> salen hasta 4 de su galeria y quedan en media_sent como galeria', async () => {
  const { dispatcher, fotos, completados } = montar({ reply: 'Es un estudio con balcón; te envío unas fotos del 404.', presented_codes: [], send_photos: ['lf-404'] });
  await dispatcher.completeCommercial(turno('wamid.4b1'));
  assert.equal(fotos.length, 4);
  assert.ok(fotos.every((u) => u.includes('/LF-404/')));
  assert.ok(fotos[0].includes('01-portada'));
  assert.equal(completados[0].media_sent.length, 4);
  assert.ok(completados[0].media_sent.every((m) => m.kind === 'gallery' && m.ok));
});

test('4b: una unidad no autorizada en el paquete nunca dispara fotos', async () => {
  const { dispatcher, fotos } = montar({ reply: 'Te envío fotos del 1208.', presented_codes: [], send_photos: ['LF-1208'] });
  await dispatcher.completeCommercial(turno('wamid.4b2'));
  assert.deepEqual(fotos, []);
});

test('4b: unidad autorizada sin archivos (LF-1101) -> no se envia nada y se reporta ok:false', async () => {
  const { dispatcher, fotos, completados } = montar({ reply: 'Te muestro el 1101.', presented_codes: [], send_photos: ['LF-1101'] });
  await dispatcher.completeCommercial(turno('wamid.4b3'));
  assert.deepEqual(fotos, []);
  assert.deepEqual(completados[0].media_sent, [{ code: 'LF-1101', kind: 'gallery', ok: false }]);
});

test('4b: si el texto lo rechaza el validador (sale el determinista) no se envian las fotos pedidas', async () => {
  const fotos = [];
  const packet = paquetePregunta;
  const pms = {
    async processClosedPilotCommercial() { return { outboxes: [{ id: 91 }], authorized_response_packet: packet }; },
    async claimClosedPilotOutbound() { return { outbox_id: 91, claimable: true, recipient_kind: 'guest', recipient_phone: guest,
      message_kind: 'text', message_text: packet.deterministic_text }; },
    async validateAuthorizedResponse() { return { valid: false, failure_reasons: ['x'] }; },
    async completeClosedPilotOutbound() {}
  };
  const cola = [{ reply: 'uno uno uno', presented_codes: [], send_photos: ['LF-404'] }, { reply: 'dos dos dos', presented_codes: [], send_photos: ['LF-404'] }];
  const dispatcher = createM0ClosedPilotDispatcher({ config, pms, logger: { info() {}, warn() {}, error() {} },
    async sendText() { return 'wamid.text'; }, async sendPhoto(p, u) { fotos.push(u); return 'w'; },
    writerProvider: { model: 'm', async structured() { return { output: cola.shift(), usage: {} }; } } });
  await dispatcher.completeCommercial(turno('wamid.4b4'));
  assert.deepEqual(fotos, []);
});

test('4b (revision): si la galeria de esa unidad ya va en este turno, Cami no la duplica', async () => {
  const packet = { ...paquetePregunta, ui: { message_kind: 'text', photo_target_codes: ['LF-404'] } };
  const { dispatcher, fotos } = montar({ reply: 'Te envío fotos del 404.', presented_codes: [], send_photos: ['LF-404'] }, packet);
  await dispatcher.completeCommercial(turno('wamid.4b5'));
  assert.deepEqual(fotos, []);
});

test('4b (revision): en un turno de escalamiento no se envian fotos pedidas', async () => {
  const packet = { ...paquetePregunta, action: 'CAMBIO REQUIERE HUMANO' };
  const { dispatcher, fotos } = montar({ reply: 'José Manuel revisa el cambio al 404.', presented_codes: [], send_photos: ['LF-404'] }, packet);
  await dispatcher.completeCommercial(turno('wamid.4b6'));
  assert.deepEqual(fotos, []);
});

// 2026-10-04: fotos de zonas comunes (EDIFICIO), aprobadas por José Manuel.
test('zonas comunes: la vista del redactor las ofrece y el prompt explica cuando pedirlas', () => {
  assert.equal(writerViewOfPacket({ packet_version: 2 }).building_photos_available, true);
  assert.match(WRITER_SYSTEM_PROMPT, /"EDIFICIO"/);
  assert.match(WRITER_SYSTEM_PROMPT, /never from the photo/);
});

test('zonas comunes: Cami pide EDIFICIO -> salen las 6 fotos del edificio (incluido el parqueadero), reportadas como EDIFICIO', async () => {
  const { dispatcher, fotos, completados } = montar({ reply: 'Te envío fotos de las zonas comunes.', presented_codes: [], send_photos: ['edificio'] });
  await dispatcher.completeCommercial(turno('wamid.ed1'));
  assert.equal(fotos.length, 6);
  assert.ok(fotos[5].includes('06-parqueadero'));
  assert.ok(fotos.every((u) => u.includes('/EDIFICIO/')));
  assert.ok(fotos[0].includes('01-fachada'));
  assert.ok(completados[0].media_sent.every((m) => m.code === 'EDIFICIO' && m.kind === 'gallery' && m.ok));
});

test('zonas comunes: en un turno de escalamiento no salen fotos del edificio', async () => {
  const { dispatcher, fotos } = montar({ reply: 'Lo consulto con José Manuel.', presented_codes: [], send_photos: ['EDIFICIO'] },
    { ...paquetePregunta, action: 'ESCALAR A HUMANO' });
  await dispatcher.completeCommercial(turno('wamid.ed2'));
  assert.deepEqual(fotos, []);
});
