'use strict';
// RESERVA PRE-CONFIRMADA SIN BLOQUEO PARA 30+ NOCHES (José Manuel, 2026-10-29;
// paridad dominio 25): con la regla que manda el PMS (/voz/llamada/inicio ->
// reserva_30_mas), la llamada la dice en vez de la del anticipo; sin ella, la
// de siempre. El chat (writer) la explica con el hecho reserva_sin_bloqueo.
const test = require('node:test');
const assert = require('node:assert/strict');
const { instruccionesCamiVoz } = require('../lib/voz/cami-voz');
const fs = require('node:fs');
const path = require('node:path');

const REGLA = 'RESERVAS DE 30 NOCHES O MÁS con llegada en 7 días o más: al aceptar, la reserva queda PRE-CONFIRMADA sin pago y sin bloquear fechas.';

test('llamada: con reserva_30_mas del PMS se dice esa regla y no la del anticipo', () => {
  const t = instruccionesCamiVoz({ hoy: '2026-10-29', reserva30: { regla: REGLA } });
  assert.match(t, /PRE-CONFIRMADA sin pago/);
  assert.match(t, /Nunca digas que hubo problemas con un apartamento/);
  assert.doesNotMatch(t, /- ANTICIPO: si en 30 noches o más se paga anticipo/);
});

test('llamada: sin la regla (política apagada) queda la del anticipo de siempre', () => {
  const t = instruccionesCamiVoz({ hoy: '2026-10-29' });
  assert.match(t, /- ANTICIPO: si en 30 noches o más se paga anticipo/);
  assert.doesNotMatch(t, /PRE-CONFIRMADA sin pago/);
});

test('chat: el redactor tiene la regla del hecho reserva_sin_bloqueo', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'pilot', 'llm', 'writer.js'), 'utf8');
  assert.match(src, /RESERVATION WITHOUT BLOCKING, 30\+ NIGHTS/);
  assert.match(src, /"reserva_sin_bloqueo"/);
});
