'use strict';
// TEO-COLA #66: el filtro anti-repetición no puede dejar a Cami sin siguiente paso ni sin responder.
const test = require('node:test');
const assert = require('node:assert/strict');
const { sinTextosFijosRepetidos } = require('../lib/pilot/textos-fijos-sin-repetir');

const OFERTA = 'Si te suena, te anoto en nuestra lista de espera: no pagas nada ni te comprometes; cuando abramos esas fechas te escribo primero con la tarifa vigente y el apartamento.';
const COND = 'Para reservar no pagas nada ahora: te la dejamos pre-confirmada.';
const DEP = 'Antes de entrar pagas el primer mes y un depósito de $600.000 que se te devuelve al check-out si todo está bien.';

test('la oferta de lista de espera (siguiente paso) no se quita aunque ya haya salido', () => {
  const texto = `Para esas fechas no tengo cupo. ${OFERTA}`;
  const r = sinTextosFijosRepetidos(texto, [OFERTA]);
  assert.match(r.texto, /te anoto en nuestra lista de espera/);
});

test('una condición en forma de pregunta no se quita', () => {
  const q = '¿Te la dejamos pre-confirmada para esas fechas sin pagar nada ahora?';
  const r = sinTextosFijosRepetidos(`Perfecto, el LF-1109 sigue libre.\n${q}`, [q]);
  assert.match(r.texto, /pre-confirmada para esas fechas/);
});

test('si el huésped pregunta por el depósito, las condiciones son la respuesta y salen', () => {
  const texto = `Claro, te explico de nuevo. ${COND} ${DEP}`;
  const r = sinTextosFijosRepetidos(texto, [`${COND} ${DEP}`], { mensajeHuesped: '¿Cómo es lo del depósito?' });
  assert.equal(r.texto, texto);
});

test('sin pregunta del huésped sobre pagos, la condición repetida sí se resume (lo bueno se queda)', () => {
  const texto = `Te recuerdo la opción del LF-1109 con balcón y buena luz. ${DEP}`;
  const r = sinTextosFijosRepetidos(texto, [DEP], { mensajeHuesped: 'y tiene balcón?' });
  assert.doesNotMatch(r.texto, /depósito de \$600\.000/);
  assert.match(r.texto, /Las demás condiciones son las mismas/);
});

test('una frase de siguiente paso con variantes agotadas se deja; la cortesía pura se quita', () => {
  const paso = 'Te confirmo por aquí apenas lo revisen.';
  const alt = 'Apenas me respondan, te escribo por aquí.';
  const r = sinTextosFijosRepetidos(`Ya le pasé tu solicitud de mascota al equipo. ${paso}`, [paso, alt]);
  assert.match(r.texto, /Te confirmo por aquí apenas lo revisen\./);
  const gracias = 'Gracias por llamar a Miu La Frontera.';
  const r2 = sinTextosFijosRepetidos(`Te mando el resumen de la llamada por aquí mismo. ${gracias}`, [gracias, 'Gracias de nuevo por tu llamada.']);
  assert.doesNotMatch(r2.texto, /Gracias por llamar/);
});
