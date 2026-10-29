'use strict';

// NÚMERO DEMO COMPARTIDO DE TENGO CAMELLO (beta, 2026-10-28; PMS migración 1060).
// Ids y teléfonos FALSOS.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { separarPorNumero, atenderTengoCamelloDemo, despacharSalidasTengoCamelloDemo, atenderTengoCamello,
  RUTA_PMS_TC_DEMO, RUTA_PMS_TC_DEMO_RECLAMAR, RUTA_PMS_TENGOCAMELLO } = require('../lib/pilot/numero-entrante');
const { extractMetaMessages } = require('../lib/pilot/meta-inbound');

const MIU = '100000000000001';
const TC = '200000000000002';
const DEMO = '400000000000004';
const OTRO = '300000000000003';
const silencioso = { info() {}, warn() {}, error() {} };

function cambio(phoneNumberId, { texto = 'PANA01', from = '573000000991', field = 'messages', calls = null } = {}) {
  const value = { messaging_product: 'whatsapp', metadata: { phone_number_id: phoneNumberId, display_phone_number: '570000000000' } };
  if (calls) value.calls = calls;
  else {
    value.contacts = [{ wa_id: from, profile: { name: 'Prueba' } }];
    value.messages = [{ from, id: `wamid.${Math.random().toString(36).slice(2)}`, timestamp: '1761600000', type: 'text', text: { body: texto } }];
  }
  return { field, value };
}
const cuerpo = (...changes) => ({ object: 'whatsapp_business_account', entry: [{ id: 'waba', changes }] });

test('demo: va a su camino; no llega a Miu ni al 7355', () => {
  const r = separarPorNumero(cuerpo(cambio(DEMO)), { miuId: MIU, tengoId: TC, demoId: DEMO });
  assert.equal(r.miuBody, null);
  assert.equal(r.demoChanges.length, 1);
  assert.equal(r.tengoChanges.length, 0);
  assert.equal(r.desconocidos, 0);
});

test('demo: Miu sigue intacto (misma referencia) y el 7355 igual que antes', () => {
  const body = cuerpo(cambio(MIU));
  const r = separarPorNumero(body, { miuId: MIU, tengoId: TC, demoId: DEMO });
  assert.equal(r.miuBody, body);
  assert.deepEqual(r.demoChanges, []);
  const t = separarPorNumero(cuerpo(cambio(TC)), { miuId: MIU, tengoId: TC, demoId: DEMO });
  assert.equal(t.tengoChanges.length, 1);
  assert.equal(t.demoChanges.length, 0);
});

test('demo: variable ausente -> el número demo se ignora (fail-closed)', () => {
  const r = separarPorNumero(cuerpo(cambio(DEMO)), { miuId: MIU, tengoId: TC, demoId: '' });
  assert.equal(r.miuBody, null);
  assert.equal(r.demoChanges.length, 0);
  assert.equal(r.desconocidos, 1);
  // Sin pasar demoId (llamada antigua) tampoco cambia nada.
  assert.equal(separarPorNumero(cuerpo(cambio(DEMO)), { miuId: MIU, tengoId: TC }).demoChanges.length, 0);
});

test('demo: si la variable coincide por error con Miu o con el 7355, esos caminos no cambian', () => {
  const body = cuerpo(cambio(MIU));
  const r = separarPorNumero(body, { miuId: MIU, tengoId: TC, demoId: MIU });
  assert.equal(r.miuBody, body);
  assert.equal(r.demoChanges.length, 0);
  const t = separarPorNumero(cuerpo(cambio(TC)), { miuId: MIU, tengoId: TC, demoId: TC });
  assert.equal(t.tengoChanges.length, 1);
  assert.equal(t.demoChanges.length, 0);
});

test('demo: mezcla de los cuatro números', () => {
  const r = separarPorNumero(cuerpo(cambio(MIU), cambio(TC), cambio(DEMO), cambio(OTRO)), { miuId: MIU, tengoId: TC, demoId: DEMO });
  assert.equal(r.miuBody.entry[0].changes.length, 1);
  assert.equal(r.tengoChanges.length, 1);
  assert.equal(r.demoChanges.length, 1);
  assert.equal(r.desconocidos, 1);
});

test('camino demo: reenvía a la ruta demo del PMS, envía con el emisor del demo e ignora llamadas', async () => {
  const llamadas = [];
  const enviados = [];
  const logs = [];
  const pms = { postUrl: async (url, body) => { llamadas.push({ url, body }); return { responder: true, mensajes: ['¡Hola! Soy el asistente de X.'] }; } };
  const r = await atenderTengoCamelloDemo([cambio(DEMO, { texto: 'PANA01' }), cambio(DEMO, { field: 'calls', calls: [{ id: 'wacid.1', event: 'connect' }] })],
    { pms, pmsBaseUrl: 'https://pms.example/', enviarTexto: async (to, b) => enviados.push({ to, b }), extractMetaMessages,
      logger: { info() {}, warn: (m) => logs.push(m), error: (m) => logs.push(m) } });
  assert.equal(llamadas.length, 1);
  assert.equal(llamadas[0].url, `https://pms.example${RUTA_PMS_TC_DEMO}`);
  assert.notEqual(RUTA_PMS_TC_DEMO, RUTA_PMS_TENGOCAMELLO);
  assert.equal(llamadas[0].body.text, 'PANA01');
  assert.deepEqual(enviados, [{ to: '573000000991', b: '¡Hola! Soy el asistente de X.' }]);
  assert.equal(r.ignorados, 1);
  assert.ok(logs.includes('[tengocamello-demo] llamada_ignorada'));
});

test('camino demo: política apagada (responder=false) no envía', async () => {
  const enviados = [];
  await atenderTengoCamelloDemo([cambio(DEMO)], { pms: { postUrl: async () => ({ responder: false, mensajes: ['x'] }) },
    pmsBaseUrl: 'https://pms.example', enviarTexto: async (to, b) => enviados.push(b), extractMetaMessages, logger: silencioso });
  assert.deepEqual(enviados, []);
});

test('camino 7355 sin cambios: sigue usando su ruta', async () => {
  const urls = [];
  await atenderTengoCamello([cambio(TC)], { pms: { postUrl: async (url) => { urls.push(url); return {}; } },
    pmsBaseUrl: 'https://pms.example', enviarTexto: async () => {}, extractMetaMessages, logger: silencioso });
  assert.deepEqual(urls, [`https://pms.example${RUTA_PMS_TENGOCAMELLO}`]);
});

test('respuestas de Teo del demo: reclama la cola demo y reporta a su ruta', async () => {
  const posts = [];
  const pms = { postUrl: async (url, body) => { posts.push({ url, body });
    return url.endsWith(RUTA_PMS_TC_DEMO_RECLAMAR) ? { salidas: [{ id: 3, to: '573000000991', texto: 'Respuesta' }] } : {}; } };
  const enviados = [];
  const r = await despacharSalidasTengoCamelloDemo({ pms, pmsBaseUrl: 'https://pms.example', logger: silencioso,
    enviarTexto: async (to, b) => { enviados.push({ to, b }); return 'wamid.d.3'; } });
  assert.deepEqual(r, { enviados: 1, fallidos: 0, inciertos: 0 });
  assert.equal(posts[0].url, `https://pms.example${RUTA_PMS_TC_DEMO_RECLAMAR}`);
  assert.deepEqual(posts[1], { url: 'https://pms.example/api/tengocamello/demo/outbox/3/resultado', body: { resultado: 'enviado', provider_reference: 'wamid.d.3' } });
});

test('index.js: el demo envía desde TENGOCAMELLO_DEMO_PHONE_NUMBER_ID (entrada y cola), nunca por WHATSAPP_API_URL', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  assert.match(src, /const TENGOCAMELLO_DEMO_PHONE_NUMBER_ID = \(process\.env\.TENGOCAMELLO_DEMO_PHONE_NUMBER_ID \|\| ''\)\.trim\(\);/);
  assert.match(src, /demoId: TENGOCAMELLO_DEMO_PHONE_NUMBER_ID/);
  const i = src.indexOf('atenderTengoCamelloDemo(ruteo.demoChanges');
  assert.ok(i > 0);
  assert.match(src.slice(i, i + 300), /sendWhatsAppTextFrom\(TENGOCAMELLO_DEMO_PHONE_NUMBER_ID, to, body\)/);
  const j = src.indexOf("name: 'tengocamello_demo_outbox_poll'");
  assert.ok(j > 0);
  const bloque = src.slice(j, j + 400);
  assert.match(bloque, /sendWhatsAppTextFrom\(TENGOCAMELLO_DEMO_PHONE_NUMBER_ID, to, body\)/);
  assert.doesNotMatch(bloque, /WHATSAPP_API_URL/);
  assert.match(src.slice(src.indexOf('tengocamello_demo_outbox_poll') - 300, src.indexOf('tengocamello_demo_outbox_poll')),
    /enabled: Boolean\(TENGOCAMELLO_DEMO_PHONE_NUMBER_ID/);
  // El ruteo del demo va antes de llamadas y del camino de Miu.
  assert.ok(src.indexOf('atenderTengoCamelloDemo(ruteo.demoChanges') < src.indexOf('extractMetaCalls(req.body)'));
});
