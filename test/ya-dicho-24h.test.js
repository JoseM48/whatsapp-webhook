'use strict';

// "SE REPITIÓ" (juez de calidad, 2026-11-12): el redactor ve las frases que Cami ya dijo en 24 h
// y tiene la regla de no copiarlas; la llamada tiene la misma regla (paridad, dominio 25).

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildWriterInput, frasesYaDichas, WRITER_SYSTEM_PROMPT } = require('../lib/pilot/llm/writer');
const voz = require('../lib/voz/cami-voz');

const transcript = [
  { role: 'cami', at: '2026-11-10T08:00:00Z', text: 'Frase vieja de hace dos días que ya no cuenta para nada.' },
  { role: 'guest', at: '2026-11-11T15:00:00Z', text: 'Hola, ¿tienen algo para diciembre?' },
  { role: 'cami', at: '2026-11-11T15:01:00Z', text: 'Perfecto, esta es una de las opciones:\nLF-1109: $3.577.200 al mes · 30 noches\nValor fijo durante tu estadía; en estadías de más de 3 meses se revisa cada 3 meses.\n1. Opción de menú que no debe salir en la lista' },
  { role: 'human', at: '2026-11-11T16:00:00Z', text: 'Mensaje de José Manuel que no es de Cami y no cuenta.' },
  { role: 'cami', at: '2026-11-11T20:00:00Z', text: 'Valor fijo durante tu estadía; en estadías de más de 3 meses se revisa cada 3 meses. Cuando quieras me dices cuál prefieres.' }
];

test('frasesYaDichas: solo Cami, últimas 24 h, sin precios ni opciones, sin repetidas', () => {
  const f = frasesYaDichas(transcript);
  assert.ok(f.includes('Valor fijo durante tu estadía; en estadías de más de 3 meses se revisa cada 3 meses.'));
  assert.equal(f.filter((x) => x.startsWith('Valor fijo')).length, 1);
  assert.ok(!f.some((x) => x.startsWith('Frase vieja')), 'lo de hace 2 días no entra');
  assert.ok(!f.some((x) => x.startsWith('LF-1109') || x.startsWith('1.')), 'ni precios ni opciones');
  assert.ok(!f.some((x) => x.includes('José Manuel')), 'lo humano no entra');
});

test('el redactor recibe la lista y la regla anti-repetición', () => {
  const input = buildWriterInput({ guestText: 'ok', transcript, packet: {}, language: 'es', today: '2026-11-11' });
  assert.match(input, /Sentences you already sent in the last 24 hours/);
  assert.match(input, /Valor fijo durante tu estadía/);
  assert.match(WRITER_SYSTEM_PROMPT, /ALREADY SAID/);
  assert.match(WRITER_SYSTEM_PROMPT, /keeps insisting/);
  const sin = buildWriterInput({ guestText: 'hola', transcript: [], packet: {}, language: 'es', today: '2026-11-11' });
  assert.doesNotMatch(sin, /already sent in the last 24 hours/);
});

test('paridad: la llamada tiene la misma regla de no repetir condiciones ni respuestas', () => {
  assert.match(voz.NO_REPETIR_VOZ, /NO TE REPITAS/);
  assert.match(voz.NO_REPETIR_VOZ, /las condiciones son las mismas que te conté/);
  assert.match(voz.NO_REPETIR_VOZ, /insiste/);
});
