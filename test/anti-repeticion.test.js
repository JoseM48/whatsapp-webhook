'use strict';

// CAMI NO REPITE LO MISMO A QUIEN NO LE ENTENDIÓ (caso Walter, lead 368, 2026-11-11).
// Paquete 3 "se equivoca menos" del rediseño de comunicaciones (GO José Manuel 2026-11-11).

const test = require('node:test');
const assert = require('node:assert/strict');
const ar = require('../lib/pilot/anti-repeticion');
const { resolveWrittenReply, buildWriterInput } = require('../lib/pilot/llm/writer');
const voz = require('../lib/voz/cami-voz');
const { evaluar } = require('../examen/afirmaciones');

const ANTES = 'Para la estadía de 360 noches, del 20 de enero de 2027 al 15 de enero de 2028, la tarifa mensual de referencia de hoy es $3.100.000. Es una tarifa de referencia, no una cotización reservable: los precios se revisan cada cierto tiempo y la tarifa final se confirma más cerca de tu llegada.\n\n¿Quieres que te anote en la lista de espera? No pagas nada ni te comprometes.';
const IGUAL = 'Sí, sería pagando mes a mes. Para tu estadía de 360 noches, del 20 de enero de 2027 al 15 de enero de 2028, la tarifa mensual de referencia de hoy es $3.100.000. Es una tarifa de referencia, no una cotización reservable: los precios se revisan cada cierto tiempo y la tarifa final se confirma más cerca de tu llegada.\n\n¿Quieres que te anote en la lista de espera? No pagas nada ni te comprometes.';
const DISTINTA = 'Sí: cada mes pagas $3.100.000 (tarifa de referencia de hoy). No pagas el año por adelantado. ¿Te anoto en la lista de espera para el 20 de enero?';

test('casi duplicado: lo mismo con otras palabras sí; otra explicación con la misma cifra no', () => {
  assert.equal(ar.casiDuplicado(ANTES, IGUAL), true);
  assert.equal(ar.casiDuplicado(ANTES, DISTINTA), false);
  assert.equal(ar.casiDuplicado('Con gusto', 'Con gusto'), true);
  assert.equal(ar.casiDuplicado('Con gusto', 'Con mucho gusto'), false);
});

test('señales de confusión y pregunta repetida', () => {
  for (const t of ['ok mes a mes cuanto tendria que pagar ??', 'estoy hablando pagando mensual', 'no el año', 'No entendí', '?', 'cómo así', "I don't understand"])
    assert.equal(ar.senalConfusion(t), true, t);
  for (const t of ['No, gracias', 'Por mes', '20 de enero', 'no tengo fecha exacta de salida', 'Gracias'])
    assert.equal(ar.senalConfusion(t), false, t);
  const tr = [{ role: 'guest', text: 'Por mes' }, { role: 'cami', text: '¿Qué fecha de llegada tienes prevista?' }];
  assert.equal(ar.repitePregunta('Por mes', tr), true);
  assert.equal(ar.repitePregunta('Llego el 3 de diciembre', tr), false);
});

test('lo ya dicho deja de ser obligatorio; los permisos no cambian', () => {
  const packet = { packet_version: 2, numbers: [{ formatted: '$3.100.000' }],
    dates: [{ id: 'check_in', formatted: '2027-01-20' }, { id: 'check_out', formatted: '2028-01-15' }, { id: 'x', formatted: '2027-03-01' }],
    required_facts: [{ id: 'reference_quote', patterns: ['referencia'] }, { id: 'waitlist_offer', patterns: ['lista de espera'] }, { id: 'nuevo', patterns: ['p[oó]liza'] }, { id: 'sin', patterns: [] }] };
  const p = ar.paqueteSinLoYaDicho(packet, ANTES);
  assert.deepEqual(p.required_facts.map((f) => f.id), ['nuevo', 'sin']);
  assert.deepEqual(p.dates.map((d) => d.required === false), [true, true, false]);
  assert.deepEqual(p.numbers, packet.numbers);
  assert.equal(packet.required_facts.length, 4, 'no muta el paquete original');
});

function escenario(respuestas, { valido = () => ({ valid: true, failure_reasons: [] }) } = {}) {
  const vistos = [], validados = [];
  let i = 0;
  const provider = { model: 'falso', async structured({ input }) { vistos.push(input); const r = respuestas[Math.min(i, respuestas.length - 1)]; i += 1; return { output: { reply: r, presented_codes: [], send_photos: [] }, usage: null }; } };
  const pms = { async validateAuthorizedResponse(body) { validados.push(body); return valido(body); } };
  return { provider, pms, vistos, validados };
}
const PAQUETE = { packet_version: 2, action: 'TARIFA DE REFERENCIA FUERA DE HORIZONTE', deterministic_text: `Perfecto. ${ANTES}`,
  numbers: [{ formatted: '$3.100.000' }], dates: [{ id: 'check_in', formatted: '2027-01-20' }, { id: 'check_out', formatted: '2028-01-15' }],
  required_facts: [{ id: 'reference_quote', patterns: ['referencia'] }, { id: 'waitlist_offer', patterns: ['lista de espera'] }] };
const TRANSCRIPT = [{ role: 'guest', text: 'ok mes a mes cuanto tendria que pagar ??' }, { role: 'cami', text: ANTES }];

test('confundida: si el borrador repite, se regenera con el motivo y sale el distinto', async () => {
  const e = escenario([IGUAL, DISTINTA]);
  const r = await resolveWrittenReply({ packet: PAQUETE, provider: e.provider, pms: e.pms, guestText: 'estoy hablando pagando mensual', transcript: TRANSCRIPT, today: '2026-11-11', logger: { info() {}, error() {} } });
  assert.equal(r.text, DISTINTA);
  assert.equal(r.attempts, 2);
  assert.deepEqual(r.failure_reasons, ['repite_mensaje_anterior']);
  assert.match(e.vistos[0], /REPETITION GUARD/);
  assert.match(e.vistos[1], /repite_mensaje_anterior/);
  // El validador recibió el paquete sin las obligaciones ya cumplidas en el mensaje anterior.
  // La cifra vuelve a exigir lo que la califica ("referencia"); la lista de espera ya dicha no.
  assert.deepEqual(e.validados[0].packet.required_facts.map((f) => f.id), ['reference_quote']);
  assert.deepEqual(e.validados[0].packet.dates.map((d) => d.required), [false, false]);
});

test('confundida: si nada sale distinto, Cami pregunta qué aclarar (nunca el mismo texto)', async () => {
  const e = escenario([IGUAL, IGUAL]);
  const r = await resolveWrittenReply({ packet: PAQUETE, provider: e.provider, pms: e.pms, guestText: 'no el año', transcript: TRANSCRIPT, today: '2026-11-11', logger: { info() {}, error() {} } });
  assert.equal(r.presentation_source, 'aclaracion_por_repeticion');
  assert.equal(r.text, ar.textoAclarar('es'));
  assert.doesNotMatch(r.text, /\$|\d{3}/);
});

test('sin señal de confusión no cambia nada (mismo paquete, sin bloque de repetición)', async () => {
  const e = escenario([IGUAL]);
  const r = await resolveWrittenReply({ packet: PAQUETE, provider: e.provider, pms: e.pms, guestText: '20 de enero', transcript: TRANSCRIPT, today: '2026-11-11', logger: { info() {}, error() {} } });
  assert.equal(r.text, IGUAL);
  assert.equal(r.attempts, 1);
  assert.doesNotMatch(e.vistos[0], /REPETITION GUARD/);
  assert.equal(e.validados[0].packet, PAQUETE);
});

test('el bloque de repetición solo entra con confusión y último mensaje', () => {
  const base = { guestText: 'x', transcript: [], packet: {}, today: '2026-11-11' };
  assert.doesNotMatch(buildWriterInput(base), /REPETITION GUARD/);
  assert.match(buildWriterInput({ ...base, repeticion: { confundida: true, ultima: 'hola' } }), /REPETITION GUARD/);
});

test('paridad: la regla va en la llamada de Miu, TenGo y Equipos', () => {
  const unir = (x) => (Array.isArray(x) ? x.join('\n') : String(x));
  assert.match(unir(voz.instruccionesCamiVoz({ hoy: '2026-11-11' })), /SI NO TE ENTENDIÓ/);
  assert.match(unir(voz.instruccionesCamiTenGoVoz({ hoy: '2026-11-11' })), /SI NO TE ENTENDIÓ/);
  assert.match(unir(voz.instruccionesCamiEquiposVoz({ hoy: '2026-11-11', negocio: 'x', rol: 'dueno' })), /SI NO TE ENTENDIÓ/);
});

test('examen: afirmaciones sobre textos reales', () => {
  const caso = { antes: [{ role: 'cami', text: ANTES }], texto: 'no el año', paquete: PAQUETE,
    afirmaciones: { periodo_claro: true, contiene_alguno: ['cada mes'] } };
  const fallas = (t) => evaluar(caso, t).filter((x) => !x.ok).map((x) => x.afirmacion);
  assert.deepEqual(fallas(IGUAL), ['no_repite', 'contiene_alguno']);
  assert.deepEqual(fallas(DISTINTA), []);
  assert.deepEqual(fallas('Cada mes pagas $2.500.000.'), ['sin_cifras_inventadas']);
  assert.deepEqual(fallas('Cada mes son $3.100.000 y el depósito es de $600.000.'), ['sin_cifras_inventadas']);
});
