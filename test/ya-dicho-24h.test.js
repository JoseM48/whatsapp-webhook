'use strict';

// "SE REPITIÓ" (juez de calidad, 2026-11-12): el redactor ve las frases que Cami ya dijo en 24 h
// y tiene la regla de no copiarlas; la llamada tiene la misma regla (paridad, dominio 25).

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildWriterInput, frasesYaDichas, WRITER_SYSTEM_PROMPT } = require('../lib/pilot/llm/writer');
const voz = require('../lib/voz/cami-voz');

const transcript = [
  { role: 'cami', at: '2026-11-10T08:00:00Z', text: 'Frase vieja de hace dos días que ya no cuenta para nada.' },
  { role: 'guest', at: '2026-11-11T15:00:00Z', text: 'Hola, ¿tienen algo para diciembre?' },
  { role: 'cami', at: '2026-11-11T15:01:00Z', text: 'Perfecto, esta es una de las opciones:\nLF-1109: $3.577.200 al mes · 30 noches\nValor fijo durante tu estadía; en estadías de más de 3 meses se revisa cada 3 meses.\n1. Opción de menú que no debe salir en la lista' },
  { role: 'human', at: '2026-11-11T16:00:00Z', text: 'Mensaje de José Manuel que no es de Cami y no cuenta.' },
  { role: 'cami', at: '2026-11-11T20:00:00Z', text: 'El edificio tiene recepción todo el día y zonas comunes. Cuando quieras me dices cuál prefieres.' }
];

test('frasesYaDichas: solo Cami, últimas 24 h, sin precios ni opciones, sin repetidas', () => {
  const f = frasesYaDichas(transcript);
  assert.ok(f.includes('El edificio tiene recepción todo el día y zonas comunes.'));
  assert.equal(f.filter((x) => x.startsWith('El edificio')).length, 1);
  assert.ok(!f.some((x) => /cuenta 123|https/.test(x)), 'cifras, enlaces y datos de pago no entran');
  assert.ok(!f.some((x) => x.startsWith('Frase vieja')), 'lo de hace 2 días no entra');
  assert.ok(!f.some((x) => x.startsWith('LF-1109') || x.startsWith('1.')), 'ni precios ni opciones');
  assert.ok(!f.some((x) => x.includes('José Manuel')), 'lo humano no entra');
});

test('el redactor recibe la lista y la regla anti-repetición', () => {
  const input = buildWriterInput({ guestText: 'ok', transcript, packet: {}, language: 'es', today: '2026-11-11' });
  assert.match(input, /Sentences you already sent in the last 24 hours/);
  assert.match(input, /El edificio tiene recepción todo el día/);
  assert.match(WRITER_SYSTEM_PROMPT, /payment details/);
  assert.match(WRITER_SYSTEM_PROMPT, /ALREADY SAID/);
  assert.match(WRITER_SYSTEM_PROMPT, /keeps insisting/);
  const sin = buildWriterInput({ guestText: 'hola', transcript: [], packet: {}, language: 'es', today: '2026-11-11' });
  assert.doesNotMatch(sin, /already sent in the last 24 hours/);
});

test('paridad: la llamada tiene la misma regla de no repetir condiciones ni respuestas', () => {
  assert.match(voz.NO_REPETIR_VOZ, /NO TE REPITAS/);
  assert.match(voz.NO_REPETIR_VOZ, /las condiciones son las mismas que te conté/);
  assert.match(voz.NO_REPETIR_VOZ, /insiste/);
});

// TEXTOS FIJOS SIN REPETIR después del redactor (mismo filtro que el PMS en los seguimientos).
const { sinTextosFijosRepetidos, textosDeCamiEn24h } = require('../lib/pilot/textos-fijos-sin-repetir');
const { createM0ClosedPilotDispatcher } = require('../lib/pilot/m0-closed-pilot');
const silencio = { info() {}, warn() {}, error() {} };
const guest = '573146892662', internal = '573006774425';
const config = { enabled: true, guestPhone: guest, internalPhone: internal, metaSignatureRequired: true,
  pmsM0Enabled: true, controlledIngressEnabled: true, pmsConfigured: true, receiptsEnabled: true,
  internalTemplateName: 'm0_internal_escalation_v1', internalTemplateLanguage: 'es_CO' };
const BLOQUE = 'LF-1109: $3.577.200 al mes · 30 noches\nValor fijo durante tu estadía; en estadías de más de 3 meses se revisa cada 3 meses.\nSi cancelas o no llegas, los $50.000 de la separación no son reembolsables.';
const hace = (h) => new Date(Date.now() - h * 3600000).toISOString();

test('textosDeCamiEn24h: solo Cami, con fecha, en 24 h y sin resúmenes de llamadas', () => {
  const t = textosDeCamiEn24h([
    { role: 'cami', at: hace(1), text: 'uno' }, { role: 'cami', at: hace(30), text: 'viejo' },
    { role: 'guest', at: hace(1), text: 'cliente' }, { role: 'human', at: hace(1), text: 'José' },
    { role: 'cami', text: 'sin fecha' }, { role: 'cami', at: hace(1), text: '[Llamada de WhatsApp con Cami por voz, 3 min]' }]);
  assert.deepEqual(t, ['uno']);
});

function despachar({ packet, reply, transcript }) {
  const completados = [], enviados = [];
  const pms = {
    async processClosedPilotCommercial() { return { outboxes: [{ id: 71 }], authorized_response_packet: packet }; },
    async claimClosedPilotOutbound() { return { outbox_id: 71, claimable: true, recipient_kind: 'guest', recipient_phone: guest,
      message_kind: 'text', message_text: packet.deterministic_text }; },
    async validateAuthorizedResponse() { return { valid: true }; },
    async completeClosedPilotOutbound(body) { completados.push(body); }
  };
  const dispatcher = createM0ClosedPilotDispatcher({ config, pms, logger: silencio,
    async sendText(_to, texto) { enviados.push(texto); return 'wamid.t'; }, async sendPhoto() { return 'wamid.p'; },
    writerProvider: { model: 'm', async structured() { return { output: { reply, presented_codes: [], send_photos: [] }, usage: {} }; } } });
  return { run: () => dispatcher.completeCommercial({ externalMessageId: `wamid.${Math.random()}`, interpretation: {}, ai: {},
    writerInput: { guestText: 'y el precio?', transcript } }), completados, enviados };
}
const paquete = (extra = {}) => ({ packet_version: 2, action: 'PROPUESTA VIGENTE', deterministic_text: `Te recuerdo la opción:\n${BLOQUE}\n¿Te la dejo separada?`,
  numbers: [], dates: [], apartments: ['LF-1109'], required_facts: [], suggested_goals: [], facts: [], notes: [], forbidden_claims: [],
  semantic_claims: [], ui: { message_kind: 'text', photo_target_codes: [] }, ...extra });

test('la respuesta de Cami no vuelve a pegar las condiciones que mandó hace 3 h (lead 326)', async () => {
  const d = despachar({ packet: paquete(), reply: `Claro, sigue disponible:\n${BLOQUE}\n¿Te la dejo separada?`,
    transcript: [{ role: 'cami', at: hace(3), text: `Esta es la opción:\n${BLOQUE}\n¿Te gusta?` }] });
  await d.run();
  const enviado = d.enviados.join('\n');
  assert.match(enviado, /LF-1109: \$3\.577\.200 al mes · 30 noches/);
  assert.doesNotMatch(enviado, /Valor fijo durante tu estadía/);
  assert.doesNotMatch(enviado, /no son reembolsables/);
  assert.match(enviado, /Las demás condiciones son las mismas que te conté antes\./);
  assert.ok(d.completados[0].sent_text, 'el PMS guarda lo que de verdad se envió');
});

test('un texto fijo aprobado palabra por palabra sale igual aunque repita condiciones (decisión 2026-10-07)', async () => {
  const d = despachar({ packet: paquete({ fixed_text: true }), reply: 'no se usa',
    transcript: [{ role: 'cami', at: hace(3), text: BLOQUE }] });
  await d.run();
  assert.match(d.enviados.join('\n'), /Valor fijo durante tu estadía/);
});

test('sin envíos previos en 24 h, la respuesta sale completa', async () => {
  const d = despachar({ packet: paquete(), reply: `Claro:\n${BLOQUE}\n¿Te la dejo separada?`,
    transcript: [{ role: 'cami', at: hace(30), text: BLOQUE }] });
  await d.run();
  assert.match(d.enviados.join('\n'), /Valor fijo durante tu estadía/);
});

test('la misma función que el PMS: precio de lanzamiento y opciones de menú no se tocan', () => {
  const lanz = 'Precio de lanzamiento: $3.000.000 al mes todo incluido, para las primeras reservas, separando hasta el 4 de diciembre.';
  assert.equal(sinTextosFijosRepetidos(lanz, [lanz]).texto, lanz);
  const menu = '1. Información de tu estadía (Wi-Fi, check-out, guía)\n2. Reportar un problema';
  assert.equal(sinTextosFijosRepetidos(menu, [menu]).texto, menu);
});
