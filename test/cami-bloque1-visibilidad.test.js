'use strict';

// BLOQUE 1 (auditoria 2026-10-02, "telefonos rotos"): lo que ve Direccion en
// el CEM debe ser lo que paso. Dos cosas viajan al PMS con cada envio:
//  - una portada que NO existe se reporta como ok:false (antes desaparecia sin
//    rastro y la propuesta salia sin foto sin que nadie lo supiera);
//  - quien redacto el texto (Cami/IA o texto fijo), solo a un PMS que lo acepta.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createM0ClosedPilotDispatcher } = require('../lib/pilot/m0-closed-pilot');

const silencio = { info() {}, warn() {}, error() {} };
const guest = '573146892662', internal = '573006774425';
const config = { enabled: true, guestPhone: guest, internalPhone: internal, metaSignatureRequired: true,
  pmsM0Enabled: true, controlledIngressEnabled: true, pmsConfigured: true, receiptsEnabled: true,
  internalTemplateName: 'm0_internal_escalation_v1', internalTemplateLanguage: 'es_CO' };

function paquete({ codes = ['LF-1208', 'LF-1101'], accepts } = {}) {
  return {
    packet_version: 2, action: 'PROPUESTA PRESENTADA',
    deterministic_text: codes.map((c) => `${c}: COP 3.300.000 total, anticipo COP 600.000`).join('\n'),
    numbers: [], dates: [], apartments: codes, required_facts: [], suggested_goals: [], facts: [], notes: [],
    forbidden_claims: [], semantic_claims: [], ui: { message_kind: 'text', photo_target_codes: [] },
    presentation: { mode: 'candidates', min: 1, max: codes.length, cover_codes: codes,
      candidates: codes.map((code) => ({ code, bookable_now: true, options: [{ total: 'COP 3.300.000', deposit: 'COP 600.000' }] })) },
    allowed_moves: ['present_subset'], unit_context: [],
    ...(accepts ? { accepts } : {})
  };
}

function proveedor(salidas) {
  const cola = [...salidas];
  return { model: 'modelo-de-prueba', async structured() { return { output: cola.shift(), usage: {} }; } };
}

function montar({ packet, provider, validacion = { valid: true } }) {
  const fotos = [], completados = [], avisos = [];
  const logger = { info() {}, error() {}, warn(evento, datos) { avisos.push({ evento, datos }); } };
  const pms = {
    async processClosedPilotCommercial() { return { outboxes: [{ id: 80 }], authorized_response_packet: packet }; },
    async claimClosedPilotOutbound() { return { outbox_id: 80, claimable: true, recipient_kind: 'guest', recipient_phone: guest,
      message_kind: 'text', message_text: packet.deterministic_text }; },
    async validateAuthorizedResponse() { return validacion; },
    async completeClosedPilotOutbound(body) { completados.push(body); }
  };
  const dispatcher = createM0ClosedPilotDispatcher({ config, pms, logger,
    async sendText() { return 'wamid.text'; },
    async sendPhoto(phone, url) { fotos.push(url); return `wamid.photo.${fotos.length}`; },
    writerProvider: provider });
  return { dispatcher, fotos, completados, avisos };
}

const turno = (id) => ({ externalMessageId: id, interpretation: {}, ai: {}, writerInput: { guestText: 'precio', transcript: [] } });

test('portada inexistente (LF-1101): no se intenta, se reporta ok:false y queda un aviso en el log', async () => {
  const { dispatcher, fotos, completados, avisos } = montar({ packet: paquete(), provider: null });
  await dispatcher.completeCommercial(turno('wamid.b1a'));
  assert.equal(fotos.length, 1);
  assert.ok(fotos[0].includes('/LF-1208/01-portada.jpg'));
  assert.deepEqual(completados[0].media_sent, [
    { code: 'LF-1208', kind: 'cover', ok: true, provider_reference: 'wamid.photo.1' },
    { code: 'LF-1101', kind: 'cover', ok: false }
  ]);
  assert.deepEqual(avisos.map((a) => a.evento), ['[m0-closed] photo_missing']);
});

test('un PMS que no declara accepts.writer_provenance no recibe el campo writer (esquema estricto)', async () => {
  const { dispatcher, completados } = montar({ packet: paquete(), provider: null });
  await dispatcher.completeCommercial(turno('wamid.b1b'));
  assert.equal('writer' in completados[0], false);
});

test('con accepts.writer_provenance: texto de Cami aprobado -> writer llm_written con modelo e intentos', async () => {
  const { dispatcher, completados } = montar({ packet: paquete({ codes: ['LF-1208'], accepts: { writer_provenance: true } }),
    provider: proveedor([{ reply: 'Te recomiendo el 1208: COP 3.300.000 por la estadía, sin dinero real todavía.', presented_codes: ['LF-1208'] }]) });
  await dispatcher.completeCommercial(turno('wamid.b1c'));
  assert.deepEqual(completados[0].writer, { source: 'llm_written', model: 'modelo-de-prueba', attempts: 1 });
});

test('con accepts.writer_provenance: dos rechazos -> writer deterministic_after_rejection con los motivos', async () => {
  const { dispatcher, completados } = montar({ packet: paquete({ codes: ['LF-1208'], accepts: { writer_provenance: true } }),
    validacion: { valid: false, failure_reasons: ['unauthorized_number'] },
    provider: proveedor([{ reply: 'uno uno uno', presented_codes: ['LF-1208'] }, { reply: 'dos dos dos', presented_codes: ['LF-1208'] }]) });
  await dispatcher.completeCommercial(turno('wamid.b1d'));
  assert.equal(completados[0].writer.source, 'deterministic_after_rejection');
  assert.deepEqual(completados[0].writer.failure_reasons, ['unauthorized_number', 'unauthorized_number']);
});

test('con accepts.writer_provenance y sin redactor: writer deterministic', async () => {
  const { dispatcher, completados } = montar({ packet: paquete({ codes: ['LF-1208'], accepts: { writer_provenance: true } }), provider: null });
  await dispatcher.completeCommercial(turno('wamid.b1e'));
  assert.deepEqual(completados[0].writer, { source: 'deterministic' });
});

test('con accepts.media_reason el PMS recibe por que no salio la foto (sin archivo)', async () => {
  const { dispatcher, completados } = montar({ packet: paquete({ accepts: { writer_provenance: true, media_reason: true } }), provider: null });
  await dispatcher.completeCommercial(turno('wamid.b1f'));
  assert.deepEqual(completados[0].media_sent.find((m) => m.code === 'LF-1101'), { code: 'LF-1101', kind: 'cover', ok: false, reason: 'missing' });
});

test('con accepts.media_url el PMS recibe la direccion de la imagen enviada (para la miniatura del CEM)', async () => {
  const { dispatcher, completados } = montar({ packet: paquete({ accepts: { media_url: true } }), provider: null });
  await dispatcher.completeCommercial(turno('wamid.b1g'));
  const portada = completados[0].media_sent.find((m) => m.code === 'LF-1208');
  assert.match(portada.url, /\/media\/photos\/LF-1208\/01-portada\.jpg\?v=\d+$/);
});
