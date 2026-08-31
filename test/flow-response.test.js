'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseFlowResponse, flowResponseToText } = require('../lib/pilot/flow-response');

test('parsea una respuesta válida del Flow de calendario y duración', () => {
  const parsed = parseFlowResponse(JSON.stringify({ checkin_date: '2026-10-01', duration: '3m' }));
  assert.deepEqual(parsed, { checkinDate: '2026-10-01', months: 3 });
});

test('convierte la respuesta a un texto sin ambigüedad para el intérprete', () => {
  assert.equal(flowResponseToText({ checkinDate: '2026-10-01', months: 3 }), 'Del 2026-10-01, 3 meses.');
  assert.equal(flowResponseToText({ checkinDate: '2026-10-01', months: 1 }), 'Del 2026-10-01, 1 mes.');
});

test('rechaza response_json ausente o mal formado', () => {
  assert.throws(() => parseFlowResponse(null), /flow_response_missing/);
  assert.throws(() => parseFlowResponse('{not json'), /flow_response_invalid_json/);
});

test('rechaza una fecha de check-in inválida o ausente', () => {
  assert.throws(() => parseFlowResponse(JSON.stringify({ duration: '3m' })), /flow_response_checkin_date_invalid/);
  assert.throws(() => parseFlowResponse(JSON.stringify({ checkin_date: '01/10/2026', duration: '3m' })),
    /flow_response_checkin_date_invalid/);
});

test('rechaza una duración fuera del catálogo de 1/3/6/12 meses', () => {
  assert.throws(() => parseFlowResponse(JSON.stringify({ checkin_date: '2026-10-01', duration: '2m' })),
    /flow_response_duration_invalid/);
  assert.throws(() => parseFlowResponse(JSON.stringify({ checkin_date: '2026-10-01' })),
    /flow_response_duration_invalid/);
});
