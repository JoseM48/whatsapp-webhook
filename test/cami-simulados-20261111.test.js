'use strict';

// PRUEBAS DE CAMI CON CLIENTES SIMULADOS (2026-11-11): mensajes casi iguales, texto fijo
// de respaldo corto y en el idioma del cliente, y paridad de la llamada
// (docs/08_AUDITORIAS/PRUEBAS_CAMI_SIMULADOS_20261111.md, H1, H3 y punto 3).

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveWrittenReply } = require('../lib/pilot/llm/writer');
const voz = require('../lib/voz/cami-voz');

const log = { info() {}, error() {} };
function escenario(respuestas, valido) {
  const vistos = [], validados = [];
  let i = 0;
  const provider = { model: 'falso', async structured({ system, input }) { vistos.push({ system, input }); const r = respuestas[Math.min(i, respuestas.length - 1)]; i += 1;
    return { output: { reply: r, presented_codes: [], send_photos: [] }, usage: null }; } };
  const pms = { async validateAuthorizedResponse(body) { validados.push(body); return valido(body, validados.length); } };
  return { provider, pms, vistos, validados };
}
const SUELO = 'Para estas fechas no se paga nada por ahora: el apartamento queda pre-confirmado con el precio cotizado, sin pago, y se confirma a más tardar 15 días antes de la llegada.\n\n'
  + 'Cuando se confirme, la regla de pago es esta: para reservar pagas una confirmación de $300.000 por Wompi, que se descuenta de tu primer mes; con ese pago las fechas quedan bloqueadas a tu nombre. Antes de entrar pagas el primer mes y un depósito de $600.000 que se te devuelve al check-out si todo está bien.';
const PAQ = { packet_version: 2, action: 'RESPONDER INFORMACIÓN APROBADA', deterministic_text: SUELO, numbers: [{ formatted: '$300.000' }], dates: [], required_facts: [] };
const RECHAZA_DOS = (b, n) => (n <= 2 ? { valid: false, failure_reasons: ['number_missing:x'] } : { valid: true, failure_reasons: [] });

test('respaldo: en inglés, el texto del sistema se reescribe corto en inglés y pasa por el validador', async () => {
  const EN = 'No payment for now: your dates stay pre-confirmed at the quoted price. To lock them you pay a $300.000 confirmation by Wompi (deducted from your first month); before moving in, the first month and a $600.000 refundable deposit.';
  const e = escenario(['borrador 1', 'borrador 2', EN], RECHAZA_DOS);
  const r = await resolveWrittenReply({ packet: PAQ, provider: e.provider, pms: e.pms, guestText: 'How do I pay the $300.000?', transcript: [], language: 'en', today: '2026-11-11', logger: log });
  assert.equal(r.presentation_source, 'deterministic_rewritten');
  assert.equal(r.text, EN);
  assert.equal(r.attempts, 3);
  assert.match(e.vistos[2].system, /Write in en/);
  assert.match(e.vistos[2].input, /ORIGINAL:\n/);
  assert.equal(e.validados.length, 3, 'la reescritura también la valida el PMS');
});

test('respaldo: si la reescritura no pasa el validador, sale el texto del sistema como siempre', async () => {
  const e = escenario(['b1', 'b2', 'reescrito'], () => ({ valid: false, failure_reasons: ['number_missing:x'] }));
  const r = await resolveWrittenReply({ packet: PAQ, provider: e.provider, pms: e.pms, guestText: 'How do I pay?', transcript: [], language: 'en', today: '2026-11-11', logger: log });
  assert.equal(r.presentation_source, 'deterministic_after_rejection');
  assert.equal(r.text, SUELO);
  assert.ok(r.failure_reasons.some((x) => x.startsWith('reescritura:')));
});

test('respaldo: no se reescribe un texto aprobado palabra por palabra, una cotización con bloque ni un texto corto en español', async () => {
  for (const packet of [{ ...PAQ, fixed_text: true }, { ...PAQ, price_presentation: { block_text: 'x' } }, { ...PAQ, deterministic_text: 'Texto corto del sistema.' }]) {
    const e = escenario(['b1', 'b2', 'reescrito'], RECHAZA_DOS);
    const r = await resolveWrittenReply({ packet, provider: e.provider, pms: e.pms, guestText: 'hola', transcript: [], language: 'es', today: '2026-11-11', logger: log });
    assert.equal(r.presentation_source, 'deterministic_after_rejection');
    assert.equal(e.vistos.length, 2);
  }
});

test('casi igual al mensaje anterior: se regenera; si el segundo sale distinto, sale el segundo', async () => {
  const ANTES = 'Tenemos el LF-210 y el LF-404 disponibles para tus fechas del 10 de enero al 9 de febrero; cuéntame cuál prefieres y te lo dejo en proceso.';
  const CASI = 'Tenemos disponibles el LF-210 y el LF-404 para tus fechas del 10 de enero al 9 de febrero; dime cuál prefieres y te lo dejo en proceso.';
  const NUEVO = 'Sí, el LF-404 tiene balcón. ¿Te lo dejo en proceso?';
  const e = escenario([CASI, NUEVO], () => ({ valid: true, failure_reasons: [] }));
  const r = await resolveWrittenReply({ packet: { ...PAQ, deterministic_text: 'x' }, provider: e.provider, pms: e.pms, guestText: '¿cuál tiene balcón?',
    transcript: [{ role: 'guest', text: 'llego el 10 de enero' }, { role: 'cami', text: ANTES }], today: '2026-11-11', logger: log });
  assert.equal(r.text, NUEVO);
  assert.deepEqual(r.failure_reasons, ['casi_igual_al_anterior']);
  assert.match(e.vistos[1].input, /casi_igual_al_anterior/);
});

test('paridad: la llamada de Miu trae la regla de factura antes de cotizar y la de no pedir dos veces un dato', () => {
  const unir = (x) => (Array.isArray(x) ? x.join('\n') : String(x));
  const t = unir(voz.instruccionesCamiVoz({ hoy: '2026-11-11' }));
  assert.match(t, /FACTURA ANTES DE COTIZAR/);
  assert.match(t, /NO PIDAS DOS VECES UN DATO/);
  assert.match(t, /te coticé para 2 personas/);
});
