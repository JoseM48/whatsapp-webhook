'use strict';

// NOMBRE DEL HUÉSPED CONFIABLE (GO de José Manuel, 2026-10-07). Caso real: el
// perfil de WhatsApp del lead 65 es "Espacio" y la plantilla salió "Hola
// Espacio". El PMS decide si hay nombre usable (`guest_name`) y cuándo pedirlo
// (hecho obligatorio `guest_name_question`); el webhook:
//   - le pasa al redactor solo ese nombre (nunca el del perfil);
//   - le hace pedir el nombre una vez, al final, cuando el PMS lo exige, y el
//     validador del PMS rechaza un borrador que no lo pide;
//   - extrae el nombre que da el huésped (`guest_name`) y solo lo envía al PMS
//     cuando existe (un PMS anterior rechaza la clave por esquema estricto);
//   - deja pasar "NOMBRE <lead>: ..." como comando literal.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { writerViewOfPacket, resolveWrittenReply, WRITER_SYSTEM_PROMPT } = require('../lib/pilot/llm/writer.js');
const { interpretationSchemaV2, projectToLegacyInterpretation } = require('../lib/pilot/llm/interpretation-schema-v2.js');
const { PMS_INTERPRETATION_FIELDS } = require('../lib/pilot/llm/interpretation-router.js');
const { publicInterpretation } = require('../lib/pilot/m0-commercial-responder.js');
const { isLiteralCommand } = require('../lib/pilot/llm/manager-intent.js');
const { interpretationSchema } = require('../lib/pilot/ai.js');

const PATRONES = ['a nombre de qui[eé]n', 'tu nombre', 'your name', 'whose name'];
const PAQUETE = {
  packet_version: 2, action: 'ESPERAR VALIDACIÓN', first_contact: false,
  facts: [], numbers: [], dates: [], apartments: ['LF-210'],
  required_facts: [{ id: 'guest_name_question', statement: 'pedir el nombre', patterns: PATRONES }],
  forbidden_claims: [], ui: { message_kind: 'text', photo_target_codes: [] },
  deterministic_text: 'Perfecto, dejo tu pre-reserva en trámite.\n\n¿A nombre de quién registro la reserva?',
  guest_name: null, guest_name_reliable: false, guest_name_question: true
};

test('el redactor solo ve el nombre que manda el PMS (null si no es confiable)', () => {
  assert.deepEqual(writerViewOfPacket(PAQUETE).guest, { name: null });
  assert.deepEqual(writerViewOfPacket({ ...PAQUETE, guest_name: 'Laura', guest_name_reliable: true }).guest, { name: 'Laura' });
  assert.deepEqual(writerViewOfPacket({ ...PAQUETE, guest_name: '  ' }).guest, { name: null });
  // Las banderas internas no llegan al modelo.
  const vista = writerViewOfPacket(PAQUETE);
  assert.equal(vista.guest_name_question, undefined);
  assert.equal(vista.guest_name_reliable, undefined);
  assert.ok(vista.required_facts.some((f) => f.id === 'guest_name_question'));
});

test('el prompt: nunca el nombre del perfil; la pregunta una vez y al final', () => {
  assert.match(WRITER_SYSTEM_PROMPT, /GUEST NAME \(decision 2026-10-07\)/);
  assert.match(WRITER_SYSTEM_PROMPT, /never use a name from their WhatsApp profile/);
  assert.match(WRITER_SYSTEM_PROMPT, /guest_name_question/);
  assert.match(WRITER_SYSTEM_PROMPT, /never ask it again/);
});

// Validador de verdad del PMS si el checkout está presente; si no, uno mínimo
// con la misma regla de hechos obligatorios.
async function validador() {
  const raiz = process.env.M0_PMS_SOURCE_ROOT || 'D:/DESARROLLOS/_WORKTREES/nombre-pms-20261007';
  const ruta = path.join(raiz, 'src/modules/supervised-pilot/m0-response-validator.js');
  if (fs.existsSync(ruta)) {
    const { validateAuthorizedResponse } = await import(pathToFileURL(ruta).href);
    return (packet, text) => validateAuthorizedResponse(packet, text);
  }
  return (packet, text) => {
    const faltan = (packet.required_facts || []).filter((f) => !f.patterns.some((p) => new RegExp(p, 'i').test(text)));
    return { valid: !faltan.length, failure_reasons: faltan.map((f) => `required_fact_missing:${f.id}`) };
  };
}

function proveedor(respuestas) {
  const llamadas = [];
  return { model: 'fake', llamadas, async structured(req) {
    llamadas.push(req);
    return { output: { reply: respuestas.shift(), presented_codes: [], send_photos: [] } };
  } };
}

test('si el borrador no pide el nombre, el validador lo rechaza y la segunda versión lo pide', async () => {
  const validar = await validador();
  const pms = { validateAuthorizedResponse: async ({ packet, candidate_text }) => validar(packet, candidate_text) };
  const prov = proveedor(['¡Listo! Tu pre-reserva del LF-210 queda en trámite.',
    '¡Listo! Tu pre-reserva del LF-210 queda en trámite. ¿A nombre de quién registro la reserva?']);
  const r = await resolveWrittenReply({ packet: PAQUETE, provider: prov, pms, guestText: 'me quedo con el 210',
    transcript: [], interpretation: {}, language: 'es', today: '2026-10-07', logger: { info() {}, error() {} } });
  assert.equal(r.presentation_source, 'llm_written');
  assert.equal(r.attempts, 2);
  assert.ok(r.failure_reasons.includes('required_fact_missing:guest_name_question'));
  assert.match(r.text, /A nombre de quién/);
  // La segunda llamada recibió el motivo del rechazo.
  assert.match(prov.llamadas[1].input, /guest_name_question/);
});

test('si el redactor falla dos veces sale el texto determinista, que ya trae la pregunta', async () => {
  const validar = await validador();
  const pms = { validateAuthorizedResponse: async ({ packet, candidate_text }) => validar(packet, candidate_text) };
  const prov = proveedor(['Listo, en trámite.', 'Listo, en trámite, sin pagos.']);
  const r = await resolveWrittenReply({ packet: PAQUETE, provider: prov, pms, guestText: 'ok', transcript: [],
    interpretation: {}, language: 'es', today: '2026-10-07', logger: { info() {}, error() {} } });
  assert.equal(r.presentation_source, 'deterministic_after_rejection');
  assert.match(r.text, /¿A nombre de quién registro la reserva\?$/);
  assert.equal(validar(PAQUETE, PAQUETE.deterministic_text).valid, true);
});

test('intérprete: guest_name en ambos esquemas; viaja al PMS solo si el huésped dio un nombre', () => {
  assert.deepEqual(interpretationSchemaV2.properties.guest_name, { type: ['string', 'null'], maxLength: 80 });
  assert.ok(interpretationSchemaV2.required.includes('guest_name'));
  assert.deepEqual(interpretationSchema.properties.guest_name, { type: ['string', 'null'], maxLength: 80 });
  assert.ok(interpretationSchema.required.includes('guest_name'));
  assert.ok(PMS_INTERPRETATION_FIELDS.includes('guest_name'));
  const base = { intent: 'other', language: 'es', stay: {}, references: [], budget: {}, preferences: [], requirements: [],
    knowledge_topics: [], corrections: [], ambiguity: [], unmapped_meaning: null };
  assert.equal(projectToLegacyInterpretation({ ...base, guest_name: '  Laura   Gómez ' }).guest_name, 'Laura Gómez');
  assert.equal('guest_name' in projectToLegacyInterpretation({ ...base, guest_name: null }), false);
  assert.equal('guest_name' in projectToLegacyInterpretation({ ...base, guest_name: '   ' }), false);
  // Ruta anterior (ai.js): el modelo devuelve null -> la clave no viaja.
  assert.equal('guest_name' in publicInterpretation({ intent: 'other', guest_name: null, _fallback: false }), false);
  assert.equal(publicInterpretation({ intent: 'other', guest_name: 'Juan' }).guest_name, 'Juan');
});

test('"NOMBRE <lead>: ..." es comando literal (no pasa por el modelo)', () => {
  for (const t of ['NOMBRE 65: Laura Gómez', 'nombre 65 : Laura', 'Nombre lead #65: Ana', 'NOMBRE 65']) assert.equal(isLiteralCommand(t), true, t);
  for (const t of ['nombre', 'mi nombre es Laura', 'NOMBRE: Laura']) assert.equal(isLiteralCommand(t), false, t);
});
