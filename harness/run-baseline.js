'use strict';

// Harness offline del Bloque A -- baseline tecnico de la arquitectura ACTUAL.
//
// Que mide: la capa que HOY gobierna la interpretacion, es decir
// deterministicInterpret() y reconcileInterpretation() de lib/pilot/ai.js.
//
// Por que sin LLM: el baseline debe ser reproducible y gratuito. Estas dos
// funciones son puras -- no tocan red, ni base de datos, ni credenciales --
// asi que el mismo corpus da el mismo resultado siempre. La medicion CON el
// modelo en el lazo cuesta dinero y manda texto a un proveedor externo: es una
// corrida aparte y requiere autorizacion explicita (ver --with-llm, no
// implementado en el Bloque A a proposito).
//
// Que NO hace: no envia mensajes, no consulta produccion, no escribe en
// ninguna base, no despliega. Solo lee el corpus y escribe su informe.

const fs = require('node:fs');
const path = require('node:path');
const { deterministicInterpret, reconcileInterpretation } = require('../lib/pilot/ai.js');

const CORPUS = path.join(__dirname, 'corpus', 'gold-cases.json');
const OUT_DIR = path.join(__dirname, 'out');

// Campos que el corpus puede exigir y que se comparan por igualdad estricta.
const DIRECT_FIELDS = new Set([
  'check_in', 'check_out', 'check_in_status', 'check_out_status',
  'nights', 'guests', 'requested_apartment_code', 'language'
]);

// Expectativas que NO son un campo del schema: describen una capacidad que la
// arquitectura actual no tiene. Se cuentan aparte para no disfrazar de "fallo
// de extraccion" lo que en realidad es una ausencia estructural.
const STRUCTURAL_EXPECTATIONS = new Set([
  'needs_reference_resolution', 'should_trigger_confirmation', 'must_not_affirm'
]);

function interpretCase(testCase, today) {
  const context = testCase.context || {};
  // Un caso fragmentado se evalua por el estado ACUMULADO: cada mensaje se
  // interpreta y su resultado alimenta el contexto del siguiente, que es
  // exactamente lo que hace el flujo real turno a turno.
  if (Array.isArray(testCase.sequence)) {
    let accumulated = { ...context };
    let last = null;
    for (const message of testCase.sequence) {
      last = reconcileInterpretation(message, deterministicInterpret(message, { today, context: accumulated }), { today, context: accumulated });
      accumulated = {
        ...accumulated,
        check_in: last.check_in ?? accumulated.check_in,
        check_in_status: last.check_in !== null ? last.check_in_status : accumulated.check_in_status,
        check_out: last.check_out ?? accumulated.check_out,
        nights: last.nights ?? accumulated.nights,
        guests: last.guests ?? accumulated.guests,
        pending_fields: last.missing_fields
      };
    }
    return { ...last, check_in: accumulated.check_in, guests: accumulated.guests, nights: accumulated.nights };
  }
  const deterministic = deterministicInterpret(testCase.text, { today, context });
  // Se reconcilia contra el MISMO objeto determinista: sin LLM, reconcile()
  // mide el comportamiento real cuando el modelo cae a fallback, que es
  // precisamente uno de los escenarios que interesa medir.
  return reconcileInterpretation(testCase.text, deterministic, { today, context });
}

function evaluate(testCase, actual) {
  const checks = [];
  for (const [key, expected] of Object.entries(testCase.expect || {})) {
    if (STRUCTURAL_EXPECTATIONS.has(key)) {
      checks.push({ field: key, expected, actual: 'no representable', pass: false, kind: 'structural' });
      continue;
    }
    if (DIRECT_FIELDS.has(key)) {
      const got = actual[key] ?? null;
      checks.push({ field: key, expected, actual: got, pass: got === expected, kind: 'field' });
      continue;
    }
    if (key === 'missing_fields_count') {
      const got = (actual.missing_fields || []).length;
      checks.push({ field: key, expected, actual: got, pass: got === expected, kind: 'field' });
      continue;
    }
    if (key.endsWith('_includes')) {
      const list = actual[key.replace('_includes', '')] || [];
      const got = Array.isArray(list) && list.includes(expected);
      checks.push({ field: key, expected, actual: list, pass: got, kind: 'field' });
      continue;
    }
    checks.push({ field: key, expected, actual: 'expectativa no reconocida', pass: false, kind: 'unknown' });
  }
  return checks;
}

function main() {
  const corpus = JSON.parse(fs.readFileSync(CORPUS, 'utf8'));
  const today = corpus.meta.today_reference;
  const results = [];

  for (const testCase of corpus.cases) {
    let actual;
    let crashed = null;
    try {
      actual = interpretCase(testCase, today);
    } catch (error) {
      crashed = String(error && error.message).slice(0, 200);
      actual = {};
    }
    const checks = crashed ? [] : evaluate(testCase, actual);
    // Expectativas de la capa de MERGE (pms-lite mergeCommercialContext), que
    // esta corrida no ejerce: se declaran, no se puntuan como extraccion.
    const mergeDeferred = Object.keys(testCase.expect_merge || {});
    const fieldChecks = checks.filter((c) => c.kind === 'field');
    const structural = checks.filter((c) => c.kind === 'structural');
    results.push({
      id: testCase.id, category: testCase.category, provenance: testCase.provenance,
      source: testCase.source || null, note: testCase.note || '',
      crashed,
      passed: !crashed && fieldChecks.every((c) => c.pass) && structural.length === 0,
      field_checks: fieldChecks, structural_gaps: structural, merge_deferred: mergeDeferred
    });
  }

  const byCategory = {};
  for (const r of results) {
    const bucket = byCategory[r.category] || (byCategory[r.category] = { total: 0, passed: 0 });
    bucket.total += 1;
    if (r.passed) bucket.passed += 1;
  }

  const summary = {
    generated_at: new Date().toISOString(),
    corpus_version: corpus.meta.version,
    today_reference: today,
    baseline_kind: 'LEGACY_DETERMINISTIC_INTERPRETATION',
    scope_note: 'NO es el comportamiento end-to-end de Cami: el LLM no se ejecuto.',
    layer_measured: 'deterministicInterpret + reconcileInterpretation (SIN LLM)',
    total_cases: results.length,
    passed: results.filter((r) => r.passed).length,
    failed: results.filter((r) => !r.passed).length,
    crashed: results.filter((r) => r.crashed).length,
    structural_gaps: results.filter((r) => r.structural_gaps.length > 0).length,
    merge_layer_deferred: results.filter((r) => r.merge_deferred.length > 0).length,
    by_category: byCategory,
    by_provenance: {
      reconstructed_from_documentation: results.filter((r) => r.provenance === 'reconstructed_from_documentation').length,
      synthetic: results.filter((r) => r.provenance === 'synthetic').length
    }
  };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  fs.writeFileSync(path.join(OUT_DIR, `baseline-${stamp}.json`),
    JSON.stringify({ summary, results }, null, 2), 'utf8');

  console.log('LEGACY / DETERMINISTIC INTERPRETATION BASELINE');
  console.log(`Casos: ${summary.total_cases}  |  pasan: ${summary.passed}  |  fallan: ${summary.failed}  |  revientan: ${summary.crashed}`);
  console.log(`Reconstruidos de documentacion: ${summary.by_provenance.reconstructed_from_documentation}  |  sinteticos: ${summary.by_provenance.synthetic}  |  conversaciones reales exportadas: 0`);
  console.log('');
  console.log('Por categoria:');
  for (const [cat, v] of Object.entries(byCategory)) console.log(`  ${cat.padEnd(24)} ${v.passed}/${v.total}`);
  console.log('');
  console.log('Fallos:');
  for (const r of results.filter((x) => !x.passed)) {
    const why = r.crashed ? `EXCEPCION: ${r.crashed}`
      : [...r.field_checks.filter((c) => !c.pass).map((c) => `${c.field}: esperado ${JSON.stringify(c.expected)}, obtuvo ${JSON.stringify(c.actual)}`),
        ...r.structural_gaps.map((c) => `${c.field}: NO REPRESENTABLE en la arquitectura actual`)].join(' | ');
    console.log(`  ${r.id.padEnd(34)} ${why}`);
  }
  console.log('');
  console.log(`Informe: harness/out/baseline-${stamp}.json`);
}

main();
