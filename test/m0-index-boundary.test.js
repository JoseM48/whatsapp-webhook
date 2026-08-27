'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('la rama M0 no puede volver al envío directo no auditado', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '..', 'index.js'), 'utf8');
  assert.doesNotMatch(source, /enviarWhatsApp\s*\(\s*from\s*,\s*m0\.response\s*\)/);
  assert.match(source, /sendGovernedM0\s*\(\s*\{/);
  assert.match(source, /startM0ObservationLoop\s*\(\s*\{/);
  assert.match(source, /\[m0\] human_fallback_required/);
  assert.match(source, /resolveM0ControlCommand\s*\(\s*\{/);
  assert.match(source, /PMS_LITE_M0_ENABLED requires META_SIGNATURE_REQUIRED=true and META_APP_SECRET/);
  assert.match(source, /operator_stop_persistence_failed[\s\S]{0,500}sendStatus\(503\)/);
  assert.doesNotMatch(source, /OPERATOR_WHATSAPP_RESUME/);
});

test('los estados Meta se persisten antes de cualquier respuesta HTTP y no reingresan como leads', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '..', 'index.js'), 'utf8');
  const extract = source.indexOf('const metaStatuses = extractMetaStatuses(req.body)');
  const persist = source.indexOf('await m0DeliveryReceipts.capture(metaStatuses)');
  const branch = source.indexOf('if (M0_CLOSED_PILOT_ENABLED)', extract);
  const response = source.indexOf('res.sendStatus(200)', extract);
  assert.ok(extract > 0 && persist > extract);
  assert.ok(persist < branch && persist < response);
  assert.match(source, /receipt_persistence_failed[\s\S]{0,300}sendStatus\(503\)/);
});

test('el emisor interno M0 no puede ser sobrescrito por el helper legado de plantillas', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '..', 'index.js'), 'utf8');
  assert.equal((source.match(/function sendM0ClosedInternalTemplate\s*\(/g) || []).length, 1);
  assert.match(source, /sendTemplate:\s*sendM0ClosedInternalTemplate/);
  assert.equal((source.match(/function sendPilotWhatsAppTemplate\s*\(/g) || []).length, 1);
});

test('la captura comercial M0 espera PMS y recupera sólo su operación idempotente', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '..', 'index.js'), 'utf8');
  const closedBranch = source.indexOf('if (M0_CLOSED_PILOT_ENABLED)');
  const wait = source.indexOf('await pmsWarmup.waitUntilReady()', closedBranch);
  const capture = source.indexOf('m0CommercialResponder.captureAndAcknowledge', closedBranch);
  assert.ok(closedBranch > 0 && wait > closedBranch && capture > wait);
  assert.match(source, /capture:\s*\(payload\)\s*=>\s*pmsWarmup\.run\(\(\)\s*=>\s*pilotOrchestrator\.capture\(payload\)\)/);
  assert.match(source, /M0_CLOSED_PILOT_ENABLED\) await pmsWarmup\.waitUntilReady\(\{ force: true \}\)/);
});
