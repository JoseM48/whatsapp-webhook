'use strict';

// ORIGEN DEL ANUNCIO (Click-to-WhatsApp) en los números de TenGo Camello
// (7355 y Demo 7354; José Manuel, 2026-10-29; PMS migración 1074).
// Ids, teléfonos y anuncios FALSOS.
const test = require('node:test');
const assert = require('node:assert/strict');
const { atenderTengoCamello, atenderTengoCamelloDemo, referralParaPms, RUTA_PMS_TC_DEMO, RUTA_PMS_TENGOCAMELLO } = require('../lib/pilot/numero-entrante');
const { extractMetaMessages } = require('../lib/pilot/meta-inbound');

const TC = '200000000000002';
const DEMO = '400000000000004';
const silencioso = { info() {}, warn() {}, error() {} };
const REFERRAL = {
  source_url: 'https://fb.me/anuncio-falso', source_id: '120000000000000001', source_type: 'ad',
  headline: 'Anuncio de prueba', body: 'Texto del anuncio de prueba', media_type: 'image',
  image_url: 'https://example.invalid/img.jpg', ctwa_clid: 'ClidFalso_abc-123',
};

function cambio(phoneNumberId, { texto = 'PANA01', from = '573000000991', referral } = {}) {
  const msg = { from, id: `wamid.${Math.random().toString(36).slice(2)}`, timestamp: '1761600000', type: 'text', text: { body: texto } };
  if (referral !== undefined) msg.referral = referral;
  return { field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: phoneNumberId },
    contacts: [{ wa_id: from, profile: { name: 'Prueba' } }], messages: [msg] } };
}

async function postsDe(fn, change) {
  const posts = [];
  await fn([change], { pms: { postUrl: async (url, body) => { posts.push({ url, body }); return { responder: false, mensajes: [] }; } },
    pmsBaseUrl: 'https://pms.example', enviarTexto: async () => {}, extractMetaMessages, logger: silencioso });
  return posts;
}

test('7355 con referral: se reenvía al PMS solo con los campos conocidos', async () => {
  const posts = await postsDe(atenderTengoCamello, cambio(TC, { referral: REFERRAL }));
  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, `https://pms.example${RUTA_PMS_TENGOCAMELLO}`);
  assert.deepEqual(posts[0].body.referral, {
    source_id: '120000000000000001', source_type: 'ad', source_url: 'https://fb.me/anuncio-falso', headline: 'Anuncio de prueba',
    body: 'Texto del anuncio de prueba', ctwa_clid: 'ClidFalso_abc-123', media_type: 'image',
  });
  assert.equal(posts[0].body.referral.image_url, undefined);
});

test('demo 7354 con referral: también va a la ruta del demo', async () => {
  const posts = await postsDe(atenderTengoCamelloDemo, cambio(DEMO, { referral: REFERRAL }));
  assert.equal(posts[0].url, `https://pms.example${RUTA_PMS_TC_DEMO}`);
  assert.equal(posts[0].body.referral.source_id, '120000000000000001');
  assert.equal(posts[0].body.referral.ctwa_clid, 'ClidFalso_abc-123');
});

test('sin referral: el cuerpo al PMS no lleva la clave (igual que antes)', async () => {
  for (const [fn, id] of [[atenderTengoCamello, TC], [atenderTengoCamelloDemo, DEMO]]) {
    const posts = await postsDe(fn, cambio(id));
    assert.deepEqual(Object.keys(posts[0].body).sort(), ['contact_name', 'from', 'message_id', 'message_type', 'occurred_at', 'text']);
  }
});

test('referral malformado: se omite y el mensaje se reenvía igual', async () => {
  for (const malo of ['texto', 42, [1, 2], {}, { source_id: { x: 1 }, headline: '   ' }, null]) {
    const posts = await postsDe(atenderTengoCamelloDemo, cambio(DEMO, { referral: malo }));
    assert.equal(posts.length, 1);
    assert.equal('referral' in posts[0].body, false);
    assert.equal(posts[0].body.text, 'PANA01');
  }
});

test('referralParaPms acota tamaños y acepta source_id numérico', () => {
  const r = referralParaPms({ source_id: 123, headline: 'x'.repeat(900), body: 'y'.repeat(5000) });
  assert.equal(r.source_id, '123');
  assert.equal(r.headline.length, 300);
  assert.equal(r.body.length, 1000);
});
