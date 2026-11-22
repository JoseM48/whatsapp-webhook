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
  assert.ok(fuente.includes("topics.push('airbnb_listing')"));
  const llegar = /c[oó]mo llego|c[oó]mo llegar|d[oó]nde (es|est[aá]n|quedan) exactamente|la direcci[oó]n/i;
  assert.ok(fuente.includes(llegar.source), 'la expresión del archivo es esta');
  // Las tres expresiones de airbnb_listing, tal cual están en ai.js (no se exportan).
  const codigo = ['PREGUNTA_ANUNCIO_AIRBNB', 'PIDE_ENLACE_AIRBNB', 'CUENTA_QUE_VIO_AIRBNB']
    .map((n) => fuente.match(new RegExp(`const ${n} = [^\\n]+`))[0]).join('\n');
  const pide = new Function(`${codigo}\nreturn (t) => PREGUNTA_ANUNCIO_AIRBNB.test(t) && !(CUENTA_QUE_VIO_AIRBNB.test(t) && !PIDE_ENLACE_AIRBNB.test(t));`)();
  for (const si of ['¿Cómo los busco en Airbnb?', 'pásame el link de airbnb', '¿Cómo puedo reservar por Airbnb?', 'vi su anuncio en Airbnb, ¿me pasas el enlace de airbnb?']) assert.ok(pide(si), si);
  for (const no of ['Los encontré en Airbnb', 'vi su anuncio en Airbnb', '¿Reservo directo o por airbnb?', 'me quedé en Airbnb el año pasado']) assert.ok(!pide(no), no);
  assert.ok(llegar.test('¿Cómo llego al edificio?'));
  for (const f of ['lib/pilot/ai.js', 'lib/pilot/llm/interpretation-schema-v2.js']) {
    assert.match(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), /'address_disclosure', 'airbnb_listing',/, f);
  }
});

test('redactor: presentación ya enviada, dirección para todos y enlace del anuncio solo si lo pide', () => {
  const w = fs.readFileSync(path.join(__dirname, '..', 'lib', 'pilot', 'llm', 'writer.js'), 'utf8');
  assert.match(w, /presentacion_jose_enviada/);
  assert.match(w, /without asking for a payment first/);
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

test('si Meta rechaza la foto de José, el texto de la presentación sale igual (como texto)', async () => {
  const sent = { text: [], photo: 0 }, completed = [];
  const cola = [{ outbox_id: 9, claimable: true, status: 'submitting', recipient_kind: 'guest', recipient_phone: guest,
    message_kind: 'image', media_key: 'ANFITRION/jose', message_text: 'Te presento a José Manuel.' }];
  const dispatcher = createM0ClosedPilotDispatcher({ config,
    pms: { async claimClosedPilotOutbound() { return cola.shift() || { outbox_id: null, status: 'empty', claimable: false }; },
      async completeClosedPilotOutbound(b) { completed.push(b); } },
    async sendText(to, text) { sent.text.push(text); return 'wamid.t'; }, async sendTemplate() { return 'wamid.tpl'; },
    async sendPhoto() { sent.photo += 1; throw Object.assign(new Error('meta 400'), { response: { status: 400, data: { error: { message: 'bad' } } } }); },
    logger: { info() {}, warn() {}, error() {} } });
  const r = await dispatcher.deliverCommercialOutboxes([{ id: 9 }]);
  assert.equal(sent.photo, 1);
  assert.deepEqual(sent.text, ['Te presento a José Manuel.']);
  assert.equal(r[0].sent, true);
  assert.deepEqual(completed, [{ outbox_id: 9, status: 'submitted', provider_reference: 'wamid.t' }]);
});

test('llamada: los años salen del PMS; sin valor, ningún número', () => {
  const { instruccionesCamiVoz } = require('../lib/voz/cami-voz');
  assert.match(String(instruccionesCamiVoz({ hoy: '2026-11-22', anosAnfitrion: 8 })), /2\.000 reseñas y 8 años de experiencia/);
  assert.doesNotMatch(String(instruccionesCamiVoz({ hoy: '2026-11-22' })), /\d+ años de experiencia/);
  const fuente = fs.readFileSync(path.join(__dirname, '..', 'lib', 'voz', 'cami-voz.js'), 'utf8');
  assert.doesNotMatch(fuente, /9 años/);
});
