'use strict';

// Compuerta de la ruta conversacional -- BLOQUE C, seccion H.
//
// Lo que se prueba aqui no es que la ruta se encienda: es que NO se encienda.
// Cada caso es una forma de equivocarse que debe terminar en legacy.

const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateConversationalRoute, isConversationalRouteEnabledFor,
  parseAllowlist } = require('../lib/pilot/llm/route-gate.js');

const TEST_PHONE = '573146892662';
const encendida = { NEW_LLM_CONVERSATIONAL_ROUTE_ENABLED: 'true',
  NEW_LLM_CONVERSATIONAL_ROUTE_PHONES: TEST_PHONE };

test('sin configuracion alguna, la ruta esta apagada', () => {
  const r = evaluateConversationalRoute(TEST_PHONE, {});
  assert.equal(r.allowed, false);
  assert.equal(r.reason, 'route_disabled');
});

test('encendida y con el telefono en lista, autoriza', () => {
  assert.equal(evaluateConversationalRoute(TEST_PHONE, encendida).allowed, true);
});

test('encendida pero con la lista vacia, NO autoriza a nadie', () => {
  const r = evaluateConversationalRoute(TEST_PHONE,
    { NEW_LLM_CONVERSATIONAL_ROUTE_ENABLED: 'true', NEW_LLM_CONVERSATIONAL_ROUTE_PHONES: '' });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, 'allowlist_empty');
});

test('un telefono que no esta en la lista va a legacy', () => {
  const r = evaluateConversationalRoute('573001112233', encendida);
  assert.equal(r.allowed, false);
  assert.equal(r.reason, 'phone_not_allowed');
});

test('sin telefono va a legacy, nunca a la ruta nueva', () => {
  for (const valor of [undefined, null, '', '   ', 'no-es-un-numero']) {
    const r = evaluateConversationalRoute(valor, encendida);
    assert.equal(r.allowed, false, `valor ${JSON.stringify(valor)} no debe autorizar`);
    assert.equal(r.reason, 'phone_missing');
  }
});

test('el formato del numero no decide: se comparan digitos de ambos lados', () => {
  // Meta entrega '573146892662'; una lista escrita a mano suele traer '+57 314 689 2662'.
  const conMas = { ...encendida, NEW_LLM_CONVERSATIONAL_ROUTE_PHONES: '+57 314 689 2662' };
  assert.equal(isConversationalRouteEnabledFor(TEST_PHONE, conMas), true);
  assert.equal(isConversationalRouteEnabledFor('+' + TEST_PHONE, encendida), true);
});

test('solo el literal "true" enciende: cualquier otra cosa deja legacy', () => {
  for (const valor of ['TRUE', 'True', '1', 'yes', 'si', 'on', 'false', ' ']) {
    const env = { ...encendida, NEW_LLM_CONVERSATIONAL_ROUTE_ENABLED: valor };
    assert.equal(evaluateConversationalRoute(TEST_PHONE, env).allowed, false,
      `"${valor}" no debe encender la ruta`);
  }
});

// LA PRUEBA QUE JUSTIFICA QUE ESTE GATE EXISTA.
//
// M0_NATURAL_PRESENTATION_RESTRICT_TO_TEST_PHONES esta en `false` en
// produccion y la presentacion natural es global. Reusarlo como control de la
// ruta nueva habria expuesto la ruta a todos los huespedes creyendo que estaba
// restringida. Este gate no debe mirar esa variable ni su lista.
test('NO se apoya en el interruptor de presentacion natural', () => {
  const env = {
    M0_NATURAL_PRESENTATION_RESTRICT_TO_TEST_PHONES: 'true',
    M0_NATURAL_PRESENTATION_TEST_PHONES: TEST_PHONE,
    M0_NATURAL_PRESENTATION_ENABLED: 'true'
  };
  assert.equal(evaluateConversationalRoute(TEST_PHONE, env).allowed, false);
  assert.equal(evaluateConversationalRoute(TEST_PHONE, env).reason, 'route_disabled');
});

test('la lista descarta entradas que no son telefonos', () => {
  assert.deepEqual(parseAllowlist('573146892662, , 123, +57 300 111 2233'),
    ['573146892662', '573001112233']);
});
