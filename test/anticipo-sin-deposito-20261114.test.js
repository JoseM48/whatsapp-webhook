'use strict';
// ENSAYO: RESERVAS DIRECTAS SIN DEPÓSITO (José Manuel, 2026-11-14; DECISIONES_LOG "Ensayo:
// reservas directas sin depósito, solo un anticipo pequeño", Confirmado; PMS migración 1496).
// El PMS manda el hecho "anticipo_reserva" (anticipo de $150.000 que se descuenta, sin
// depósito). El redactor lo explica así y la regla vieja del depósito queda solo para las
// cotizaciones que aún la traen ("anticipo_deposito"). La llamada, sin regla del PMS, no
// habla de depósito.
const test = require('node:test');
const assert = require('node:assert/strict');
const { WRITER_SYSTEM_PROMPT } = require('../lib/pilot/llm/writer.js');
const { instruccionesCamiVoz } = require('../lib/voz/cami-voz');

test('redactor: regla del hecho anticipo_reserva (se descuenta, sin depósito)', () => {
  assert.match(WRITER_SYSTEM_PROMPT, /ADVANCE WITHOUT DEPOSIT \(decision 2026-11-14/);
  assert.match(WRITER_SYSTEM_PROMPT, /"anticipo_reserva"/);
  assert.match(WRITER_SYSTEM_PROMPT, /IS deducted from what they pay later/);
  assert.match(WRITER_SYSTEM_PROMPT, /there is NO damage deposit/);
});

test('redactor: la regla del depósito solo aplica cuando el paquete trae anticipo_deposito', () => {
  assert.match(WRITER_SYSTEM_PROMPT, /applies ONLY to quotes that still carry it/);
  assert.doesNotMatch(WRITER_SYSTEM_PROMPT, /ADVANCE AND DEPOSIT \(decision 2026-10-06\): for stays of 30 nights or more the advance/);
  assert.match(WRITER_SYSTEM_PROMPT, /ONLY if the fact says so, a refundable deposit/);
});

test('llamada sin regla del PMS: anticipo que se descuenta y sin depósito', () => {
  const t = instruccionesCamiVoz({ hoy: '2026-11-14' });
  assert.match(t, /se descuenta de lo que se paga después/);
  assert.doesNotMatch(t, /depósito por posibles daños/);
  // Revisión 2026-11-14 (P2-3): Miu Canal conserva su régimen y su forma de pago.
  assert.match(t, /red Miu Canal el anticipo y la forma de pago son los que trae la cotización/);
});
