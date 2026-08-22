'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { decideM0Response } = require('../lib/pilot/m0-ingress');

test('M0 no intercepta trafico fuera de la cohorte controlada', () => {
  assert.deepEqual(decideM0Response({ enabled: true, ingressMode: 'allowlist', captured: true }), {
    handled: false, response: null
  });
});

test('M0 muestra el aviso solo al enrolar y solicita una decision cerrada', () => {
  const result = decideM0Response({
    enabled: true, ingressMode: 'controlled_cohort', captured: true, newlyEnrolled: true, text: 'Hola'
  });
  assert.equal(result.handled, true);
  assert.match(result.response, /CONTINUAR/);
  assert.match(result.response, /SALIR/);
  assert.match(result.response, /No incluye publicidad/);
});

test('M0 responde a CONTINUAR y mantiene la gestion comercial manual', () => {
  const result = decideM0Response({
    enabled: true, ingressMode: 'controlled_cohort', captured: true, newlyEnrolled: false, text: 'continuar'
  });
  assert.equal(result.handled, true);
  assert.match(result.response, /fecha de entrada/);
  assert.match(result.response, /José Manuel supervisará/);
});

test('M0 confirma SALIR y acusa recibo de texto libre sin automatizar la gestion comercial', () => {
  const exit = decideM0Response({
    enabled: true, ingressMode: 'controlled_cohort', captured: true, newlyEnrolled: false, text: 'Sálir'
  });
  assert.match(exit.response, /Detuvimos/);
  const received = decideM0Response({
    enabled: true, ingressMode: 'controlled_cohort', captured: true, newlyEnrolled: false, text: 'Mañana'
  });
  assert.equal(received.handled, true);
  assert.match(received.response, /Recibimos los datos/);
  assert.match(received.response, /verificando disponibilidad/);
});

test('M0 nunca deriva fallos de captura ni duplicados al Brain', () => {
  assert.deepEqual(decideM0Response({ enabled: true, ingressMode: 'controlled_cohort', captured: false }), {
    handled: true, response: null
  });
  assert.deepEqual(decideM0Response({
    enabled: true, ingressMode: 'controlled_cohort', captured: true, deduplicated: true
  }), { handled: true, response: null });
});

test('M0 reintenta un aviso pendiente después de una captura duplicada', () => {
  const result = decideM0Response({ enabled: true, ingressMode: 'controlled_cohort', captured: true,
    deduplicated: true, noticePending: true });
  assert.equal(result.handled, true);
  assert.equal(result.consentNoticeSubmissionRequired, true);
  assert.match(result.response, /CONTINUAR/);
});
