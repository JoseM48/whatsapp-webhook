'use strict';

// ANTICIPO QUE SE CONVIERTE EN DEPÓSITO (decisión de José Manuel, 2026-10-06):
// en 30+ noches el anticipo NO se descuenta del total; antes de la llegada se
// paga el valor completo y el anticipo queda como depósito reembolsable. El
// redactor recibe la regla como hecho del paquete (PMS) y esta instrucción.

const test = require('node:test');
const assert = require('node:assert/strict');
const { writerViewOfPacket, WRITER_SYSTEM_PROMPT } = require('../lib/pilot/llm/writer.js');

test('el prompt del redactor explica la regla y prohíbe "se descuenta del total"', () => {
  assert.match(WRITER_SYSTEM_PROMPT, /ADVANCE AND DEPOSIT \(decision 2026-10-06\)/);
  assert.match(WRITER_SYSTEM_PROMPT, /NOT deducted from the total/);
  assert.match(WRITER_SYSTEM_PROMPT, /refunded when the stay ends/);
  assert.match(WRITER_SYSTEM_PROMPT, /first month/);
  assert.match(WRITER_SYSTEM_PROMPT, /Never say or imply that the advance is deducted/);
});

test('el hecho anticipo_deposito y la prohibición llegan al redactor', () => {
  const texto = 'Para separar pagas un anticipo de COP 600.000. Antes de tu llegada pagas el valor completo del mes y ese anticipo queda como depósito por posibles daños, que se te devuelve después de tu salida si todo está bien.';
  const vista = writerViewOfPacket({
    packet_version: 2, facts: [{ topic: 'anticipo_deposito', text: texto }], numbers: [], dates: [], apartments: [],
    required_facts: [{ id: 'anticipo_deposito', statement: 'regla', patterns: ['dep'] }],
    forbidden_claims: ['anticipo_descontado_del_total'], action: 'RESPONDER INFORMACIÓN APROBADA',
    ui: { message_kind: 'text', photo_target_codes: [] }
  });
  assert.ok(vista.facts.some((f) => f.topic === 'anticipo_deposito' && f.text === texto));
  assert.ok(vista.required_facts.some((f) => f.id === 'anticipo_deposito'));
  assert.ok(vista.forbidden.includes('anticipo_descontado_del_total'));
});
