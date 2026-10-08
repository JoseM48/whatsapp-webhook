'use strict';

// LEAD 124 (2026-10-08 07:00): "Mes de noviembre del 1 al 30", 1 persona. La
// ruta conversacional leyo llegada 1-nov + 29 noches y el PMS cotizo estadia
// corta (COP 6.170.236) cuando el mes MIO Flex por 30 noches era COP 3.300.000.
//  - Interprete legacy (determinista): "mes de noviembre", "todo noviembre",
//    "noviembre completo", "por un mes desde el 1 de noviembre" y "mes de X del
//    1 al 30/31" = del 1 del mes al 1 del mes siguiente (30/31 noches).
//  - Ruta conversacional (LLM): la misma regla en el prompt. Por la decision del
//    2026-09-21 los parsers no deciden en esa ruta; la red de seguridad
//    determinista es del PMS (`monthly_alternative`).
//  - Redactor: ve `monthly_alternative` y la presenta primero; el validador del
//    PMS la exige (numero y fecha obligatorios, hecho "30 noches").

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { deterministicInterpret, reconcileInterpretation, wholeMonthStay } = require('../lib/pilot/ai.js');
const { SYSTEM_PROMPT } = require('../lib/pilot/llm/conversational-engine.js');
const { projectToLegacyInterpretation } = require('../lib/pilot/llm/interpretation-schema-v2.js');
const { writerViewOfPacket, resolveWrittenReply, WRITER_SYSTEM_PROMPT } = require('../lib/pilot/llm/writer.js');

const HOY = '2026-10-08';
// Paquete real del PMS para el lead 124 (prueba tests/lead124-mes-completo.test.js de pms-lite).
const PAQUETE = JSON.parse(fs.readFileSync(path.join(__dirname, 'lead124-packet.fixture.json'), 'utf8'));

test('legacy: las dos formas del lead 124 y sus variantes piden el mes completo (salida = 1 del mes siguiente)', () => {
  const casos = {
    'Mes de noviembre del 1 al 30': ['2026-11-01', '2026-12-01', 30],
    'Mes de noviembre del 1 al 30, 1 persona': ['2026-11-01', '2026-12-01', 30],
    'el mes de noviembre': ['2026-11-01', '2026-12-01', 30],
    'todo noviembre': ['2026-11-01', '2026-12-01', 30],
    'noviembre completo': ['2026-11-01', '2026-12-01', 30],
    'por un mes desde el 1 de noviembre': ['2026-11-01', '2026-12-01', 30],
    'mes de diciembre del 1 al 31': ['2026-12-01', '2027-01-01', 31],
    'Busco para el mes de enero de 2027': ['2027-01-01', '2027-02-01', 31]
  };
  for (const [texto, [ci, co, noches]] of Object.entries(casos)) {
    const d = deterministicInterpret(texto, { today: HOY });
    assert.deepEqual([d.check_in, d.check_out, d.nights, d.check_in_status, d.check_out_status],
      [ci, co, noches, 'valid', 'valid'], texto);
    // La reconciliacion no deja pasar las 29 noches del modelo.
    const r = reconcileInterpretation(texto, { check_in: ci, check_out: null, nights: 29 }, { today: HOY });
    assert.deepEqual([r.check_in, r.check_out, r.nights], [ci, co, noches], texto);
  }
  assert.deepEqual(deterministicInterpret('Mes de noviembre del 1 al 30, 1 persona', { today: HOY }).missing_fields, []);
});

test('legacy: sin palabra de mes, o con un rango que no cubre el mes, no se toca', () => {
  // "del 1 al 30 de noviembre de 2026" sin "mes": 29 noches, tal cual.
  const literal = deterministicInterpret('del 1 al 30 de noviembre de 2026', { today: HOY });
  assert.deepEqual([literal.check_in, literal.check_out], ['2026-11-01', '2026-11-30']);
  assert.equal(wholeMonthStay('del 1 al 30 de noviembre', HOY), null);
  assert.equal(wholeMonthStay('mes de noviembre del 5 al 20', HOY), null);
  assert.equal(wholeMonthStay('un mes desde el 15 de noviembre', HOY), null);
  // El mes en curso: el dia 1 ya paso, no se adivina.
  assert.equal(wholeMonthStay('todo el mes de octubre', HOY), null);
  assert.equal(wholeMonthStay('quiero algo para 2 personas', HOY), null);
  // Revision independiente: partes del mes, otras duraciones, otro dia u otro mes.
  for (const texto of ['llego a finales del mes de noviembre', 'a mediados del mes de noviembre por 2 semanas',
    'desde el 20 del mes de noviembre', 'el próximo mes de noviembre, 10 noches', 'una semana del mes de noviembre',
    'el mes de noviembre, llego el 5', 'mes de noviembre a partir del 15', 'quiero 2 meses, el mes de noviembre y diciembre',
    'todo noviembre y diciembre']) {
    assert.equal(wholeMonthStay(texto, HOY), null, texto);
  }
  // Las 2 semanas siguen siendo 14 noches.
  assert.equal(deterministicInterpret('a mediados del mes de noviembre por 2 semanas', { today: HOY }).nights, 14);
  // Saludo y personas no lo impiden.
  assert.deepEqual(wholeMonthStay('Buenos días, el mes de noviembre para 2 personas', HOY),
    { check_in: '2026-11-01', check_out: '2026-12-01', nights: 30 });
});

test('ruta conversacional: el prompt trae la regla del mes completo (1 -> 1 del mes siguiente) y la aceptacion de las 30 noches', () => {
  assert.match(SYSTEM_PROMPT, /WHOLE MONTH \(lead 124, 2026-10-08\)/);
  assert.match(SYSTEM_PROMPT, /Do NOT read "mes de noviembre del 1 al 30" as 29 nights/);
  assert.match(SYSTEM_PROMPT, /checkout is the 1st of the next month, never the last day/);
  assert.match(SYSTEM_PROMPT, /a plain range like "del 1 al 30 de noviembre" keeps its literal meaning \(29 nights\)/);
  assert.match(SYSTEM_PROMPT, /record that arrival and 30 nights exact/);
  // Una interpretacion que sigue la regla llega al PMS como 1-nov -> 1-dic, 30 noches.
  const proj = projectToLegacyInterpretation({ intent: 'lodging_search', language: 'es',
    stay: { arrival: { kind: 'exact', date: '2026-11-01', precision: 'day', confidence: 0.95 },
      duration: { nights: 30, kind: 'exact', confidence: 0.95 },
      guests: { total: 1, adults: null, children: null, infants: null, confidence: 0.95 } },
    references: [], budget: { amount_cop: null, period: 'absent' }, preferences: [], requirements: [], knowledge_topics: [],
    corrections: [], ambiguity: [], unmapped_meaning: null });
  assert.deepEqual([proj.check_in, proj.check_out, proj.nights], ['2026-11-01', '2026-12-01', 30]);
});

test('redactor: ve monthly_alternative y la regla de presentarla primero', () => {
  const view = writerViewOfPacket(PAQUETE);
  assert.deepEqual(view.monthly_alternative, { check_in: '2026-11-01', check_out: '2026-12-01', nights: 30, requested_nights: 29,
    total: 'COP 3.300.000', apartments: [{ code: 'LF-210', total: 'COP 3.300.000' }, { code: 'LF-404', total: 'COP 3.300.000' },
      { code: 'LF-510', total: 'COP 3.300.000' }] });
  assert.equal(writerViewOfPacket({ ...PAQUETE, monthly_alternative: undefined }).monthly_alternative, null);
  assert.match(WRITER_SYSTEM_PROMPT, /MONTHLY ALTERNATIVE \(lead 124, 2026-10-08\)/);
  assert.match(WRITER_SYSTEM_PROMPT, /OPEN the message with it, before presenting the candidates/);
  assert.match(WRITER_SYSTEM_PROMPT, /do not name apartment codes in that sentence/);
  assert.match(WRITER_SYSTEM_PROMPT, /When monthly_alternative is absent, never suggest extending to 30 nights with a price/);
});

async function validador() {
  const raiz = process.env.M0_PMS_SOURCE_ROOT || 'D:/DESARROLLOS/_WORKTREES/mes-completo-20261008';
  const ruta = path.join(raiz, 'src/modules/supervised-pilot/m0-response-validator.js');
  if (!fs.existsSync(ruta)) return null;
  const { validateAuthorizedResponse } = await import(pathToFileURL(ruta).href);
  return (packet, text, codes) => validateAuthorizedResponse(packet, text, { presentedCodes: codes });
}
function proveedor(respuestas) {
  const llamadas = [];
  return { model: 'fake', llamadas, async structured(req) {
    llamadas.push(req);
    const [reply, codes] = respuestas.shift();
    return { output: { reply, presented_codes: codes, send_photos: [] } };
  } };
}
const silencio = { info() {}, error() {} };

const SIN_ALTERNATIVA = 'Esta es una de las opciones que tenemos del 1 al 30 de noviembre: LF-210 por COP 5.220.000, anticipo COP 180.000. '
  + 'Todavía no hay dinero real de por medio. ¿Quieres que avancemos con el LF-210?';
const CON_ALTERNATIVA = 'Por 30 noches, del 1 de noviembre al 1 de diciembre, el valor es COP 3.300.000 en total, menos que por 29 noches. '
  + 'Para las fechas exactas, del 1 al 30 de noviembre, esta es una de las opciones que tenemos: LF-210 por COP 5.220.000, anticipo COP 180.000. '
  + 'Todavía no hay dinero real de por medio. ¿Te sirven las 30 noches?';

test('lead 124 con el validador real del PMS: omitir las 30 noches se rechaza y la segunda version las dice primero', async (t) => {
  const validar = await validador();
  if (!validar) return t.skip('sin checkout de pms-lite (M0_PMS_SOURCE_ROOT)');
  // Lo que se envio en produccion (sin la alternativa) ya no pasa.
  const r1 = validar(PAQUETE, SIN_ALTERNATIVA, ['LF-210']);
  assert.equal(r1.valid, false);
  assert.ok(r1.failure_reasons.includes('number_missing:monthly_alternative.total'), r1.failure_reasons.join(','));
  assert.ok(r1.failure_reasons.includes('required_fact_missing:monthly_alternative'), r1.failure_reasons.join(','));
  assert.deepEqual(validar(PAQUETE, CON_ALTERNATIVA, ['LF-210']).failure_reasons, []);
  // La cifra de 30 noches pegada a LF-210 sin decir "30 noches" se rechaza.
  const pegada = 'Esta es una de las opciones que tenemos: LF-210 por COP 3.300.000, anticipo COP 180.000. Hay 30 noches posibles del 1 de noviembre al 1 de diciembre. Sin dinero todavía.';
  assert.ok(validar(PAQUETE, pegada, ['LF-210']).failure_reasons.some((x) => /price_unit_mismatch:LF-210|presented_total_missing:LF-210/.test(x)));
  // El texto determinista (respaldo) abre con la alternativa y es valido.
  assert.match(PAQUETE.deterministic_text, /^Por 30 noches, del 1 de noviembre al 1 de diciembre, el valor es COP 3\.300\.000 en total/);
  assert.deepEqual(validar(PAQUETE, PAQUETE.deterministic_text, null).failure_reasons, []);

  const pms = { validateAuthorizedResponse: async ({ packet, candidate_text, presented_codes }) =>
    validar(packet, candidate_text, presented_codes ?? null) };
  const prov = proveedor([[SIN_ALTERNATIVA, ['LF-210']], [CON_ALTERNATIVA, ['LF-210']]]);
  const r = await resolveWrittenReply({ packet: PAQUETE, provider: prov, pms, guestText: 'Mes de noviembre del 1 al 30',
    transcript: [], interpretation: {}, language: 'es', today: HOY, logger: silencio });
  assert.equal(r.presentation_source, 'llm_written');
  assert.equal(r.attempts, 2);
  assert.ok(r.text.startsWith('Por 30 noches'));
  assert.match(prov.llamadas[1].input, /monthly_alternative/);
});
