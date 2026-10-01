'use strict';

// CAMI VENDEDORA F1 (2026-10-01): Cami elige que candidatas autorizadas
// presenta y lo declara en `presented_codes`; el PMS valida permiso; las fotos
// salen de esa identidad estructurada, nunca del texto.

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveWrittenReply, writerViewOfPacket, WRITER_SYSTEM_PROMPT, WRITER_SCHEMA } = require('../lib/pilot/llm/writer.js');
const { createM0ClosedPilotDispatcher } = require('../lib/pilot/m0-closed-pilot');

const silencio = { info() {}, warn() {}, error() {} };
const guest = '573146892662', internal = '573006774425';
const config = { enabled: true, guestPhone: guest, internalPhone: internal, metaSignatureRequired: true,
  pmsM0Enabled: true, controlledIngressEnabled: true, pmsConfigured: true, receiptsEnabled: true,
  internalTemplateName: 'm0_internal_escalation_v1', internalTemplateLanguage: 'es_CO' };

// Lead #98: dos candidatas al mismo precio.
const paquete98 = {
  packet_version: 2, action: 'PROPUESTA PRESENTADA',
  deterministic_text: 'Tengo estas opciones:\nLF-1208: COP 3.300.000 total, anticipo COP 600.000\nLF-404: COP 3.300.000 total, anticipo COP 600.000',
  numbers: [{ id: 'LF-1208.total', label: 'total LF-1208', formatted: 'COP 3.300.000' },
    { id: 'LF-404.total', label: 'total LF-404', formatted: 'COP 3.300.000' }],
  dates: [{ id: 'check_in', formatted: '2026-10-05' }, { id: 'check_out', formatted: '2026-11-04' }],
  apartments: ['LF-1208', 'LF-404'], required_facts: [], suggested_goals: [], facts: [], notes: [],
  forbidden_claims: ['reserva_confirmada'], semantic_claims: [], ui: { message_kind: 'text', photo_target_codes: [] },
  presentation: { mode: 'candidates', min: 1, max: 2, cover_codes: ['LF-1208', 'LF-404'],
    candidates: [{ code: 'LF-1208', bookable_now: true, options: [{ total: 'COP 3.300.000', deposit: 'COP 600.000' }] },
      { code: 'LF-404', bookable_now: true, options: [{ total: 'COP 3.300.000', deposit: 'COP 600.000' }] }] },
  allowed_moves: ['present_subset', 'compare_options', 'ask_one', 'advance_to_selection'],
  unit_context: [{ code: 'LF-1208', capacity: 2, published_sheet: false, public_attributes: null },
    { code: 'LF-404', capacity: 3, published_sheet: false, public_attributes: null }]
};

function proveedor(salidas) {
  const cola = [...salidas];
  return { model: 'modelo-de-prueba',
    async structured() { return { output: cola.shift(), usage: {} }; } };
}
function pmsQueRegistra(veredicto = { valid: true }) {
  const llamadas = [];
  return { llamadas, async validateAuthorizedResponse(body) { llamadas.push(body); return veredicto; } };
}

test('el esquema y el prompt piden presented_codes y explican candidatas, contexto y movimientos', () => {
  assert.deepEqual(WRITER_SCHEMA.required, ['reply', 'presented_codes']);
  assert.match(WRITER_SYSTEM_PROMPT, /CANDIDATES/);
  assert.match(WRITER_SYSTEM_PROMPT, /presented_codes/);
  assert.match(WRITER_SYSTEM_PROMPT, /ALLOWED MOVES/);
  assert.match(WRITER_SYSTEM_PROMPT, /never promise an automatic notice/);
});

test('la vista del redactor trae candidatas, movimientos y unit_context con fotos disponibles, sin texto determinista', () => {
  const vista = writerViewOfPacket(paquete98);
  assert.deepEqual(vista.presentation.candidates.map((c) => c.code), ['LF-1208', 'LF-404']);
  assert.deepEqual(vista.allowed_moves, paquete98.allowed_moves);
  assert.equal(vista.unit_context.find((u) => u.code === 'LF-1208').photos_available, true);
  assert.equal(vista.deterministic_text, undefined);
  // Sin candidatas, la vista no inventa una presentacion.
  assert.equal(writerViewOfPacket({ packet_version: 2 }).presentation, null);
});

test('lead #98: Cami presenta solo una; el PMS recibe presented_codes y lo devuelve como identidad', async () => {
  const pms = pmsQueRegistra();
  const out = await resolveWrittenReply({ packet: paquete98, pms, logger: silencio, guestText: 'precio mes a mes', transcript: [],
    provider: proveedor([{ reply: 'Para ustedes dos te recomiendo el LF-1208: COP 3.300.000 por las 30 noches, sin dinero real todavía.', presented_codes: ['lf-1208'] }]) });
  assert.equal(out.presentation_source, 'llm_written');
  assert.deepEqual(out.presented_codes, ['LF-1208']);
  assert.deepEqual(pms.llamadas[0].presented_codes, ['LF-1208']);
});

test('sin candidatas en el paquete no se envia presented_codes (validacion de siempre)', async () => {
  const pms = pmsQueRegistra();
  const { presentation, ...sinCandidatas } = paquete98;
  await resolveWrittenReply({ packet: { ...sinCandidatas, presentation: null }, pms, logger: silencio, guestText: 'x', transcript: [],
    provider: proveedor([{ reply: 'texto valido de prueba para el huesped', presented_codes: [] }]) });
  assert.equal('presented_codes' in pms.llamadas[0], false);
});

test('si el redactor es rechazado dos veces, la identidad es la del determinista (todas las candidatas)', async () => {
  const out = await resolveWrittenReply({ packet: paquete98, logger: silencio, guestText: 'x', transcript: [],
    pms: pmsQueRegistra({ valid: false, failure_reasons: ['presented_total_missing:LF-1208'] }),
    provider: proveedor([{ reply: 'uno', presented_codes: ['LF-1208'] }, { reply: 'dos', presented_codes: ['LF-1208'] }]) });
  assert.equal(out.presentation_source, 'deterministic_after_rejection');
  assert.deepEqual(out.presented_codes, ['LF-1208', 'LF-404']);
});

function dispatcherConPaquete({ packet, provider, validacion = { valid: true }, mensaje }) {
  const fotos = [], completados = [];
  const pms = {
    async processClosedPilotCommercial() { return { outboxes: [{ id: 70 }], authorized_response_packet: packet }; },
    async claimClosedPilotOutbound() { return { outbox_id: 70, claimable: true, recipient_kind: 'guest', recipient_phone: guest,
      message_kind: 'text', message_text: mensaje ?? packet.deterministic_text }; },
    async validateAuthorizedResponse() { return validacion; },
    async completeClosedPilotOutbound(body) { completados.push(body); }
  };
  const dispatcher = createM0ClosedPilotDispatcher({ config, pms, logger: silencio,
    async sendText() { return 'wamid.text'; },
    async sendPhoto(phone, url) { fotos.push(url); return `wamid.photo.${fotos.length}`; },
    writerProvider: provider });
  return { dispatcher, fotos, completados };
}

test('fotos por identidad: Cami presento solo LF-404 -> solo su portada, aunque el determinista liste las dos', async () => {
  const { dispatcher, fotos, completados } = dispatcherConPaquete({ packet: paquete98,
    provider: proveedor([{ reply: 'Te recomiendo el 404, cabe uno más: COP 3.300.000 en total. Sin dinero real todavía.', presented_codes: ['LF-404'] }]) });
  await dispatcher.completeCommercial({ externalMessageId: 'wamid.98', interpretation: {}, ai: {},
    writerInput: { guestText: 'precio', transcript: [] } });
  assert.deepEqual(fotos, ['https://whatsapp-webhook-erom.onrender.com/media/photos/LF-404/01-portada.jpg']);
  assert.deepEqual(completados[0].presented_codes, ['LF-404']);
  assert.deepEqual(completados[0].media_sent, [{ code: 'LF-404', kind: 'cover', ok: true, provider_reference: 'wamid.photo.1' }]);
});

test('fotos sin regex: el formato del texto no importa (sin "LF-xxx: COP") y salen las portadas presentadas', async () => {
  const { dispatcher, fotos } = dispatcherConPaquete({ packet: paquete98,
    provider: proveedor([{ reply: 'Te muestro los dos: el 1208 y el 404, cada uno a COP 3.300.000 por la estadía.', presented_codes: ['LF-1208', 'LF-404'] }]) });
  await dispatcher.completeCommercial({ externalMessageId: 'wamid.98b', interpretation: {}, ai: {}, writerInput: { guestText: 'x', transcript: [] } });
  assert.equal(fotos.length, 2);
  assert.ok(fotos[0].includes('/LF-1208/01-portada.jpg'));
});

test('una identidad no autorizada nunca dispara una foto', async () => {
  const { dispatcher, fotos } = dispatcherConPaquete({ packet: paquete98,
    provider: proveedor([{ reply: 'x'.repeat(30), presented_codes: ['LF-210'] }]) });
  await dispatcher.completeCommercial({ externalMessageId: 'wamid.98c', interpretation: {}, ai: {}, writerInput: { guestText: 'x', transcript: [] } });
  assert.deepEqual(fotos, []);
});

test('un PMS anterior (paquete sin la clave presentation) no recibe campos nuevos y no hay portadas por texto', async () => {
  const { presentation, ...anterior } = paquete98;
  const { dispatcher, fotos, completados } = dispatcherConPaquete({ packet: anterior, provider: null });
  await dispatcher.completeCommercial({ externalMessageId: 'wamid.old', interpretation: {}, ai: {}, writerInput: null });
  assert.equal('presented_codes' in completados[0], false);
  assert.equal('media_sent' in completados[0], false);
  assert.deepEqual(fotos, []);
});

test('galeria pedida: usa ui.photo_target_codes del paquete, no el texto', async () => {
  const fotos = [];
  const packet = { packet_version: 2, presentation: null, ui: { message_kind: 'photos', photo_target_codes: ['LF-404'] }, deterministic_text: 'Aquí van' };
  const pms = {
    async processClosedPilotCommercial() { return { outboxes: [{ id: 71 }], authorized_response_packet: packet }; },
    async claimClosedPilotOutbound() { return { outbox_id: 71, claimable: true, recipient_kind: 'guest', recipient_phone: guest,
      message_kind: 'photos', message_text: 'Aquí tienes fotos de LF-210' }; },
    async completeClosedPilotOutbound() {}
  };
  const dispatcher = createM0ClosedPilotDispatcher({ config, pms, logger: silencio, async sendText() { return 'w'; },
    async sendPhoto(phone, url) { fotos.push(url); return 'w'; } });
  await dispatcher.completeCommercial({ externalMessageId: 'wamid.g', interpretation: {}, ai: {} });
  assert.equal(fotos.length, 6);
  assert.ok(fotos.every((u) => u.includes('/LF-404/')));
});
