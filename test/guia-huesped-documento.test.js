'use strict';

// GUIA DEL HUESPED (José Manuel, 2026-10-07): el PMS encola un documento por
// CLAVE tras CONFIRMAR y, al reclamarlo, manda el enlace (el PDF lo sirve el
// PMS: este repositorio es publico y no lleva el PDF ni el segmento secreto).
// El webhook valida clave y forma del enlace y lo envia con Meta Cloud API
// (type 'document', document {link, filename, caption}).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { guestDocument, documentMessagePayload } = require('../lib/pilot/guest-documents');
const { createM0ClosedPilotDispatcher } = require('../lib/pilot/m0-closed-pilot');
const { PmsPilotClient } = require('../lib/pilot/pms-client');

const guest = '573146892662', internal = '573006774425';
const config = { enabled: true, guestPhone: guest, internalPhone: internal, metaSignatureRequired: true,
  pmsM0Enabled: true, controlledIngressEnabled: true, pmsConfigured: true, receiptsEnabled: true,
  internalTemplateName: 'm0_internal_escalation_v1', internalTemplateLanguage: 'es_CO' };
const CAPTION = 'Te comparto la guía del sector de Mío La Frontera: lugares cercanos, cómo moverte y datos útiles. ¡Bienvenido!';
const LINK = `https://pms-lite-pilot.onrender.com/media/guia/${'a1'.repeat(12)}/guia-sector-mio-la-frontera-v1.pdf`;

test('lista cerrada: solo la clave conocida con un enlace https de la forma esperada', () => {
  assert.deepEqual(guestDocument('guia_huesped_v1', LINK), { key: 'guia_huesped_v1', link: LINK, filename: 'Guía del sector - Mío La Frontera.pdf' });
  for (const malo of [null, '', 'http://pms/media/guia/' + 'a1'.repeat(12) + '/guia-sector-mio-la-frontera-v1.pdf',
    LINK.replace('guia-sector', 'otra'), LINK + '?x=1', 'https://pms/media/guia/zz/guia-sector-mio-la-frontera-v1.pdf',
    'https://pms/media/guia/' + 'a1'.repeat(12) + '/../../x/guia-sector-mio-la-frontera-v1.pdf', 'javascript:alert(1)']) {
    assert.equal(guestDocument('guia_huesped_v1', malo), null, String(malo));
  }
  assert.equal(guestDocument('otra_cosa', LINK), null);
  assert.equal(guestDocument('__proto__', LINK), null);
});

test('este repositorio (público) no lleva el PDF de la guía ni el segmento de su enlace', () => {
  const raiz = path.join(__dirname, '..');
  const pdfs = [];
  (function recorrer(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) recorrer(p); else if (/\.pdf$/i.test(e.name)) pdfs.push(p);
    }
  })(raiz);
  assert.deepEqual(pdfs, []);
  assert.doesNotMatch(fs.readFileSync(path.join(raiz, 'lib', 'pilot', 'guest-documents.js'), 'utf8'), /\/media\/guia\/[0-9a-f]{24}\//);
});

test('cuerpo de Meta Cloud API para el documento', () => {
  assert.deepEqual(documentMessagePayload(guest, { link: LINK, filename: 'Guía.pdf', caption: CAPTION }), {
    messaging_product: 'whatsapp', to: guest, type: 'document',
    document: { link: LINK, filename: 'Guía.pdf', caption: CAPTION }
  });
  assert.equal(documentMessagePayload(guest, { link: LINK, filename: 'a.pdf', caption: 'x'.repeat(2000) }).document.caption.length, 1024);
});

function dispatcherCon(claims, { sendDocument } = {}) {
  const sent = { text: [], document: [], photo: [] }, completed = [];
  const cola = [...claims];
  const pms = {
    async closedPilotInbound() { return { outboxes: claims.map((c) => ({ id: c.outbox_id })) }; },
    async claimClosedPilotOutbound() { return cola.shift(); },
    async completeClosedPilotOutbound(body) { completed.push(body); }
  };
  const dispatcher = createM0ClosedPilotDispatcher({ config, pms,
    async sendText(to, text) { sent.text.push({ to, text }); return 'wamid.text'; },
    async sendTemplate() { return 'wamid.tpl'; },
    async sendPhoto(to, url) { sent.photo.push(url); return 'wamid.photo'; },
    sendDocument: sendDocument === undefined ? async (to, doc) => { sent.document.push({ to, ...doc }); return 'wamid.doc'; } : sendDocument });
  return { dispatcher, sent, completed };
}
const docClaim = (extra = {}) => ({ outbox_id: 77, claimable: true, recipient_kind: 'guest', recipient_phone: guest,
  message_kind: 'document', document_key: 'guia_huesped_v1', document_link: LINK, message_text: CAPTION, ...extra });

test('entrega: una fila de documento sale como documento (enlace, nombre y texto), nunca como texto', async () => {
  const { dispatcher, sent, completed } = dispatcherCon([docClaim()]);
  const result = await dispatcher.process({ phone: internal, text: 'CONFIRMAR', messageId: 'wamid.confirmar', occurredAt: new Date().toISOString() });
  assert.equal(result.deliveries[0].sent, true);
  assert.deepEqual(sent.text, []);
  assert.deepEqual(sent.photo, []);
  assert.deepEqual(sent.document, [{ to: guest, link: LINK, filename: 'Guía del sector - Mío La Frontera.pdf', caption: CAPTION }]);
  assert.deepEqual(completed, [{ outbox_id: 77, status: 'submitted', provider_reference: 'wamid.doc' }]);
});

test('entrega: clave o enlace inválido, o sin emisor de documentos -> no se envía nada y queda fallida', async () => {
  for (const [extra, sendDocument] of [[{ document_key: 'no_existe' }, undefined], [{ document_link: 'https://evil.test/x.pdf' }, undefined],
    [{ document_link: undefined }, undefined], [{}, null]]) {
    const { dispatcher, sent, completed } = dispatcherCon([docClaim(extra)], { sendDocument });
    const result = await dispatcher.process({ phone: internal, text: 'CONFIRMAR', messageId: 'wamid.c', occurredAt: new Date().toISOString() });
    assert.equal(result.deliveries[0].sent, false);
    assert.deepEqual(sent.text, []);
    assert.deepEqual(sent.document, []);
    assert.deepEqual(completed, [{ outbox_id: 77, status: 'failed' }]);
  }
});

test('un fallo de Meta con el documento no corta la entrega de lo que sigue', async () => {
  const otro = { outbox_id: 78, claimable: true, recipient_kind: 'internal', recipient_role: 'administracion',
    message_kind: 'text', message_text: 'PILOTO M0\nPARA: ADMINISTRADOR\nCASO: M0-1\nAPARTAMENTO: LF-210\nACCIÓN SOLICITADA: X\n\nok', text_body: 'ok' };
  const { dispatcher, completed } = dispatcherCon([docClaim(), otro], { sendDocument: async () => { throw Object.assign(new Error('meta 400'), { response: { status: 400 } }); } });
  const result = await dispatcher.process({ phone: internal, text: 'CONFIRMAR', messageId: 'wamid.f', occurredAt: new Date().toISOString() });
  assert.equal(result.deliveries.length, 2);
  assert.equal(result.deliveries[0].sent, false);
  assert.deepEqual(completed[0], { outbox_id: 77, status: 'failed' });
});

test('el reclamo declara que este webhook sabe enviar documentos (cabecera fuera del cuerpo firmado)', async () => {
  const calls = [];
  const client = new PmsPilotClient({ baseUrl: 'https://pms.test', secret: 's',
    http: { async post(url, body, options) { calls.push({ url, body, options }); return { data: { data: { claimable: false } } }; } } });
  await client.claimClosedPilotOutbound(5);
  assert.equal(calls[0].url, 'https://pms.test/api/supervised-pilot/closed-pilot/outbound/claim');
  assert.deepEqual(calls[0].body, { outbox_id: 5 });
  assert.equal(calls[0].options.headers['X-M0-Accepts'], 'document');
  assert.ok(calls[0].options.headers['X-PMS-Signature']);
});
