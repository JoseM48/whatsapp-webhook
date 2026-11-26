'use strict';
// COTIZACION 24 H (José Manuel, 2026-11-26; DECISIONES_LOG "Cada cotización vale 24 horas";
// PMS migración 1992, política cotizacion_vigencia_v1). En el chat y en las notas de voz la frase
// de vigencia va dentro del bloque de precios que arma el PMS (el webhook solo lo copia). En la
// llamada la trae quote_stay (vigencia_precio) y Cami la dice tal cual (paridad, dominio 25).
const test = require('node:test');
const assert = require('node:assert/strict');
const { instruccionesCamiVoz } = require('../lib/voz/cami-voz');

test('llamada: si quote_stay trae vigencia_precio, Cami dice el día y la hora tal cual', () => {
  const txt = instruccionesCamiVoz({ hoy: '2026-11-26' });
  assert.match(txt, /VIGENCIA DEL PRECIO \(José Manuel, 2026-11-26\)/);
  assert.match(txt, /si quote_stay trae vigencia_precio, al dar el precio di su texto con el día y la hora tal cual/);
  assert.match(txt, /no la menciones si quote_stay no la trae/);
});
