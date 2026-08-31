'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseFlowResponse, flowResponseToText } = require('../lib/pilot/flow-response');

test('parsea una respuesta con fecha de salida exacta', () => {
  const parsed = parseFlowResponse(JSON.stringify({
    checkin_date: '2026-10-01', checkout_date: '2026-12-30', guests: '2'
  }));
  assert.deepEqual(parsed, { checkinDate: '2026-10-01', checkoutDate: '2026-12-30', guests: 2 });
});

test('parsea una respuesta con plan de duración', () => {
  const parsed = parseFlowResponse(JSON.stringify({ checkin_date: '2026-10-01', duration: '3m', guests: '4' }));
  assert.deepEqual(parsed, { checkinDate: '2026-10-01', months: 3, guests: 4 });
});

test('convierte la respuesta con fecha de salida a un texto sin ambigüedad', () => {
  assert.equal(
    flowResponseToText({ checkinDate: '2026-10-01', checkoutDate: '2026-12-30', guests: 2 }),
    'Del 2026-10-01 al 2026-12-30, 2 personas.'
  );
  assert.equal(
    flowResponseToText({ checkinDate: '2026-10-01', checkoutDate: '2026-10-02', guests: 1 }),
    'Del 2026-10-01 al 2026-10-02, 1 persona.'
  );
});

test('convierte la respuesta con plan de duración a un texto sin ambigüedad', () => {
  assert.equal(
    flowResponseToText({ checkinDate: '2026-10-01', months: 3, guests: 2 }),
    'Del 2026-10-01, 3 meses, 2 personas.'
  );
  assert.equal(
    flowResponseToText({ checkinDate: '2026-10-01', months: 1, guests: 1 }),
    'Del 2026-10-01, 1 mes, 1 persona.'
  );
});

test('rechaza response_json ausente o mal formado', () => {
  assert.throws(() => parseFlowResponse(null), /flow_response_missing/);
  assert.throws(() => parseFlowResponse('{not json'), /flow_response_invalid_json/);
});

test('rechaza una fecha de check-in inválida o ausente', () => {
  assert.throws(() => parseFlowResponse(JSON.stringify({ duration: '3m', guests: '2' })),
    /flow_response_checkin_date_invalid/);
  assert.throws(() => parseFlowResponse(JSON.stringify({ checkin_date: '01/10/2026', duration: '3m', guests: '2' })),
    /flow_response_checkin_date_invalid/);
});

test('rechaza una fecha de salida inválida', () => {
  assert.throws(() => parseFlowResponse(JSON.stringify({
    checkin_date: '2026-10-01', checkout_date: '30/12/2026', guests: '2'
  })), /flow_response_checkout_date_invalid/);
});

test('rechaza un número de personas ausente o fuera de rango', () => {
  assert.throws(() => parseFlowResponse(JSON.stringify({ checkin_date: '2026-10-01', duration: '3m' })),
    /flow_response_guests_invalid/);
  assert.throws(() => parseFlowResponse(JSON.stringify({ checkin_date: '2026-10-01', duration: '3m', guests: '0' })),
    /flow_response_guests_invalid/);
  assert.throws(() => parseFlowResponse(JSON.stringify({ checkin_date: '2026-10-01', duration: '3m', guests: '5' })),
    /flow_response_guests_invalid/);
});

test('rechaza una duración fuera del catálogo de 1/3/6/12 meses cuando no hay fecha de salida', () => {
  assert.throws(() => parseFlowResponse(JSON.stringify({ checkin_date: '2026-10-01', duration: '2m', guests: '2' })),
    /flow_response_duration_invalid/);
  assert.throws(() => parseFlowResponse(JSON.stringify({ checkin_date: '2026-10-01', guests: '2' })),
    /flow_response_duration_invalid/);
});
