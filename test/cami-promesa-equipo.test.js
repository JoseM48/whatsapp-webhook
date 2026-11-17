'use strict';

// CASO-0165 (2026-11-17, lead 424): Cami escaló y dijo "José Manuel revisará personalmente la
// solicitud y te responderemos por aquí". Desde el 2026-11-07 "hablar con una persona" va primero a
// Teo (MAPA_DOMINIOS dominio 31; DECISIONES_LOG 2026-11-07 y 2026-11-11). Ninguna variante de los
// textos fijos de revisión humana puede nombrar a José; la frase nueva del hecho human_review tiene
// su variante para no repetirse.

const test = require('node:test');
const assert = require('node:assert/strict');
const { sinTextosFijosRepetidos, VARIANTES_FIJAS } = require('../lib/pilot/textos-fijos-sin-repetir');

const NUEVA = 'El equipo revisa la solicitud y te responde por aquí.';

test('las variantes de revisión humana no nombran a José Manuel', () => {
  for (const v of VARIANTES_FIJAS) {
    if (!/revis/i.test(v.clave) || !/respond|respuesta/i.test(v.clave)) continue;
    for (const variante of v.variantes) assert.doesNotMatch(variante, /jos[eé]/i, variante);
  }
});

test('la frase nueva de human_review se cambia por su variante, sin José, si ya salió en 24 h', () => {
  const r = sinTextosFijosRepetidos(`Listo. ${NUEVA}`, [`Hola. ${NUEVA}`]);
  assert.ok(!r.texto.includes(NUEVA), r.texto);
  assert.match(r.texto, /El equipo ya tiene tu solicitud/);
  assert.doesNotMatch(r.texto, /jos[eé]/i);
});

test('la frase vieja repetida ya no se cambia por otra que nombre a José', () => {
  const vieja = 'José Manuel revisará personalmente la solicitud y te responderemos por aquí.';
  const r = sinTextosFijosRepetidos(vieja, [vieja]);
  assert.doesNotMatch(r.texto, /jos[eé]/i, r.texto);
});
