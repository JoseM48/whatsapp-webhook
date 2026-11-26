'use strict';
// COTIZACION 24 H (José Manuel, 2026-11-26; DECISIONES_LOG "Cada cotización vale 24 horas";
// PMS migración 1992, política cotizacion_vigencia_v1). En el chat y en las notas de voz la frase
// de vigencia (día y hora) va dentro del bloque de precios que arma el PMS (el webhook solo lo
// copia). En la llamada quote_stay no guarda propuesta: trae vigencia_precio con "la cotización por
// escrito del chat vale 24 horas" y Cami no promete una hora (excepción declarada, dominio 25).
const test = require('node:test');
const assert = require('node:assert/strict');
const { instruccionesCamiVoz } = require('../lib/voz/cami-voz');

test('llamada: si quote_stay trae vigencia_precio, Cami dice que la cotización escrita vale 24 h, sin prometer una hora', () => {
  const txt = instruccionesCamiVoz({ hoy: '2026-11-26' });
  assert.match(txt, /VIGENCIA DEL PRECIO \(José Manuel, 2026-11-26\)/);
  assert.match(txt, /si quote_stay trae vigencia_precio, al dar el precio di su texto con tus palabras, sin cambiar las horas/);
  assert.match(txt, /Nunca prometas que el precio de esta llamada se mantiene hasta un día o una hora/);
  assert.match(txt, /no hables de vigencia si quote_stay no la trae/);
});
