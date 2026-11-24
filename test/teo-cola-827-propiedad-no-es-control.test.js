'use strict';

// TEO-COLA #827 (2026-11-24): José probó A22 desde su celular (el número interno,
// que está en la lista de prueba de A22) y la Cami de A22 nunca respondió: el
// webhook mandaba ese mensaje por el camino de control (/closed-pilot/inbound),
// que siempre aplica P2. Un mensaje a un número de propiedad va por el camino
// comercial; el de Miu sigue igual. Números falsos.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { rutaControlM0 } = require('../lib/pilot/numero-propiedad');

const INTERNO = '570000000001';
const m0 = {
  accepts: (from) => Boolean(from),
  isControl: (from, raw) => from === INTERNO || raw === 'NUEVA PRUEBA'
};

test('interno escribiendo a un número de propiedad: camino comercial, no control', () => {
  assert.equal(rutaControlM0({ phoneNumberId: '1460000000000555', text: 'Hola', raw: 'Hola', from: INTERNO, m0 }), null);
  assert.equal(rutaControlM0({ phoneNumberId: '1460000000000555', text: null, raw: '', from: INTERNO, m0 }), null);
  assert.equal(rutaControlM0({ phoneNumberId: '1460000000000555', text: 'NUEVA PRUEBA', raw: 'NUEVA PRUEBA', from: '570000000002', m0 }), null);
});

test('remitente no aceptado en número de propiedad: sigue a control (cuarentena de siempre)', () => {
  assert.equal(rutaControlM0({ phoneNumberId: '1460000000000555', text: 'Hola', raw: 'Hola', from: '', m0 }), 'control');
});

test('Miu sin cambio: interno = control, interno sin texto = cuarentena, huésped = comercial', () => {
  assert.equal(rutaControlM0({ text: 'ESTADO', raw: 'ESTADO', from: INTERNO, m0 }), 'control');
  assert.equal(rutaControlM0({ text: null, raw: '', from: INTERNO, m0 }), 'cuarentena');
  assert.equal(rutaControlM0({ text: 'Hola', raw: 'Hola', from: '570000000002', m0 }), null);
  assert.equal(rutaControlM0({ text: 'NUEVA PRUEBA', raw: 'NUEVA PRUEBA', from: '570000000002', m0 }), 'control');
});

test('index.js usa rutaControlM0 en las dos ramas de control', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  assert.match(src, /rutaControl === 'cuarentena'/);
  assert.match(src, /rutaControl === 'control'/);
  assert.doesNotMatch(src, /!m0ClosedPilot\.accepts\(incoming\.from\) \|\| m0ClosedPilot\.isControl\(incoming\.from, raw\)/);
});
