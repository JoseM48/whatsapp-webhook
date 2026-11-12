'use strict';

// RESERVA PARA OTRA PERSONA (regla de José Manuel 2026-11-12, teo-cola #49; paridad dominio 25):
// si la reserva es para otra persona, Cami pide el WhatsApp de quien se hospeda o de un responsable
// y le pide al cliente el favor de reenviarle nuestro contacto. Chat y notas de voz (redactor) y
// llamada dicen lo mismo; el check-in en línea del PMS hace lo mismo en su paso de la persona a cargo.

const test = require('node:test');
const assert = require('node:assert/strict');
const { WRITER_SYSTEM_PROMPT } = require('../lib/pilot/llm/writer');
const voz = require('../lib/voz/cami-voz');
const unir = (v) => (Array.isArray(v) ? v.join('\n') : String(v));

test('chat y notas de voz: el redactor tiene la regla de reserva para otra persona', () => {
  assert.match(WRITER_SYSTEM_PROMPT, /BOOKING FOR SOMEONE ELSE \(José Manuel, 2026-11-12\)/);
  assert.match(WRITER_SYSTEM_PROMPT, /or of a person responsible/);
  assert.match(WRITER_SYSTEM_PROMPT, /forward our contact/);
});

test('llamada: Cami voz tiene la misma regla', () => {
  const t = unir(voz.instruccionesCamiVoz({ hoy: '2026-11-12' }));
  assert.match(t, /RESERVA PARA OTRA PERSONA \(2026-11-12\)/);
  assert.match(t, /o el de un responsable/);
  assert.match(t, /reenviarle nuestro contacto/);
});
