'use strict';

// BLOQUE 5 (auditoria 2026-10-02): ajustes de redaccion del backlog H2-H5.
const test = require('node:test');
const assert = require('node:assert/strict');
const { WRITER_SYSTEM_PROMPT } = require('../lib/pilot/llm/writer.js');

test('H2: fechas en espanol natural permitidas, sin cambiar dia, mes ni anio', () => {
  assert.match(WRITER_SYSTEM_PROMPT, /"15 de octubre"/);
  assert.match(WRITER_SYSTEM_PROMPT, /never change the day, month or year/);
});
test('H4: sin una necesidad declarada no se destaca un apartamento como el mejor', () => {
  assert.match(WRITER_SYSTEM_PROMPT, /do not single one out \(H4\)/);
});
test('H5: cierra con un siguiente paso claro', () => {
  assert.match(WRITER_SYSTEM_PROMPT, /end with one clear, friendly next step/);
});
test('H3: el aviso de "sin dinero" no se repite en cada mensaje', () => {
  assert.match(WRITER_SYSTEM_PROMPT, /do not repeat it in every message/);
});
test('H1: si el apartamento pedido no sirve, ofrece buscar alternativas sin nombrar otras unidades', () => {
  assert.match(WRITER_SYSTEM_PROMPT, /WHEN THE REQUESTED APARTMENT DOES NOT FIT \(H1\)/);
  assert.match(WRITER_SYSTEM_PROMPT, /Do not name or describe apartments that are not in "apartments"/);
});
