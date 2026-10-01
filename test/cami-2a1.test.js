'use strict';

// FASE 2A-1 (2026-10-01): el redactor recibe el conocimiento publicado de las
// candidatas (ficha, perfil, edificio y comparación) y la instrucción GENÉRICA
// de recomendar según la necesidad con hechos gobernados. Ningún apartamento
// tiene regla propia en el prompt.

const test = require('node:test');
const assert = require('node:assert/strict');
const { writerViewOfPacket, WRITER_SYSTEM_PROMPT } = require('../lib/pilot/llm/writer.js');

const paquete = {
  packet_version: 2,
  presentation: { mode: 'candidates', min: 1, max: 2, cover_codes: ['LF-1208', 'LF-404'],
    candidates: [{ code: 'LF-1208', options: [{ total: 'COP 3.300.000', deposit: 'COP 600.000' }] },
      { code: 'LF-404', options: [{ total: 'COP 3.300.000', deposit: 'COP 600.000' }] }] },
  unit_context: [
    { code: 'LF-1208', capacity: 2, published_sheet: true, public_title: 'Estudio con vista panorámica y aire acondicionado',
      facts: { air_conditioning: true, balcony: false }, unknown: [], extras: [], highlights_es: ['Aire acondicionado'], profile_facts: ['Baño completo privado.'] },
    { code: 'LF-404', capacity: 3, published_sheet: true, facts: { air_conditioning: false, balcony: true }, unknown: [], extras: [], highlights_es: [], profile_facts: [] },
    { code: 'LF-510', capacity: 3, published_sheet: false }
  ],
  building_facts: ['Parqueadero incluido, cubierto y dentro del edificio; recepción asigna el espacio al registrarse.'],
  unit_comparison: { attributes: [{ key: 'air_conditioning', label_es: 'aire acondicionado', values: { 'LF-1208': true, 'LF-404': false } }],
    exclusive_true: { 'LF-1208': ['aire acondicionado'], 'LF-404': ['balcón'] } }
};

test('la vista del redactor trae ficha publicada, hechos de edificio y comparación', () => {
  const vista = writerViewOfPacket(paquete);
  assert.equal(vista.unit_context[0].facts.air_conditioning, true);
  assert.deepEqual(vista.unit_context[0].highlights_es, ['Aire acondicionado']);
  assert.equal(vista.unit_context[2].published_sheet, false);
  assert.deepEqual(vista.building_facts, paquete.building_facts);
  assert.equal(vista.unit_comparison.attributes[0].key, 'air_conditioning');
  assert.equal('exclusive_true' in vista.unit_comparison, false);
});

test('sin conocimiento en el paquete, la vista no inventa nada', () => {
  const vista = writerViewOfPacket({ packet_version: 2 });
  assert.deepEqual(vista.building_facts, []);
  assert.equal(vista.unit_comparison, null);
});

test('el prompt es genérico: recomendar por necesidad con hechos, sin inventar ventajas ni reglas por apartamento', () => {
  assert.match(WRITER_SYSTEM_PROMPT, /Recommend according to what the guest needs, using only these facts/);
  assert.match(WRITER_SYSTEM_PROMPT, /Never invent an advantage/);
  assert.match(WRITER_SYSTEM_PROMPT, /unknown \(not confirmed: never affirm or deny them\)/);
  assert.match(WRITER_SYSTEM_PROMPT, /If published_sheet is false, nothing specific is confirmed/);
  // Ningún código de apartamento como regla en el prompt (solo el ejemplo de formato "LF-210").
  const codigos = (WRITER_SYSTEM_PROMPT.match(/LF-\d{3,4}/g) || []).filter((c) => c !== 'LF-210');
  assert.deepEqual(codigos, []);
});

test('la información "a pedido" (informative) se explica como no comercial: solo si el huésped pregunta o compara', () => {
  assert.match(WRITER_SYSTEM_PROMPT, /informative \(verified facts to use ONLY when the guest asks about, compares or has an expectation on that topic/);
  assert.match(WRITER_SYSTEM_PROMPT, /never bring them up on your own in a presentation and never present them as a selling point/);
  const vista = writerViewOfPacket({ packet_version: 2, unit_context: [{ code: 'LF-210', published_sheet: true, informative: [{ label_es: 'Vista limitada', value: true }] }] });
  assert.deepEqual(vista.unit_context[0].informative, [{ label_es: 'Vista limitada', value: true }]);
});
