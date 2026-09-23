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

// CAMBIO DELIBERADO DE SEMANTICA (2026-09-23, Plan Padrino).
//
// La allowlist era la herramienta de D1: un solo telefono de prueba mientras
// se validaba la ruta. Para una campana no sirve -- los telefonos de los
// leads son desconocidos de antemano y ninguna lista puede contenerlos.
// Mantenerla habria mandado la pauta entera a legacy, es decir, que nada de
// lo validado le aplicara a un lead real.
//
// Estas dos pruebas afirmaban lo contrario y se reescriben a proposito: no
// es una regresion tapada, es la regla nueva.
test('encendida sin lista, un huesped cualquiera SI entra', () => {
  const r = evaluateConversationalRoute(TEST_PHONE,
    { NEW_LLM_CONVERSATIONAL_ROUTE_ENABLED: 'true', NEW_LLM_CONVERSATIONAL_ROUTE_PHONES: '' });
  assert.equal(r.allowed, true);
});

test('un telefono externo DESCONOCIDO entra por la ruta nueva', () => {
  // El caso de la campana: un lead que nadie pudo anotar en ninguna lista.
  const r = evaluateConversationalRoute('573001112233', encendida);
  assert.equal(r.allowed, true);
  assert.equal(r.reason, 'route_enabled');
});

test('con la bandera apagada, ese mismo externo cae a legacy', () => {
  const r = evaluateConversationalRoute('573001112233',
    { NEW_LLM_CONVERSATIONAL_ROUTE_ENABLED: 'false' });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, 'route_disabled');
});

test('sin telefono va a legacy, nunca a la ruta nueva', () => {
  for (const valor of [undefined, null, '', '   ', 'no-es-un-numero']) {
    const r = evaluateConversationalRoute(valor, encendida);
    assert.equal(r.allowed, false, `valor ${JSON.stringify(valor)} no debe autorizar`);
    assert.equal(r.reason, 'phone_missing');
  }
});

test('el formato del numero sigue sin decidir: se normaliza a digitos', () => {
  assert.equal(isConversationalRouteEnabledFor(TEST_PHONE, encendida), true);
  assert.equal(isConversationalRouteEnabledFor('+' + TEST_PHONE, encendida), true);
  assert.equal(isConversationalRouteEnabledFor('+57 314 689 2662', encendida), true);
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

// EL TELEFONO INTERNO NO PUEDE ENTRAR POR LA RUTA DE HUESPED.
//
// Ahora que la bandera global admite a cualquier telefono, esta separacion
// deja de estar garantizada por la lista y pasa a depender de `isControl()`,
// que atrapa cualquier mensaje del interno ANTES de llegar al router (ver
// index.js, rama `!accepts(from) || isControl(from, raw)`).
//
// Se fija aqui porque el dia que alguien toque esa rama, el interno se
// convertiria en un huesped mas y sus comandos empezarian a interpretarse
// como conversacion comercial.
test('el interno queda fuera de la ruta de huesped por isControl, no por la lista', () => {
  const { createM0ClosedPilotDispatcher } = require('../lib/pilot/m0-closed-pilot.js');
  const dispatcher = createM0ClosedPilotDispatcher({
    config: { enabled: true, guestPhone: TEST_PHONE, internalPhone: '573006774425',
      metaSignatureRequired: true, pmsM0Enabled: true, controlledIngressEnabled: true,
      pmsConfigured: true, receiptsEnabled: true,
      internalTemplateName: 'm0_internal_escalation_v1', internalTemplateLanguage: 'es_CO' },
    pms: {}, sendText: async () => ({})
  });

  // Cualquier texto del interno -- incluso uno que parece de huesped -- se
  // desvia al camino de comandos internos.
  for (const texto of ['me quedo con el 210', 'hola', '¿tienen disponibilidad?']) {
    assert.equal(dispatcher.isControl('573006774425', texto), true,
      `"${texto}" desde el interno debe ir a comandos, no a la ruta comercial`);
  }
  // Y un huesped con el mismo texto NO se desvia.
  assert.equal(dispatcher.isControl(TEST_PHONE, 'me quedo con el 210'), false);
});
