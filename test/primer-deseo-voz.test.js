'use strict';

// PRIMER DESEO EN LA LLAMADA DEL 7355 (José Manuel, 2026-11-22; PMS migración 1760; paridad, dominio 25).
// Sin necesidad registrada, Cami de TenGo saluda y termina con la pregunta; con necesidad, no la repite.
const test = require('node:test');
const assert = require('node:assert/strict');
const { instruccionesCamiTenGoVoz, presentacionTenGo, primerDeseoDesdeInicio, lineaPrimerDeseo } = require('../lib/voz/cami-voz');

test('sin necesidad registrada: el saludo termina con la pregunta y la instrucción la pone primero', () => {
  const pd = primerDeseoDesdeInicio({ registrado: false, pregunta: '¿Qué es lo que más te gustaría resolver o lograr con nosotros? Cuéntamelo con tus palabras.' });
  assert.match(presentacionTenGo('Ana', pd), /Qué es lo que más te gustaría resolver o lograr con nosotros\?/);
  assert.doesNotMatch(presentacionTenGo('Ana', pd), /Me cuentas de tu negocio/);
  const ins = instruccionesCamiTenGoVoz({ hoy: '2026-11-22', nombre: 'Ana', primerDeseo: pd });
  assert.match(ins.split('\n')[0], /^PRIMER DESEO \(lo primero/);
});

test('con necesidad registrada: no se vuelve a preguntar', () => {
  const pd = primerDeseoDesdeInicio({ registrado: true, texto: 'Que mi WhatsApp conteste solo' });
  assert.match(presentacionTenGo(null, pd), /Me cuentas de tu negocio/);
  assert.match(lineaPrimerDeseo(pd), /No se lo vuelvas a preguntar/);
  assert.match(lineaPrimerDeseo(pd), /WhatsApp conteste solo/);
});

test('PMS anterior (sin primer_deseo): todo sigue igual', () => {
  assert.equal(primerDeseoDesdeInicio(undefined), null);
  assert.match(presentacionTenGo('Ana'), /Me cuentas de tu negocio/);
  assert.doesNotMatch(instruccionesCamiTenGoVoz({ hoy: '2026-11-22' }), /PRIMER DESEO/);
});
