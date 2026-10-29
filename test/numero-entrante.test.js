'use strict';

// SEGUNDO NÚMERO DE WHATSAPP: TenGo Camello (2026-10-28). Ids y teléfonos FALSOS.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { separarPorNumero, atenderTengoCamello, whatsappMessagesUrl, RUTA_PMS_TENGOCAMELLO } = require('../lib/pilot/numero-entrante');
const { extractMetaMessages } = require('../lib/pilot/meta-inbound');
const { parseOpenAiCallIncoming } = require('../lib/voz/call-events');
const { readVozConfig } = require('../lib/voz/config');
const { createVozCallManager } = require('../lib/voz/call-manager');

const MIU = '100000000000001';
const TC = '200000000000002';
const OTRO = '300000000000003';

function cambio(phoneNumberId, { texto = 'hola', from = '573000000901', field = 'messages', calls = null, statuses = null } = {}) {
  const value = { messaging_product: 'whatsapp' };
  if (phoneNumberId !== undefined) value.metadata = { phone_number_id: phoneNumberId, display_phone_number: '570000000000' };
  if (calls) value.calls = calls;
  else if (statuses) value.statuses = statuses;
  else {
    value.contacts = [{ wa_id: from, profile: { name: 'Prueba' } }];
    value.messages = [{ from, id: `wamid.${Math.random().toString(36).slice(2)}`, timestamp: '1761600000', type: 'text', text: { body: texto } }];
  }
  return { field, value };
}
const cuerpo = (...changes) => ({ object: 'whatsapp_business_account', entry: [{ id: 'waba', changes }] });

test('Miu: mismo phone_number_id -> el cuerpo pasa intacto (misma referencia)', () => {
  const body = cuerpo(cambio(MIU));
  const r = separarPorNumero(body, { miuId: MIU, tengoId: TC });
  assert.equal(r.miuBody, body);
  assert.deepEqual(r.tengoChanges, []);
  assert.equal(r.desconocidos, 0);
});

test('Miu: sin metadata -> camino de Miu igual que hoy', () => {
  const body = cuerpo(cambio(undefined));
  assert.equal(separarPorNumero(body, { miuId: MIU, tengoId: TC }).miuBody, body);
});

test('TenGo: va a su camino y NO llega a Miu', () => {
  const body = cuerpo(cambio(TC));
  const r = separarPorNumero(body, { miuId: MIU, tengoId: TC });
  assert.equal(r.miuBody, null);
  assert.equal(r.tengoChanges.length, 1);
  assert.equal(extractMetaMessages(r.miuBody || {}).length, 0);
});

test('Variable TENGOCAMELLO ausente: un mensaje a otro número se ignora (fail-closed)', () => {
  const r = separarPorNumero(cuerpo(cambio(TC)), { miuId: MIU, tengoId: '' });
  assert.equal(r.miuBody, null);
  assert.equal(r.tengoChanges.length, 0);
  assert.equal(r.desconocidos, 1);
});

test('Número desconocido: se ignora sin responder', () => {
  const r = separarPorNumero(cuerpo(cambio(OTRO)), { miuId: MIU, tengoId: TC });
  assert.equal(r.miuBody, null);
  assert.equal(r.desconocidos, 1);
  assert.deepEqual(r.idsDesconocidos, [OTRO]);
});

test('Mezcla: Miu conserva solo lo suyo; TenGo y desconocido salen', () => {
  const miu = cambio(MIU, { texto: 'miu' });
  const r = separarPorNumero(cuerpo(miu, cambio(TC), cambio(OTRO)), { miuId: MIU, tengoId: TC });
  assert.deepEqual(r.miuBody.entry[0].changes, [miu]);
  assert.equal(r.tengoChanges.length, 1);
  assert.equal(r.desconocidos, 1);
});

test('Llamadas y statuses del número TenGo no llegan a Miu', () => {
  const body = cuerpo(cambio(TC, { field: 'calls', calls: [{ id: 'wacid.1', event: 'connect', from: '573000000901' }] }),
    cambio(TC, { statuses: [{ id: 'wamid.s', status: 'delivered', recipient_id: '573000000901', timestamp: '1761600000' }] }));
  const r = separarPorNumero(body, { miuId: MIU, tengoId: TC });
  assert.equal(r.miuBody, null);
  assert.equal(r.tengoChanges.length, 2);
});

test('envío: la URL usa el número que se pasa (TenGo sale desde TenGo)', () => {
  assert.equal(whatsappMessagesUrl(TC), `https://graph.facebook.com/v20.0/${TC}/messages`);
});

test('camino TenGo: reenvía al PMS, envía solo si responder=true, ignora llamadas', async () => {
  const llamadas = [];
  const enviados = [];
  const pms = { postUrl: async (url, body) => { llamadas.push({ url, body }); return { responder: true, mensajes: ['Hola, soy Cami de TenGo Camello.', 'Menú'], action: 'X' }; } };
  const logs = [];
  const logger = { info: () => {}, warn: (m) => logs.push(m), error: (m) => logs.push(m) };
  const r = await atenderTengoCamello([cambio(TC, { texto: 'CAMELLO' }),
    cambio(TC, { field: 'calls', calls: [{ id: 'wacid.1', event: 'connect' }] })],
  { pms, pmsBaseUrl: 'https://pms.example', enviarTexto: async (to, b) => enviados.push({ to, b }), extractMetaMessages, logger });
  assert.equal(llamadas.length, 1);
  assert.equal(llamadas[0].url, `https://pms.example${RUTA_PMS_TENGOCAMELLO}`);
  assert.equal(llamadas[0].body.text, 'CAMELLO');
  assert.deepEqual(enviados.map((e) => e.b), ['Hola, soy Cami de TenGo Camello.', 'Menú']);
  assert.equal(r.ignorados, 1);
  assert.ok(logs.includes('[tengocamello] llamada_ignorada'));
});

test('camino TenGo: con la política apagada (responder=false) no envía nada', async () => {
  const enviados = [];
  await atenderTengoCamello([cambio(TC)], { pms: { postUrl: async () => ({ responder: false, mensajes: [] }) }, pmsBaseUrl: 'https://pms.example',
    enviarTexto: async (to, b) => enviados.push(b), extractMetaMessages, logger: { info() {}, warn() {}, error() {} } });
  assert.deepEqual(enviados, []);
});

test('camino TenGo: si el PMS falla no envía y no lanza', async () => {
  const enviados = [];
  await atenderTengoCamello([cambio(TC)], { pms: { postUrl: async () => { throw Object.assign(new Error('x'), { code: 'ECONNREFUSED' }); } },
    pmsBaseUrl: 'https://pms.example', enviarTexto: async (to, b) => enviados.push(b), extractMetaMessages, logger: { info() {}, warn() {}, error() {} } });
  assert.deepEqual(enviados, []);
});

test('index.js: el envío de Miu sigue con PHONE_NUMBER_ID y el ruteo va antes de las llamadas', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  assert.match(src, /const WHATSAPP_API_URL = `https:\/\/graph\.facebook\.com\/v20\.0\/\$\{process\.env\.PHONE_NUMBER_ID\}\/messages`;/);
  assert.match(src, /sendWhatsAppTextFrom\(TENGOCAMELLO_PHONE_NUMBER_ID, to, body\)/);
  assert.match(src, /numero_desconocido_ignorado', \{ count: ruteo\.desconocidos, phone_number_ids: ruteo\.idsDesconocidos \}/);
  assert.ok(src.indexOf('separarPorNumero(req.body') < src.indexOf('extractMetaCalls(req.body)'));
});

test('voz: una llamada al número de TenGo Camello se rechaza sin PMS ni WhatsApp (no llega a Cami de Miu)', async () => {
  const entrada = parseOpenAiCallIncoming({ type: 'realtime.call.incoming', data: { call_id: 'rtc_tc_1', sip_headers: [
    { name: 'From', value: '<sip:+573000000901@sip.example>' }, { name: 'To', value: '<sip:+570000000222@sip.example>' }] } });
  assert.equal(entrada.destino, '570000000222');
  const config = readVozConfig({ VOZ_LLAMADAS_HABILITADAS: 'true', VOZ_OPENAI_API_KEY: 'k', TENGOCAMELLO_DISPLAY_PHONE_NUMBER: '+57 000 000 0222' });
  assert.deepEqual(config.destinosAjenos, ['570000000222']);
  const posts = [];
  const pmsLlamado = [];
  const pms = new Proxy({}, { get: (_t, k) => async () => { pmsLlamado.push(k); return {}; } });
  const textos = [];
  const manager = createVozCallManager({ config, http: { post: async (url) => { posts.push(url); return { data: {} }; } }, WebSocketImpl: class {},
    pms, executePmsTool: async () => ({}), sendText: async (to, b) => textos.push(b), logger: { info() {}, warn() {}, error() {} } });
  await manager._interno.atender(entrada);
  assert.equal(posts.length, 1);
  assert.match(posts[0], /\/realtime\/calls\/rtc_tc_1\/reject$/);
  assert.deepEqual(pmsLlamado, []);
  assert.deepEqual(textos, []);
});
