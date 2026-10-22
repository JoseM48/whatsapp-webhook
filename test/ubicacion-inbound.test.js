'use strict';

// Alistamiento v2 (José Manuel, 2026-10-21): un mensaje de WhatsApp tipo
// `location` llega al PMS con sus coordenadas en el campo `ubicacion`.
// Datos ficticios.

const test = require('node:test');
const assert = require('node:assert/strict');
const { extractMetaMessages, m0CommercialText, ubicacionDeMensaje } = require('../lib/pilot/meta-inbound');
const { PilotOrchestrator } = require('../lib/pilot/orchestrator');
const { createM0CommercialResponder } = require('../lib/pilot/m0-commercial-responder');

function payloadCon(message) {
  return { entry: [{ changes: [{ value: {
    contacts: [{ wa_id: '573000000099', profile: { name: 'Prueba' } }],
    messages: [{ id: 'wamid.loc.1', from: '573000000099', timestamp: '1787688000', ...message }]
  } }] }] };
}

test('un mensaje location trae ubicacion normalizada y conserva el texto marcador', () => {
  const [m] = extractMetaMessages(payloadCon({ type: 'location',
    location: { latitude: 6.2001, longitude: -75.5701, name: 'Edificio ficticio', address: 'Calle 1 # 2-3' } }));
  assert.deepEqual(m.ubicacion, { latitud: 6.2001, longitud: -75.5701, nombre: 'Edificio ficticio', direccion: 'Calle 1 # 2-3' });
  assert.equal(m.text, null);
  assert.equal(m.messageType, 'location');
  assert.equal(m0CommercialText(m), '[M0_UNSUPPORTED_INBOUND:location]');
});

test('ubicacion sin nombre ni direccion: ambos null; coordenadas en texto se convierten a numero', () => {
  const [m] = extractMetaMessages(payloadCon({ type: 'location', location: { latitude: '6.25', longitude: '-75.6' } }));
  assert.deepEqual(m.ubicacion, { latitud: 6.25, longitud: -75.6, nombre: null, direccion: null });
});

test('mensajes que no son location llevan ubicacion null', () => {
  const [m] = extractMetaMessages(payloadCon({ type: 'text', text: { body: 'Hola' } }));
  assert.equal(m.ubicacion, null);
});

test('coordenadas invalidas o ausentes: ubicacion null (el PMS la trata como no legible)', () => {
  for (const location of [undefined, null, {}, { latitude: 'abc', longitude: 1 }, { latitude: 91, longitude: 0 },
    { latitude: 0, longitude: 181 }, { latitude: null, longitude: null }, { latitude: '', longitude: '' }, { latitude: ' ', longitude: 1 },
    { latitude: true, longitude: 1 }, { latitude: [5], longitude: 1 }]) {
    assert.equal(ubicacionDeMensaje({ type: 'location', location }), null, JSON.stringify(location));
  }
  assert.equal(ubicacionDeMensaje({ type: 'text', location: { latitude: 1, longitude: 1 } }), null);
  assert.deepEqual(ubicacionDeMensaje({ type: 'location', location: { latitude: -90, longitude: 180 } }),
    { latitud: -90, longitud: 180, nombre: null, direccion: null });
});

test('nombre y direccion se recortan a los limites del esquema del PMS (200 / 300)', () => {
  const u = ubicacionDeMensaje({ type: 'location',
    location: { latitude: 1, longitude: 2, name: 'n'.repeat(500), address: 'd'.repeat(500) } });
  assert.equal(u.nombre.length, 200);
  assert.equal(u.direccion.length, 300);
  const v = ubicacionDeMensaje({ type: 'location', location: { latitude: 1, longitude: 2, name: 42, address: '   ' } });
  assert.equal(v.nombre, null);
  assert.equal(v.direccion, null);
});

test('el orquestador manda ubicacion al PMS solo cuando existe', async () => {
  const bodies = [];
  const orchestrator = new PilotOrchestrator({ pms: { capture: async (body) => { bodies.push(body); return {}; } },
    context: {}, logger: { info() {}, warn() {}, error() {} } });
  const ubicacion = { latitud: 6.2, longitud: -75.5, nombre: null, direccion: null };
  await orchestrator.capture({ from: '573000000099', text: '[M0_UNSUPPORTED_INBOUND:location]', messageId: 'wamid.a',
    timestamp: '2026-10-22T15:00:00.000Z', ubicacion });
  await orchestrator.capture({ from: '573000000099', text: 'Hola', messageId: 'wamid.b', timestamp: '2026-10-22T15:00:00.000Z' });
  assert.deepEqual(bodies[0].ubicacion, ubicacion);
  assert.equal(bodies[0].mensaje, '[M0_UNSUPPORTED_INBOUND:location]');
  assert.equal(bodies[1].ubicacion, undefined);
  assert.equal('ubicacion' in JSON.parse(JSON.stringify(bodies[1])), false);
});

test('captureAndAcknowledge pasa ubicacion a la captura', async () => {
  const capturas = [];
  const responder = createM0CommercialResponder({
    async capture(payload) { capturas.push(payload); return { captured: true }; },
    ai: { async interpret() { throw new Error('not_expected'); } },
    closedPilot: { async beginCommercial() { return { result: { processing_claimed: false, outboxes: [] }, deliveries: [] }; } },
    pms: { async processingFailure() {} }
  });
  const ubicacion = { latitud: 6.2, longitud: -75.5, nombre: null, direccion: null };
  await responder.captureAndAcknowledge({ from: '573000000099', text: '[M0_UNSUPPORTED_INBOUND:location]',
    messageId: 'wamid.c', timestamp: '2026-10-22T15:00:00.000Z', ubicacion });
  await responder.captureAndAcknowledge({ from: '573000000099', text: 'Hola', messageId: 'wamid.d', timestamp: '2026-10-22T15:00:00.000Z' });
  assert.deepEqual(capturas[0].ubicacion, ubicacion);
  assert.equal(capturas[1].ubicacion, null);
});
