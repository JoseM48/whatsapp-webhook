'use strict';

// BLOQUE 3 (auditoria 2026-10-02): Cami recibe la FAQ publicada y los hechos
// del edificio en TODOS los turnos (lead 102: "dos alcobas" sin saber que
// todos son estudios).

const test = require('node:test');
const assert = require('node:assert/strict');
const { writerViewOfPacket, WRITER_SYSTEM_PROMPT } = require('../lib/pilot/llm/writer.js');

test('la vista del redactor trae general_knowledge (tema y texto) y building_facts aunque no haya candidatas', () => {
  const vista = writerViewOfPacket({ packet_version: 2, presentation: null,
    building_facts: ['Todos los apartamentos de Mío La Frontera son estudios.'],
    general_knowledge: [{ topic: 'pets', text: 'Solo mascotas pequeñas.', interno: 'x' }] });
  assert.equal(vista.presentation, null);
  assert.deepEqual(vista.building_facts, ['Todos los apartamentos de Mío La Frontera son estudios.']);
  assert.deepEqual(vista.general_knowledge, [{ topic: 'pets', text: 'Solo mascotas pequeñas.' }]);
});

test('sin conocimiento general en el paquete (PMS anterior) la vista lo deja vacio', () => {
  assert.deepEqual(writerViewOfPacket({ packet_version: 2 }).general_knowledge, []);
});

test('el prompt explica la FAQ y pide honestidad ante lo que no ofrecemos', () => {
  assert.match(WRITER_SYSTEM_PROMPT, /GENERAL KNOWLEDGE \(FAQ\)/);
  assert.match(WRITER_SYSTEM_PROMPT, /never write as if we had it/);
});
