'use strict';
// TEO-COLA #67: el redactor enumeraba los apartamentos y el bloque de precios los volvía a listar.
const test = require('node:test');
const assert = require('node:assert/strict');
const { insertarBloquePrecios, WRITER_SYSTEM_PROMPT } = require('../lib/pilot/llm/writer');

const pk = { price_presentation: { block_text: 'LF-1109: $3.577.200 al mes · 30 noches\nLF-210: $3.000.000 al mes · 30 noches\nValor fijo durante tu estadía.' } };
const veces = (t, c) => (t.match(new RegExp(c, 'g')) || []).length;

test('la lista que solo nombra los apartamentos no se repite junto al bloque', () => {
  const t = insertarBloquePrecios(pk, 'Tengo estas opciones:\n• LF-1109\n1. LF-210 (apartaestudio)\n[[PRECIOS]]\n¿Cuál te gusta?');
  assert.equal(veces(t, 'LF-1109'), 1);
  assert.equal(veces(t, 'LF-210'), 1);
  assert.match(t, /^Tengo estas opciones:\nLF-1109: \$3\.577\.200/);
  assert.match(t, /¿Cuál te gusta\?$/);
});

test('una línea con descripción propia o prosa con el código se deja (no se pierde información)', () => {
  const t = insertarBloquePrecios(pk, '- LF-1109: apartaestudio con balcón grande\n[[PRECIOS]]\nLF-210 tiene más luz. ¿Te sirve?');
  assert.match(t, /apartaestudio con balcón grande/);
  assert.match(t, /LF-210 tiene más luz/);
});

test('un código que no está en el bloque no se toca', () => {
  const t = insertarBloquePrecios(pk, '• LF-904\n[[PRECIOS]]');
  assert.match(t, /• LF-904/);
});

test('el redactor recibe la regla de no enumerar lo que trae el bloque (chat y nota de voz usan el mismo texto)', () => {
  assert.match(WRITER_SYSTEM_PROMPT, /never list or enumerate the apartments yourself/);
});
