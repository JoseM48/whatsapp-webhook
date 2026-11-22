'use strict';

// CONFIANZA PRIMERO (José Manuel, 2026-11-22; DECISIONES_LOG "Confianza primero: presentación de José,
// reseñas y dirección; prueba A/B con Airbnb"). Webhook: la foto de José (lib/pilot/host-photos.js),
// su entrega con el pie largo, los temas airbnb_listing y address_disclosure del intérprete de
// respaldo, el redactor y la llamada (lineasConfianzaVoz). Paridad: test/paridad-canales.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { hostPhotoForKey, HOST_PHOTOS } = require('../lib/pilot/host-photos');
const { photoForKey, PHOTO_FILES } = require('../lib/pilot/apartment-photos');
const { createM0ClosedPilotDispatcher } = require('../lib/pilot/m0-closed-pilot');
const { lineasConfianzaVoz } = require('../lib/voz/cami-voz');

const guest = '573146892662', internal = '573006774425';
const config = { enabled: true, guestPhone: guest, internalPhone: internal, metaSignatureRequired: true,
  pmsM0Enabled: true, controlledIngressEnabled: true, pmsConfigured: true, receiptsEnabled: true,
  internalTemplateName: 'm0_internal_escalation_v1', internalTemplateLanguage: 'es_CO' };

test('la foto de José: lista cerrada propia, archivo presente y liviano, fuera de PHOTO_FILES', () => {
  const f = hostPhotoForKey('ANFITRION/jose');
  assert.equal(f.host, true);
  assert.match(f.url, /\/media\/anfitrion\/jose\.jpg\?v=\d{8}$/);
  for (const mala of [null, '', 'ANFITRION/otro', 'ANFITRION/../jose', 'LF-510/01-portada', '__proto__']) assert.equal(hostPhotoForKey(mala), null, String(mala));
  assert.equal(photoForKey('ANFITRION/jose'), null);
  assert.equal(PHOTO_FILES.ANFITRION, undefined);
  for (const archivo of Object.values(HOST_PHOTOS)) {
    const p = path.join(__dirname, '..', 'public', 'anfitrion', `${archivo}.jpg`);
    assert.ok(fs.existsSync(p), p);
    assert.ok(fs.statSync(p).size < 300 * 1024, 'la foto debe ser liviana (menos de 300 KB)');
  }
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8'), /app\.use\('\/media\/anfitrion'/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'lib', 'pilot', 'pms-client.js'), 'utf8'), /'X-M0-Accepts': '[^']*\banfitrion_image\b/);
});

test('la presentación sale como foto con el pie completo (hasta 1024), nunca como texto', async () => {
  const pie = `Te presento a José Manuel, el anfitrión de Miu La Frontera. ${'x'.repeat(500)}`;
  const sent = { text: [], photo: [] }, completed = [];
  const cola = [{ outbox_id: 7, claimable: true, status: 'submitting', recipient_kind: 'guest', recipient_phone: guest,
    message_kind: 'image', media_key: 'ANFITRION/jose', message_text: pie }];
  const dispatcher = createM0ClosedPilotDispatcher({ config,
    pms: { async claimClosedPilotOutbound() { return cola.shift() || { outbox_id: null, status: 'empty', claimable: false }; },
      async completeClosedPilotOutbound(b) { completed.push(b); } },
    async sendText(to, text) { sent.text.push(text); return 'wamid.t'; }, async sendTemplate() { return 'wamid.tpl'; },
    async sendPhoto(to, url, caption) { sent.photo.push({ url, caption }); return 'wamid.p'; },
    logger: { info() {}, warn() {}, error() {} } });
  const r = await dispatcher.deliverCommercialOutboxes([{ id: 7 }]);
  assert.equal(r[0].sent, true);
  assert.deepEqual(sent.text, []);
  assert.equal(sent.photo[0].caption, pie);
  assert.match(sent.photo[0].url, /\/media\/anfitrion\/jose\.jpg/);
  assert.deepEqual(completed, [{ outbox_id: 7, status: 'submitted', provider_reference: 'wamid.p' }]);
});

test('intérprete de respaldo: "¿cómo los busco en Airbnb?" pide el anuncio y "cómo llego" la dirección', () => {
  // extractKnowledgeTopics no se exporta: se prueban sus dos expresiones nuevas tal como están en el archivo.
  const fuente = fs.readFileSync(path.join(__dirname, '..', 'lib', 'pilot', 'ai.js'), 'utf8');
  assert.ok(fuente.includes(", 'airbnb_listing');"));
  const airbnb = /(busc|encuentr|link|enlace|anuncio|perfil|p[aá]gina)[^.?!]{0,40}airbnb|airbnb[^.?!]{0,40}(link|enlace|anuncio|perfil|busc|encuentr)/i;
  const llegar = /c[oó]mo llego|c[oó]mo llegar|d[oó]nde (es|est[aá]n|quedan) exactamente|la direcci[oó]n/i;
  assert.ok(fuente.includes(airbnb.source) && fuente.includes(llegar.source), 'las expresiones del archivo son estas');
  assert.ok(airbnb.test('¿Cómo los busco en Airbnb?') && airbnb.test('pásame el link de airbnb'));
  assert.ok(!airbnb.test('¿Reservo directo o por airbnb?'));
  assert.ok(llegar.test('¿Cómo llego al edificio?'));
  for (const f of ['lib/pilot/ai.js', 'lib/pilot/llm/interpretation-schema-v2.js']) {
    assert.match(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), /'address_disclosure', 'airbnb_listing',/, f);
  }
});

test('redactor: presentación ya enviada, dirección para todos y enlace del anuncio solo si lo pide', () => {
  const w = fs.readFileSync(path.join(__dirname, '..', 'lib', 'pilot', 'llm', 'writer.js'), 'utf8');
  assert.match(w, /presentacion_jose_enviada/);
  assert.match(w, /without waiting for the advance payment/);
  assert.match(w, /topic \\"airbnb_listing\\"|topic "airbnb_listing"/);
  assert.match(w, /Never offer to pay part of a stay \(for example the first night\) on Airbnb/);
});

test('llamada: presentación, frase de calificación, dirección, anuncio y variante B (sin primera noche)', () => {
  assert.deepEqual(lineasConfianzaVoz(null), []);
  const l = lineasConfianzaVoz({ presentacion: { anfitrion: 'José Manuel', anos_anfitrion: 8, resenas_mas_de: 2000,
    frase_calificacion: 'Desde mediados de octubre, 7 de cada 8 huéspedes nos calificaron con 5 estrellas.',
    resenas: [{ nombre: 'Miguel', fecha: 'noviembre de 2026', texto: 'Excelente ubicación.' }] },
  direccion_para_todos: true, airbnb_anuncio: true, variante_b: true }).join('\n');
  assert.match(l, /lleva 8 años recibiendo huéspedes y tiene más de 2\.000 reseñas en Airbnb/);
  assert.match(l, /"Excelente ubicación\." \(Miguel, noviembre de 2026\)/);
  assert.match(l, /tal cual: "Desde mediados de octubre, 7 de cada 8 huéspedes nos calificaron con 5 estrellas\."/);
  assert.match(l, /address_disclosure/);
  assert.match(l, /airbnb_listing/);
  assert.match(l, /reservar esta estadía por nuestro Airbnb; las siguientes, directo/);
  assert.match(l, /Nunca ofrezcas pagar una parte \(ni la primera noche\)/);
  const a = lineasConfianzaVoz({ presentacion: { anfitrion: 'José Manuel', anos_anfitrion: 8, resenas_mas_de: 2000, resenas: [] }, variante_b: false }).join('\n');
  assert.doesNotMatch(a, /Airbnb; las siguientes/);
  assert.match(a, /Nunca digas la calificación/);
});
