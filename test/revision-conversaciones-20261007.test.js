'use strict';

// Revision de conversaciones del 2026-10-07 (leads 115 y 116).
//  - Lead 116: `earliest_available` llega al redactor y el prompt manda darla
//    sin precio; nada de "avisos automaticos"; no repetir el "no hay".
//  - Lead 115: dos mensajes del huesped con 7 s de diferencia; la aclaracion
//    del primero (pedia las personas que el segundo ya daba) no se envia si el
//    segundo ya llego y se va a procesar.

const test = require('node:test');
const assert = require('node:assert/strict');
const { writerViewOfPacket, WRITER_SYSTEM_PROMPT } = require('../lib/pilot/llm/writer.js');
const { createM0ClosedPilotDispatcher } = require('../lib/pilot/m0-closed-pilot');

const silencio = { info() {}, warn() {}, error() {} };
const guest = '573146892662', internal = '573006774425';
const config = { enabled: true, guestPhone: guest, internalPhone: internal, metaSignatureRequired: true,
  pmsM0Enabled: true, controlledIngressEnabled: true, pmsConfigured: true, receiptsEnabled: true,
  internalTemplateName: 'm0_internal_escalation_v1', internalTemplateLanguage: 'es_CO' };

test('lead 116: el redactor ve earliest_available (sin precio) y el prompt lo explica', () => {
  const vista = writerViewOfPacket({ packet_version: 2, action: 'SIN DISPONIBILIDAD -- LISTA DE ESPERA',
    earliest_available: { check_in: '2026-10-12', check_out: '2026-11-11', nights: 30, apartment_count: 1, extra: 'x' } });
  assert.deepEqual(vista.earliest_available, { check_in: '2026-10-12', check_out: '2026-11-11', nights: 30, apartment_count: 1 });
  assert.equal(writerViewOfPacket({ packet_version: 2 }).earliest_available, null);
  assert.match(WRITER_SYSTEM_PROMPT, /EARLIEST AVAILABLE/);
  assert.match(WRITER_SYSTEM_PROMPT, /NO price yet/);
  assert.match(WRITER_SYSTEM_PROMPT, /never say you do not know or do not have confirmed the first available date/);
  assert.match(WRITER_SYSTEM_PROMPT, /DO NOT REPEAT YOURSELF/);
  assert.match(WRITER_SYSTEM_PROMPT, /never talk about automatic notices/);
  assert.doesNotMatch(WRITER_SYSTEM_PROMPT, /never promise an automatic notice/);
});

function montar({ accion = 'CLARIFICAR SOLICITUD', acepta = true, segundoReclamado = true, kind = 'text' } = {}) {
  const enviados = [], completados = [];
  const packet = { packet_version: 2, action: accion, deterministic_text: 'Perfecto. ¿Para cuántas personas sería?',
    accepts: acepta ? { writer_provenance: true, superseded: true } : { writer_provenance: true },
    numbers: [], dates: [], apartments: [], required_facts: [], facts: [], forbidden_claims: [], semantic_claims: [] };
  let begins = 0;
  const pms = {
    async beginClosedPilotCommercial() { begins += 1; return { processing_claimed: begins === 1 ? true : segundoReclamado, outboxes: [] }; },
    async processClosedPilotCommercial() { return { outboxes: [{ id: 81 }], authorized_response_packet: packet }; },
    async claimClosedPilotOutbound() { return { outbox_id: 81, claimable: true, recipient_kind: 'guest', recipient_phone: guest,
      message_kind: kind, message_text: packet.deterministic_text }; },
    async completeClosedPilotOutbound(body) { completados.push(body); }
  };
  const dispatcher = createM0ClosedPilotDispatcher({ config, pms, logger: silencio,
    async sendText(to, text) { enviados.push(text); return 'wamid.out'; } });
  return { dispatcher, enviados, completados };
}

async function dosMensajes(d, { mismoSegundo = false } = {}) {
  await d.beginCommercial({ phone: guest, messageId: 'wamid.m1', occurredAt: '2026-10-07T04:17:07.000Z', deliver: false });
  await d.beginCommercial({ phone: guest, messageId: 'wamid.m2', occurredAt: mismoSegundo ? '2026-10-07T04:17:07.000Z' : '2026-10-07T04:17:15.000Z', deliver: false });
  return d.completeCommercial({ externalMessageId: 'wamid.m1', interpretation: {}, ai: {} });
}

test('lead 115: la aclaracion del primer mensaje no sale si ya llego el segundo; la fila queda "superseded"', async () => {
  const { dispatcher, enviados, completados } = montar();
  const r = await dosMensajes(dispatcher);
  assert.deepEqual(enviados, []);
  assert.deepEqual(completados, [{ outbox_id: 81, status: 'superseded' }]);
  assert.equal(r.deliveries[0].status, 'superseded');
});

test('lead 115: el mensaje mas nuevo SI se responde (no se supera a si mismo)', async () => {
  const { dispatcher, enviados } = montar();
  await dispatcher.beginCommercial({ phone: guest, messageId: 'wamid.m1', occurredAt: '2026-10-07T04:17:07.000Z', deliver: false });
  await dispatcher.beginCommercial({ phone: guest, messageId: 'wamid.m2', occurredAt: '2026-10-07T04:17:15.000Z', deliver: false });
  await dispatcher.completeCommercial({ externalMessageId: 'wamid.m2', interpretation: {}, ai: {} });
  assert.equal(enviados.length, 1);
});

test('lead 115: se envia como siempre si no hay mensaje nuevo, si no es aclaracion, si el PMS no lo acepta, si el nuevo no se procesara o si es del mismo segundo', async () => {
  for (const caso of [
    { opciones: {}, flujo: async (d) => { await d.beginCommercial({ phone: guest, messageId: 'wamid.m1', occurredAt: '2026-10-07T04:17:07.000Z', deliver: false });
      return d.completeCommercial({ externalMessageId: 'wamid.m1', interpretation: {}, ai: {} }); } },
    { opciones: { accion: 'PROPUESTA PRESENTADA' } },
    { opciones: { accion: 'ESCALAR ESTADÍA LARGA A GERENCIA' } },
    { opciones: { acepta: false } },
    { opciones: { segundoReclamado: false } },
    { opciones: { kind: 'flow' } },
    { opciones: {}, flujo: (d) => dosMensajes(d, { mismoSegundo: true }) }
  ]) {
    const { dispatcher, enviados, completados } = montar(caso.opciones);
    await (caso.flujo ? caso.flujo(dispatcher) : dosMensajes(dispatcher));
    assert.equal(completados.some((c) => c.status === 'superseded'), false, JSON.stringify(caso.opciones));
    assert.equal(enviados.length, 1, JSON.stringify(caso.opciones));
  }
});

test('lead 115: si el PMS no registra "superseded", la aclaracion se envia como siempre (nunca queda colgada)', async () => {
  const { dispatcher, enviados, completados } = montar();
  const original = completados.push.bind(completados);
  let primera = true;
  completados.push = (body) => { if (primera && body.status === 'superseded') { primera = false; throw new Error('pms_down'); } return original(body); };
  await dosMensajes(dispatcher);
  assert.equal(enviados.length, 1);
  assert.equal(completados.some((c) => c.status === 'submitted'), true);
});

test('lead 120: con earliest_available el prompt pide UNA sola decision y la lista de espera como opcion secundaria', () => {
  assert.match(WRITER_SYSTEM_PROMPT, /ONE DECISION PER MESSAGE \(lead 120/);
  assert.match(WRITER_SYSTEM_PROMPT, /do NOT say the request is \(or stays\) on the waitlist; the alternative is the ONLY question/);
  assert.ok(WRITER_SYSTEM_PROMPT.includes('Para tus fechas del <A> al <B> no tengo disponibilidad. Lo más pronto que puedo recibirlos por <N> noches es del <C> al <D>. ¿Te sirve esa fecha? Si prefieres esperar por tus fechas originales, escríbeme "lista de espera" y te aviso si se libera algo.'));
  assert.match(WRITER_SYSTEM_PROMPT, /If the guest then writes "lista de espera", just confirm/);
});
