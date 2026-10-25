'use strict';

// LEAD 256 (2026-10-25): el PMS tardo 18,8 s en decidir el turno y el webhook
// (timeout general de 8 s) lo dio por fallido. La llamada que procesa el turno
// y la que registra el fallo (espera el candado de la fila) tienen timeout
// propio de 30 s; el resto sigue con el general.

const test = require('node:test');
const assert = require('node:assert/strict');
const { PmsPilotClient } = require('../lib/pilot/pms-client');

function cliente(timeoutMs = 8000) {
  const llamadas = [];
  const http = { async post(url, body, opts) { llamadas.push({ url, timeout: opts.timeout }); return { data: { data: {} } }; } };
  return { pms: new PmsPilotClient({ http, baseUrl: 'https://pms.test', secret: 's', timeoutMs }), llamadas };
}

test('procesar el turno comercial y registrar su fallo esperan hasta 30 s', async () => {
  const { pms, llamadas } = cliente();
  await pms.processClosedPilotCommercial({ external_message_id: 'wamid.x' });
  await pms.processingFailure({ external_message_id: 'wamid.x', error_code: 'dependency_timeout', retryable: true });
  assert.deepEqual(llamadas.map((l) => [l.url, l.timeout]), [
    ['https://pms.test/api/supervised-pilot/closed-pilot/commercial/interpretation', 30000],
    ['https://pms.test/api/pilot/processing/failure', 30000]]);
});

test('control: el arranque del turno sigue con el timeout general; uno general mayor manda', async () => {
  const { pms, llamadas } = cliente();
  await pms.beginClosedPilotCommercial({ external_message_id: 'wamid.x' });
  assert.equal(llamadas[0].timeout, 8000);
  const mayor = cliente(45000);
  await mayor.pms.processClosedPilotCommercial({});
  assert.equal(mayor.llamadas[0].timeout, 45000);
});
