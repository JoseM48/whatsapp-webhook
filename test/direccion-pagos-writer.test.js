'use strict';

// DIRECCION Y MEDIOS DE PAGO (decisión de José Manuel, 2026-10-07). El PMS
// manda la dirección según la duración (exacta solo en 30+ noches) y los datos
// de pago solo en el paso de pago; el redactor solo puede copiar lo que venga
// en el paquete. El validador del PMS rechaza dirección o enlaces que no vengan.

const test = require('node:test');
const assert = require('node:assert/strict');
const { writerViewOfPacket, WRITER_SYSTEM_PROMPT } = require('../lib/pilot/llm/writer.js');

test('canal directo: solo el mapa y el enlace de pago, y solo si vienen en el paquete', () => {
  assert.match(WRITER_SYSTEM_PROMPT, /never include links to other platforms/);
  assert.match(WRITER_SYSTEM_PROMPT, /Only two links are allowed, and only when they appear in this packet/);
  assert.match(WRITER_SYSTEM_PROMPT, /Google Maps link of our address/);
  assert.match(WRITER_SYSTEM_PROMPT, /card payment link \(it comes in "payment_instructions"\)/);
});

test('dirección: exacta solo si el paquete la trae; si no, la zona y la regla de 30 noches', () => {
  assert.match(WRITER_SYSTEM_PROMPT, /ADDRESS \(decision 2026-10-07\)/);
  assert.match(WRITER_SYSTEM_PROMPT, /offer a prior visit/);
  assert.match(WRITER_SYSTEM_PROMPT, /you may ask how many nights/);
  assert.match(WRITER_SYSTEM_PROMPT, /Never write a street, number, coordinates, map link/);
});

test('pago: datos solo en el paso de pago, monto de tarjeta del sistema, sin efectivo', () => {
  assert.match(WRITER_SYSTEM_PROMPT, /ONLY when "payment_instructions" is in "facts"/);
  assert.match(WRITER_SYSTEM_PROMPT, /never calculate an amount yourself/);
  assert.match(WRITER_SYSTEM_PROMPT, /We do not accept cash/);
});

test('el redactor ve la dirección (general_knowledge) y las instrucciones de pago (facts) tal cual', () => {
  const view = writerViewOfPacket({
    general_knowledge: [{ topic: 'address', text: 'Estamos en El Poblado, cerca del Mall La Frontera y del Mall Sao Paulo.' }],
    facts: [{ topic: 'payment_instructions', text: 'en el enlace escribe COP 618.000' }]
  });
  assert.deepEqual(view.general_knowledge, [{ topic: 'address', text: 'Estamos en El Poblado, cerca del Mall La Frontera y del Mall Sao Paulo.' }]);
  assert.equal(view.facts.find((f) => f.topic === 'payment_instructions').text, 'en el enlace escribe COP 618.000');
});
