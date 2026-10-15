'use strict';

// LEAD 99 (2026-10-15 UTC).
//  - 13:08 "Tiene otros servicios elmedificio" + "?" y 13:12 "Gracias" + "Me.
//    Vuelvo a comunicar...": dos respuestas casi iguales en cada rafaga. El PMS
//    ahora absorbe el mensaje sin contenido en la respuesta anterior y lo marca
//    `sin_contenido_nuevo` al iniciar el turno: ese mensaje NO deja superada la
//    respuesta anterior (si no, el huesped se quedaria sin ninguna).
//  - 13:30 re-cotizacion con "LF-1109 LF-1109:": el redactor escribio el codigo
//    justo antes de [[PRECIOS]] y el bloque ya empieza por el codigo.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createM0ClosedPilotDispatcher } = require('../lib/pilot/m0-closed-pilot');
const { insertarBloquePrecios } = require('../lib/pilot/llm/writer.js');

const silencio = { info() {}, warn() {}, error() {} };
const guest = '573001112299', internal = '573006774425';
const config = { enabled: true, guestPhone: guest, internalPhone: internal, metaSignatureRequired: true,
  pmsM0Enabled: true, controlledIngressEnabled: true, pmsConfigured: true, receiptsEnabled: true,
  internalTemplateName: 'm0_internal_escalation_v1', internalTemplateLanguage: 'es_CO' };
const ACEPTA = { writer_provenance: true, superseded: true, superseded_reason: true };
const paquete = (action, texto, extra = {}) => ({ packet_version: 2, action, deterministic_text: texto, accepts: ACEPTA,
  numbers: [], dates: [], apartments: [], required_facts: [], facts: [], forbidden_claims: [], semantic_claims: [], ...extra });

// turnos: messageId -> { at, packet|null (absorbido: sin fila), sinContenido }
function montar(turnos) {
  const enviados = [], completados = [];
  const ids = new Map(Object.keys(turnos).map((m, i) => [m, 100 + i]));
  const porOutbox = new Map([...ids].map(([m, id]) => [id, turnos[m].packet]));
  const pms = {
    async beginClosedPilotCommercial({ external_message_id: m }) {
      return { processing_claimed: true, outboxes: [], ...(turnos[m].sinContenido !== undefined ? { sin_contenido_nuevo: turnos[m].sinContenido } : {}) };
    },
    async processClosedPilotCommercial({ external_message_id: m }) {
      return turnos[m].packet ? { outboxes: [{ id: ids.get(m) }], authorized_response_packet: turnos[m].packet } : { outboxes: [] };
    },
    async claimClosedPilotOutbound(id) {
      return { outbox_id: id, claimable: true, recipient_kind: 'guest', recipient_phone: guest,
        message_kind: 'text', message_text: porOutbox.get(id).deterministic_text };
    },
    async completeClosedPilotOutbound(body) { completados.push(body); }
  };
  const dispatcher = createM0ClosedPilotDispatcher({ config, pms, logger: silencio,
    async sendText(to, text) { enviados.push(text); return `wamid.out${enviados.length}`; } });
  const llega = (m) => dispatcher.beginCommercial({ phone: guest, messageId: m, occurredAt: turnos[m].at, deliver: false });
  const responde = (m) => dispatcher.completeCommercial({ externalMessageId: m, interpretation: {}, ai: {} });
  return { enviados, completados, llega, responde };
}

const CON_GUSTO = 'Con mucho gusto, Miguel. Aquí estoy cuando lo necesites.';

test('lead 99 13:12: "Gracias" (respuesta superable) + "Me vuelvo a comunicar" (absorbido por el PMS) -> sale UNA respuesta', async () => {
  const turnos = {
    'w.gracias': { at: '2026-10-15T13:12:01Z', sinContenido: true, packet: paquete('CORTESÍA', CON_GUSTO, { supersedable: true }) },
    'w.vuelvo': { at: '2026-10-15T13:12:05Z', sinContenido: true, packet: null } };
  const { enviados, completados, llega, responde } = montar(turnos);
  for (const m of Object.keys(turnos)) await llega(m);
  for (const m of Object.keys(turnos)) await responde(m);
  assert.deepEqual(enviados, [CON_GUSTO]);
  assert.equal(completados.filter((c) => c.status === 'superseded').length, 0);
});

test('un mensaje CON contenido si deja superada la respuesta superable anterior (lead 131, sin cambios)', async () => {
  const turnos = {
    'w.gracias': { at: '2026-10-15T13:12:01Z', sinContenido: true, packet: paquete('CORTESÍA', CON_GUSTO, { supersedable: true }) },
    'w.parqueo': { at: '2026-10-15T13:12:05Z', sinContenido: false, packet: paquete('RESPUESTA', 'Sí, hay parqueadero.') } };
  const { enviados, completados, llega, responde } = montar(turnos);
  for (const m of Object.keys(turnos)) await llega(m);
  for (const m of Object.keys(turnos)) await responde(m);
  assert.deepEqual(enviados, ['Sí, hay parqueadero.']);
  assert.deepEqual(completados[0], { outbox_id: 100, status: 'superseded', superseded_reason: 'turno_siguiente' });
});

test('con un PMS anterior (sin el campo) todo sigue como antes: el segundo mensaje deja superada la respuesta', async () => {
  const turnos = {
    'w.a': { at: '2026-10-15T13:12:01Z', packet: paquete('CORTESÍA', CON_GUSTO, { supersedable: true }) },
    'w.b': { at: '2026-10-15T13:12:05Z', packet: paquete('CORTESÍA', 'Claro, Miguel. Quedo atenta.', { supersedable: true }) } };
  const { enviados, llega, responde } = montar(turnos);
  for (const m of Object.keys(turnos)) await llega(m);
  for (const m of Object.keys(turnos)) await responde(m);
  assert.deepEqual(enviados, ['Claro, Miguel. Quedo atenta.']);
});

test('lead 99 13:30: el codigo escrito justo antes de [[PRECIOS]] no se duplica', () => {
  const BLOQUE = 'LF-1109: $3.300.000 al mes · 30 noches\n\nValor fijo durante tu estadía.';
  const paq = { price_presentation: { placeholder: '[[PRECIOS]]', block_text: BLOQUE, block_codes: ['LF-1109'] } };
  for (const [escrito, esperado] of [
    ['Claro, Miguel. Te comparto el valor del LF-1109 [[PRECIOS]]\n¿Te sirve?', `Claro, Miguel. Te comparto el valor\n${BLOQUE}\n¿Te sirve?`],
    ['Claro, Miguel. Para el LF-1109:\n[[PRECIOS]]\n¿Te sirve?', `Claro, Miguel.\n${BLOQUE}\n¿Te sirve?`],
    ['LF-1109 [[PRECIOS]]', BLOQUE],
    // Sin el codigo delante, igual que siempre.
    ['Claro, Miguel:\n[[PRECIOS]]\n¿Te sirve?', `Claro, Miguel:\n${BLOQUE}\n¿Te sirve?`],
    // Otro codigo delante no se toca.
    ['Comparado con el LF-210:\n[[PRECIOS]]', `Comparado con el LF-210:\n${BLOQUE}`]])
    assert.equal(insertarBloquePrecios(paq, escrito, ['LF-1109']), esperado, escrito);
});
