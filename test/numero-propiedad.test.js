'use strict';

// CAMI MULTIPROPIEDAD, paquete P5 (webhook). Diseño:
// docs/02_NEGOCIO_OPERACION/A22/DISENO_CAMI_MULTIPROPIEDAD.md §5 (P5) y §8 (I1, I2, I6).
// Números FALSOS. Lo que se prueba: Miu idéntico (entrada y salida, sin el campo
// nuevo); A22 en la lista -> phone_number_id hacia el PMS; A22 fuera -> descartado;
// salida por el número de la fila (también acuse y "escribiendo"); llamada a A22
// rechazada y llamada de Miu sin cambio.
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { separarPorNumero } = require('../lib/pilot/numero-entrante');
const { extractMetaMessages } = require('../lib/pilot/meta-inbound');
const { crearCacheNumerosPropiedad, crearSalidaPorNumero, cargarDesdePms, normalizarEntradas } = require('../lib/pilot/numero-propiedad');
const { createM0ClosedPilotDispatcher } = require('../lib/pilot/m0-closed-pilot');
const { createM0CommercialResponder } = require('../lib/pilot/m0-commercial-responder');
const { PilotOrchestrator } = require('../lib/pilot/orchestrator');
const { createTypingIndicator } = require('../lib/pilot/typing-indicator');
const { readVozConfig } = require('../lib/voz/config');
const { parseOpenAiCallIncoming } = require('../lib/voz/call-events');
const { createVozCallManager } = require('../lib/voz/call-manager');

const MIU = '11111111111', A22 = '99999997555', OTRO = '55555555555', TC = '22222222222';
const HUESPED = '573001112233';
const URL_MIU = `https://graph.facebook.com/v20.0/${MIU}/messages`;
const URL_A22 = `https://graph.facebook.com/v20.0/${A22}/messages`;
const silencio = { info() {}, log() {}, warn() {}, error() {} };

const cambio = (id, texto = 'hola', wamid = 'wamid.ABCDE1') => ({ field: 'messages', value: { messaging_product: 'whatsapp',
  metadata: { phone_number_id: id, display_phone_number: '573000000000' },
  contacts: [{ wa_id: HUESPED, profile: { name: 'Ana' } }],
  messages: [{ from: HUESPED, id: wamid, timestamp: '1763900000', type: 'text', text: { body: texto } }] } });
const cuerpo = (...changes) => ({ object: 'whatsapp_business_account', entry: [{ id: 'waba', changes }] });

async function cacheCon(lista) {
  const c = crearCacheNumerosPropiedad({ cargar: async () => lista, miuId: MIU, logger: silencio });
  await c.refrescarSiVencio();
  return c;
}
const A22_ACTIVA = [{ phone_number_id: A22, property_key: 'a22', modo: 'prueba', activo: true }];
const A22_APAGADA = [{ phone_number_id: A22, property_key: 'a22', modo: 'apagada', activo: true }];

// ---------------------------------------------------------------- entrada

test('caché: por defecto vacía; ignora Miu, ids inválidos y propiedad miu; apagada no atiende pero se conoce', async () => {
  const vacia = crearCacheNumerosPropiedad({ miuId: MIU, logger: silencio });
  await vacia.refrescarSiVencio();
  assert.equal(vacia.ids().size, 0);
  assert.equal(vacia.todosIds().size, 0);
  const m = normalizarEntradas([{ phone_number_id: MIU, property_key: 'a22', modo: 'activa' },
    { phone_number_id: 'abc', property_key: 'a22', modo: 'activa' }, { phone_number_id: OTRO, property_key: 'miu', modo: 'activa' }], MIU);
  assert.equal(m.size, 0);
  const apagada = await cacheCon(A22_APAGADA);
  assert.equal(apagada.ids().has(A22), false);
  assert.equal(apagada.todosIds().has(A22), true);
  assert.equal(apagada.propiedadDe(A22), 'a22');
});

test('cargarDesdePms: 404 = lista vacía (el PMS aún no tiene la ruta); otro error se propaga', async () => {
  const no404 = cargarDesdePms({ pms: { postUrl: async () => { throw Object.assign(new Error('x'), { response: { status: 404 } }); } }, pmsBaseUrl: 'https://pms.test' });
  assert.deepEqual(await no404(), []);
  const llamadas = [];
  const ok = cargarDesdePms({ pms: { postUrl: async (url, body) => { llamadas.push(url); return { numeros: A22_ACTIVA }; } }, pmsBaseUrl: 'https://pms.test/' });
  assert.deepEqual(await ok(), A22_ACTIVA);
  assert.equal(llamadas[0], 'https://pms.test/api/supervised-pilot/propiedades/numeros');
  const falla = cargarDesdePms({ pms: { postUrl: async () => { throw Object.assign(new Error('x'), { response: { status: 500 } }); } }, pmsBaseUrl: 'https://pms.test' });
  await assert.rejects(falla());
});

test('Miu idéntico: con o sin lista de propiedades, el cuerpo de Miu es la MISMA referencia y sus mensajes no llevan phoneNumberId', () => {
  const body = cuerpo(cambio(MIU));
  const sin = separarPorNumero(body, { miuId: MIU, tengoId: TC });
  const con = separarPorNumero(body, { miuId: MIU, tengoId: TC, propiedadIds: new Set([A22]) });
  assert.equal(sin.miuBody, body);
  assert.equal(con.miuBody, body);
  assert.equal(con.propiedadChanges, 0);
  const a = extractMetaMessages(body);
  const b = extractMetaMessages(body, { propiedadIds: new Set([A22]) });
  assert.deepEqual(b, a);
  assert.equal(Object.prototype.hasOwnProperty.call(b[0], 'phoneNumberId'), false);
});

test('A22 fuera de la lista (vacía o apagada): se descarta como desconocido, igual que hoy', async () => {
  const r = separarPorNumero(cuerpo(cambio(A22)), { miuId: MIU, tengoId: TC, propiedadIds: (await cacheCon([])).ids() });
  assert.equal(r.miuBody, null);
  assert.equal(r.desconocidos, 1);
  assert.deepEqual(r.idsDesconocidos, [A22]);
  const apagada = separarPorNumero(cuerpo(cambio(A22)), { miuId: MIU, tengoId: TC, propiedadIds: (await cacheCon(A22_APAGADA)).ids() });
  assert.equal(apagada.miuBody, null);
  assert.equal(apagada.desconocidos, 1);
});

test('A22 en la lista: sigue el camino de Cami y su mensaje lleva phoneNumberId; el de Miu del mismo cuerpo no', async () => {
  const ids = (await cacheCon(A22_ACTIVA)).ids();
  const body = cuerpo(cambio(MIU, 'de miu', 'wamid.MIU001'), cambio(A22, 'de a22', 'wamid.A22001'));
  const r = separarPorNumero(body, { miuId: MIU, tengoId: TC, propiedadIds: ids });
  assert.equal(r.desconocidos, 0);
  assert.equal(r.propiedadChanges, 1);
  assert.equal(r.miuBody, body);
  const msgs = extractMetaMessages(r.miuBody, { propiedadIds: ids });
  assert.equal(msgs.length, 2);
  assert.equal(Object.prototype.hasOwnProperty.call(msgs[0], 'phoneNumberId'), false);
  assert.equal(msgs[1].phoneNumberId, A22);
});

test('una lista mal cargada nunca le quita un mensaje a Miu ni al 7355', () => {
  const ids = new Set([MIU, TC]);
  const r = separarPorNumero(cuerpo(cambio(MIU), cambio(TC)), { miuId: MIU, tengoId: TC, propiedadIds: ids });
  assert.equal(r.tengoChanges.length, 1);
  assert.equal(r.propiedadChanges, 0);
  assert.equal(normalizarEntradas([{ phone_number_id: MIU, property_key: 'a22', modo: 'activa' }], MIU).size, 0);
});

// ---------------------------------------------------------------- hacia el PMS

const config = { enabled: true, guestPhone: '573146892662', internalPhone: '573006774425', metaSignatureRequired: true,
  pmsM0Enabled: true, controlledIngressEnabled: true, pmsConfigured: true, receiptsEnabled: true,
  internalTemplateName: 'm0_internal_escalation_v1', internalTemplateLanguage: 'es_CO' };

function montarDispatcher({ claims = [], numeroSalida = null } = {}) {
  const llamadas = [], enviados = [], completados = [];
  const cola = [...claims];
  const salida = numeroSalida;
  const pms = {
    async closedPilotInbound(body) { llamadas.push(['inbound', body]); return { outboxes: [] }; },
    async beginClosedPilotCommercial(body) { llamadas.push(['begin', body]); return { processing_claimed: true, outboxes: claims.map((c) => ({ id: c.outbox_id })) }; },
    async claimClosedPilotOutbound() { return cola.shift() || { claimable: false }; },
    async completeClosedPilotOutbound(body) { completados.push(body); },
  };
  const url = () => (salida ? salida.url() : URL_MIU);
  const d = createM0ClosedPilotDispatcher({ config, pms, logger: silencio, numeroSalida: salida,
    async sendText(phone, text) { enviados.push({ phone, text, url: url() }); return `wamid.t${enviados.length}`; },
    async sendTemplate(phone, t) { enviados.push({ phone, t, url: url() }); return `wamid.p${enviados.length}`; } });
  return { d, llamadas, enviados, completados };
}

test('/closed-pilot/inbound y commercial/begin: Miu sin el campo (byte a byte); A22 con phone_number_id', async () => {
  const { d, llamadas } = montarDispatcher();
  await d.process({ phone: HUESPED, text: 'hola', messageId: 'wamid.MIU001', occurredAt: '2026-11-23T10:00:00.000Z' });
  await d.process({ phone: HUESPED, text: 'hola', messageId: 'wamid.A22001', occurredAt: '2026-11-23T10:00:00.000Z', phoneNumberId: A22 });
  await d.beginCommercial({ phone: HUESPED, messageId: 'wamid.MIU002', occurredAt: '2026-11-23T10:00:00.000Z', deliver: false });
  await d.beginCommercial({ phone: HUESPED, messageId: 'wamid.A22002', occurredAt: '2026-11-23T10:00:00.000Z', deliver: false, phoneNumberId: A22 });
  assert.equal(JSON.stringify(llamadas[0][1]), JSON.stringify({ phone: HUESPED, text: 'hola', external_message_id: 'wamid.MIU001', occurred_at: '2026-11-23T10:00:00.000Z' }));
  assert.deepEqual(llamadas[1][1], { phone: HUESPED, text: 'hola', external_message_id: 'wamid.A22001', occurred_at: '2026-11-23T10:00:00.000Z', phone_number_id: A22 });
  assert.equal(JSON.stringify(llamadas[2][1]), JSON.stringify({ phone: HUESPED, external_message_id: 'wamid.MIU002', occurred_at: '2026-11-23T10:00:00.000Z' }));
  assert.deepEqual(llamadas[3][1], { phone: HUESPED, external_message_id: 'wamid.A22002', occurred_at: '2026-11-23T10:00:00.000Z', phone_number_id: A22 });
});

test('captura (whatsapp inbound) y begin desde el responder: Miu sin el campo; A22 con phone_number_id', async () => {
  const capturas = [];
  const orq = new PilotOrchestrator({ pms: { capture: async (b) => { capturas.push(b); return { ok: true }; } }, ai: {}, context: {}, logger: silencio });
  const { d, llamadas } = montarDispatcher();
  const responder = createM0CommercialResponder({ capture: (p) => orq.capture(p), ai: {}, closedPilot: d, pms: {}, logger: silencio });
  await responder.captureAndAcknowledge({ from: HUESPED, text: 'hola', messageId: 'wamid.MIU003', timestamp: '2026-11-23T10:00:00.000Z' });
  await responder.captureAndAcknowledge({ from: HUESPED, text: 'hola', messageId: 'wamid.A22003', timestamp: '2026-11-23T10:00:00.000Z', phoneNumberId: A22 });
  assert.equal(Object.prototype.hasOwnProperty.call(capturas[0], 'phone_number_id'), false);
  assert.equal(capturas[1].phone_number_id, A22);
  const { phone_number_id: _x, ...restoA22 } = capturas[1];
  assert.equal(JSON.stringify({ ...restoA22, external_message_id: 'wamid.MIU003' }), JSON.stringify(capturas[0]));
  assert.equal(Object.prototype.hasOwnProperty.call(llamadas[0][1], 'phone_number_id'), false);
  assert.equal(llamadas[1][1].phone_number_id, A22);
});

// ---------------------------------------------------------------- salida

const filaTexto = (extra = {}) => ({ outbox_id: 5, claimable: true, recipient_kind: 'guest', message_kind: 'text',
  recipient_phone: HUESPED, message_text: 'Hola, soy Cami', ...extra });

test('salida: fila con el número de A22 sale por A22; sin número (o miu) sale por Miu como hoy', async () => {
  const cache = await cacheCon(A22_ACTIVA);
  const salida = crearSalidaPorNumero({ miuId: MIU, numerosPropiedad: cache });
  assert.equal(salida.url(), URL_MIU);
  const { d, enviados } = montarDispatcher({ numeroSalida: salida, claims: [
    filaTexto({ outbox_id: 1, phone_number_id: A22, property_key: 'a22' }),
    filaTexto({ outbox_id: 2 }),
    filaTexto({ outbox_id: 3, property_key: 'miu' }),
    filaTexto({ outbox_id: 4, phone_number_id: MIU, property_key: 'miu' })] });
  const r = await d.deliverCommercialOutboxes([{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }]);
  assert.deepEqual(r.map((x) => x.status), ['submitted', 'submitted', 'submitted', 'submitted']);
  assert.deepEqual(enviados.map((e) => e.url), [URL_A22, URL_MIU, URL_MIU, URL_MIU]);
  assert.equal(salida.url(), URL_MIU);
});

test('salida: fila de otra propiedad sin número, o con un número desconocido, NO sale (ni por Miu)', async () => {
  const salida = crearSalidaPorNumero({ miuId: MIU, numerosPropiedad: await cacheCon(A22_ACTIVA) });
  const { d, enviados, completados } = montarDispatcher({ numeroSalida: salida, claims: [
    filaTexto({ outbox_id: 7, property_key: 'a22' }), filaTexto({ outbox_id: 8, phone_number_id: OTRO, property_key: 'a22' })] });
  const r = await d.deliverCommercialOutboxes([{ id: 7 }, { id: 8 }]);
  assert.equal(enviados.length, 0);
  assert.deepEqual(r.map((x) => x.error_code), ['m0_closed_property_number_missing', 'm0_closed_property_number_missing']);
  assert.deepEqual(completados, [{ outbox_id: 7, status: 'failed' }, { outbox_id: 8, status: 'failed' }]);
});

test('salida por el sondeo (ticks, CEM, RETOMAR, mini Teo): también por el número de la fila', async () => {
  const salida = crearSalidaPorNumero({ miuId: MIU, numerosPropiedad: await cacheCon(A22_ACTIVA) });
  const { d, enviados } = montarDispatcher({ numeroSalida: salida, claims: [
    filaTexto({ outbox_id: 11, phone_number_id: A22, property_key: 'a22' }), filaTexto({ outbox_id: 12 })] });
  const r = await d.pollPendingInternalOutbox();
  assert.deepEqual(r.map((x) => x.status), ['submitted', 'submitted']);
  assert.deepEqual(enviados.map((e) => e.url), [URL_A22, URL_MIU]);
});

test('acuse (outbox del begin): sale por el número de A22', async () => {
  const salida = crearSalidaPorNumero({ miuId: MIU, numerosPropiedad: await cacheCon(A22_ACTIVA) });
  const acuse = filaTexto({ outbox_id: 21, phone_number_id: A22, property_key: 'a22', message_text: 'Ya te respondo' });
  const { d, enviados } = montarDispatcher({ numeroSalida: salida, claims: [acuse] });
  const begin = await d.beginCommercial({ phone: HUESPED, messageId: 'wamid.A22004', occurredAt: '2026-11-23T10:00:00.000Z', deliver: false, phoneNumberId: A22 });
  await d.deliverCommercialOutboxes(begin.result.outboxes, begin);
  assert.deepEqual(enviados.map((e) => e.url), [URL_A22]);
});

test('sin numeroSalida (dispatcher de antes): todo sale como hoy', async () => {
  const { d, enviados } = montarDispatcher({ claims: [filaTexto({ outbox_id: 31, phone_number_id: A22, property_key: 'a22' })] });
  const r = await d.deliverCommercialOutboxes([{ id: 31 }]);
  assert.equal(r[0].status, 'submitted');
  assert.equal(enviados[0].url, URL_MIU);
});

test('"escribiendo": con el número de A22 sale por A22; sin número, la llamada es la de siempre', async () => {
  const salida = crearSalidaPorNumero({ miuId: MIU, numerosPropiedad: await cacheCon(A22_ACTIVA) });
  const envios = [];
  const t = createTypingIndicator({ enabled: true, logger: silencio,
    send: (payload, opciones) => { envios.push({ args: opciones === undefined ? 1 : 2, url: salida.urlParaEntrante(opciones?.phoneNumberId) }); return Promise.resolve(); } });
  await t.show('wamid.MIU005');
  await t.show('wamid.A22005', { phoneNumberId: A22 });
  await t.show('wamid.X', { phoneNumberId: OTRO });
  assert.deepEqual(envios, [{ args: 1, url: URL_MIU }, { args: 2, url: URL_A22 }, { args: 2, url: URL_MIU }]);
});

// ---------------------------------------------------------------- llamadas

class FakeWs extends EventEmitter {
  constructor(url, opts) { super(); this.url = url; this.opts = opts; this.readyState = 1; }
  send() {}
  close() { this.readyState = 3; this.emit('close'); }
}
const llamada = (callId, destino) => parseOpenAiCallIncoming({ type: 'realtime.call.incoming', data: { call_id: callId, sip_headers: [
  { name: 'From', value: `<sip:+${HUESPED}@sip.example>` }, { name: 'To', value: '<sip:+573054537379@sip.example>' }, { name: 'X-WA-Meta-Wacid', value: 'wacid.X' },
  ...(destino ? [{ name: 'x-wa-meta-phone-number-id', value: destino }] : [])] } });

async function montarVoz(lista = A22_ACTIVA) {
  const posts = [], pmsL = [], logs = [];
  const cache = await cacheCon(lista);
  const config = readVozConfig({ VOZ_LLAMADAS_HABILITADAS: 'true', VOZ_OPENAI_API_KEY: 'sk-test-no-real', PHONE_NUMBER_ID: MIU, TENGOCAMELLO_PHONE_NUMBER_ID: TC });
  const http = { post: async (url, body) => { posts.push({ url, body }); return { data: {} }; } };
  const pms = { vozInicio: async (b) => { pmsL.push(['inicio', b]); return { llamada_id: 1, lead_id: null, uso_mes_usd: 0 }; },
    vozEstado: async (b) => { pmsL.push(['estado', b]); return { estado: b.estado }; }, vozFin: async () => ({}) };
  const logger = { info: (m, d) => logs.push([m, d]), warn: (m, d) => logs.push([m, d]), error: (m, d) => logs.push([m, d]) };
  const timers = { setTimeout: () => 1, clearTimeout: () => {} };
  const manager = createVozCallManager({ config, http, WebSocketImpl: FakeWs, pms, timers, logger, executePmsTool: async () => ({}),
    sendText: async () => {}, sendImage: async () => {},
    numerosPropiedad: { todosIds: () => cache.todosIds(), refrescarSiVencio: () => cache.refrescarSiVencio(), propiedadDe: (id) => cache.propiedadDe(id) } });
  return { manager, posts, pmsL, logs };
}

test('llamada al número de A22 (también apagada): se rechaza, nunca llega a Cami de Miu, y se registra la cabecera', async () => {
  for (const lista of [A22_ACTIVA, A22_APAGADA]) {
    const v = await montarVoz(lista);
    await v.manager._interno.atender(llamada('rtc_a22', A22));
    assert.ok(v.posts.some((p) => p.url.endsWith('/reject')));
    assert.equal(v.posts.some((p) => p.url.endsWith('/accept')), false);
    assert.equal(v.pmsL.length, 0);
    const rechazo = v.logs.find(([m]) => m === '[voz] llamada_a22_rechazada');
    assert.ok(rechazo);
    assert.equal(rechazo[1].destino_id_presente, true);
    assert.equal(rechazo[1].property_key, 'a22');
    assert.equal(v.logs.find(([m]) => m === '[voz] llamada_entrante')[1].numero, 'propiedad');
  }
});

test('llamada de Miu sin cambio: con su número o sin cabecera sigue a Cami de Miu y el log dice si vino la cabecera', async () => {
  const conId = await montarVoz();
  await conId.manager._interno.atender(llamada('rtc_miu', MIU));
  assert.equal(conId.pmsL[0][0], 'inicio');
  assert.equal(conId.posts.some((p) => p.url.endsWith('/reject')), false);
  const e1 = conId.logs.find(([m]) => m === '[voz] llamada_entrante')[1];
  assert.equal(e1.numero, 'miu');
  assert.equal(e1.destino_id_presente, true);
  const sin = await montarVoz();
  await sin.manager._interno.atender(llamada('rtc_sin', null));
  assert.equal(sin.pmsL[0][0], 'inicio');
  assert.equal(sin.posts.some((p) => p.url.endsWith('/reject')), false);
  assert.equal(sin.logs.find(([m]) => m === '[voz] llamada_entrante')[1].destino_id_presente, false);
  assert.equal(sin.logs.some(([m]) => m === '[voz] llamada_a22_rechazada'), false);
});

test('index.js: el envío de Miu sigue siendo WHATSAPP_API_URL fuera de una fila de propiedad, y el cargador nace vacío', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  assert.match(src, /crearCacheNumerosPropiedad\(\{ cargar: async \(\) => \[\]/);
  assert.match(src, /numeroSalida: salidaPorNumero/);
  assert.doesNotMatch(src, /axios\.post\(WHATSAPP_API_URL,/);
  assert.match(src, /M0_CLOSED_PILOT_ENABLED && propiedadIds\?\.size \? propiedadIds : null/);
});
