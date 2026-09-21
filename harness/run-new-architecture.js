'use strict';

// Harness de la arquitectura NUEVA -- Bloque B.
//
// Corre el MISMO corpus que run-baseline.js, con las MISMAS expectativas, para
// que los dos numeros sean comparables. Si el corpus o el criterio cambiaran
// entre una corrida y otra, la comparacion no significaria nada.
//
// Diferencia con el baseline: aqui SI se llama al modelo. Por eso:
//   - requiere credenciales y cuesta dinero;
//   - se ejecuta solo sobre corpus NO real (reconstruido o sintetico);
//   - registra proveedor, modelo, llamadas, tokens, latencia y errores.
//
//   node harness/run-new-architecture.js [--provider=openai|anthropic] [--limit=N]

const fs = require('node:fs');
const path = require('node:path');
const { interpretConversationally } = require('../lib/pilot/llm/conversational-engine.js');
const { createLlmProvider } = require('../lib/pilot/llm/provider.js');
const { createFakePms } = require('./fake-pms.js');

const CORPUS = path.join(__dirname, 'corpus', 'gold-cases.json');
const OUT_DIR = path.join(__dirname, 'out');

const DIRECT_FIELDS = new Set(['check_in', 'check_out', 'check_in_status', 'check_out_status',
  'nights', 'guests', 'requested_apartment_code', 'language']);

function parseArgs() {
  const args = Object.fromEntries(process.argv.slice(2)
    .filter((a) => a.startsWith('--'))
    .map((a) => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? 'true']; }));
  return { provider: args.provider || process.env.LLM_PROVIDER || 'anthropic', limit: Number(args.limit) || Infinity };
}

// Mismo criterio que el baseline, mas las expectativas estructurales que la
// arquitectura nueva SI puede satisfacer.
function evaluate(testCase, engineResult) {
  const actual = engineResult.interpretation || {};
  const checks = [];

  for (const [key, expected] of Object.entries(testCase.expect || {})) {
    if (key === 'needs_reference_resolution') {
      const emitted = (engineResult.v2?.references || []).length > 0;
      const called = (engineResult.tool_trace || []).some((t) => t.tool === 'resolve_apartment_reference');
      checks.push({ field: key, expected, actual: { emitted, called }, pass: emitted || called, kind: 'structural' });
      continue;
    }
    if (key === 'should_trigger_confirmation') {
      const got = Boolean(engineResult.confirmation);
      checks.push({ field: key, expected, actual: got, pass: got === expected, kind: 'structural' });
      continue;
    }
    if (key === 'must_not_affirm') {
      // Se satisface si el modelo no invento el atributo: o lo declaro
      // ambiguo, o pidio la tool, o no lo afirmo en ningun campo.
      const askedTool = (engineResult.tool_trace || []).some((t) =>
        t.tool === 'search_commercial_knowledge' || t.tool === 'get_public_apartment_attributes');
      const declared = (engineResult.v2?.ambiguity || []).length > 0;
      checks.push({ field: key, expected, actual: { askedTool, declared }, pass: askedTool || declared, kind: 'structural' });
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
      checks.push({ field: key, expected, actual: list, pass: Array.isArray(list) && list.includes(expected), kind: 'field' });
      continue;
    }
    checks.push({ field: key, expected, actual: 'no reconocida', pass: false, kind: 'unknown' });
  }
  return checks;
}

async function main() {
  const { provider: providerName, limit } = parseArgs();
  const corpus = JSON.parse(fs.readFileSync(CORPUS, 'utf8'));
  const today = corpus.meta.today_reference;

  let provider;
  try {
    provider = createLlmProvider({ ...process.env, LLM_PROVIDER: providerName });
  } catch (error) {
    console.error(`No se pudo crear el proveedor "${providerName}": ${error.message}`);
    process.exit(2);
  }

  const keyVar = providerName === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY';
  if (!process.env[keyVar]) {
    console.error(`FALTA ${keyVar}. Esta corrida requiere credencial y no se puede ejecutar.`);
    process.exit(3);
  }

  const results = [];
  const totals = { input_tokens: 0, output_tokens: 0, calls: 0, latency_ms: 0, errors: 0 };

  for (const testCase of corpus.cases.slice(0, limit)) {
    const pms = createFakePms({ proposalSnapshot: testCase.context?.proposal_snapshot
      ? { ...testCase.context.proposal_snapshot, selected_code: testCase.context.requested_apartment_code || null }
      : null });

    // Un caso fragmentado se evalua por el estado acumulado: los mensajes
    // previos van al transcript y el ultimo es el turno a interpretar.
    const messages = Array.isArray(testCase.sequence) ? testCase.sequence : [testCase.text];
    const transcript = messages.slice(0, -1).map((text) => ({ role: 'guest', text, at: `${today}T10:00:00Z` }));
    const current = messages[messages.length - 1];

    const startedAt = Date.now();
    let engineResult;
    try {
      engineResult = await interpretConversationally({
        text: current, today, transcript,
        commercialContext: testCase.context || {},
        language: testCase.context?.language_preference || 'es',
        pendingConfirmation: null, olderSummary: null, caseState: 'created'
      }, { provider, executor: pms.execute, flags: { semanticConfirmation: true, shadowParser: true }, logger: { warn() {}, info() {}, error() {} } });
    } catch (error) {
      engineResult = { ok: false, fallback: true, error_code: String(error?.code || error?.message).slice(0, 80) };
    }

    const latency = Date.now() - startedAt;
    totals.latency_ms += latency;
    totals.input_tokens += engineResult.usage?.input_tokens || 0;
    totals.output_tokens += engineResult.usage?.output_tokens || 0;
    totals.calls += engineResult.usage?.calls || 0;
    if (!engineResult.ok) totals.errors += 1;

    const checks = engineResult.ok ? evaluate(testCase, engineResult) : [];
    results.push({
      id: testCase.id, category: testCase.category, provenance: testCase.provenance,
      ok: engineResult.ok, error_code: engineResult.error_code || null,
      passed: engineResult.ok && checks.every((c) => c.pass),
      checks,
      tools_called: (engineResult.tool_trace || []).map((t) => ({ tool: t.tool, status: t.status })),
      confirmation: engineResult.confirmation ? { triggers: engineResult.confirmation.triggers } : null,
      shadow_discrepancies: engineResult.shadow?.discrepancies || [],
      unmapped_meaning: engineResult.v2?.unmapped_meaning || null,
      ambiguity: engineResult.v2?.ambiguity || [],
      context_tokens: engineResult.context_meta?.estimated_tokens ?? null,
      latency_ms: latency
    });

    process.stdout.write(`${results[results.length - 1].passed ? '.' : 'x'}`);
  }
  process.stdout.write('\n');

  const byCategory = {};
  for (const r of results) {
    const b = byCategory[r.category] || (byCategory[r.category] = { total: 0, passed: 0 });
    b.total += 1; if (r.passed) b.passed += 1;
  }

  const summary = {
    generated_at: new Date().toISOString(),
    architecture: 'LLM_PRIMARY_V1',
    provider: providerName, model: provider.model,
    corpus_version: corpus.meta.version,
    total_cases: results.length,
    passed: results.filter((r) => r.passed).length,
    failed: results.filter((r) => !r.passed).length,
    engine_errors: totals.errors,
    usage: totals,
    avg_latency_ms: Math.round(totals.latency_ms / Math.max(1, results.length)),
    tool_calls_total: results.reduce((s, r) => s + r.tools_called.length, 0),
    confirmations_triggered: results.filter((r) => r.confirmation).length,
    shadow_discrepancies_total: results.reduce((s, r) => s + r.shadow_discrepancies.length, 0),
    by_category: byCategory
  };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  fs.writeFileSync(path.join(OUT_DIR, `new-architecture-${providerName}-${stamp}.json`),
    JSON.stringify({ summary, results }, null, 2), 'utf8');

  console.log(`\nARQUITECTURA NUEVA -- ${providerName} / ${provider.model}`);
  console.log(`Casos: ${summary.total_cases} | pasan: ${summary.passed} | fallan: ${summary.failed} | errores de motor: ${summary.engine_errors}`);
  console.log(`Llamadas: ${totals.calls} | tokens in/out: ${totals.input_tokens}/${totals.output_tokens} | latencia media: ${summary.avg_latency_ms} ms`);
  console.log(`Tools invocadas: ${summary.tool_calls_total} | confirmaciones: ${summary.confirmations_triggered} | discrepancias shadow: ${summary.shadow_discrepancies_total}`);
  console.log('\nPor categoria:');
  for (const [cat, v] of Object.entries(byCategory)) console.log(`  ${cat.padEnd(24)} ${v.passed}/${v.total}`);
  console.log(`\nInforme: harness/out/new-architecture-${providerName}-${stamp}.json`);
}

main().catch((error) => { console.error(error); process.exit(1); });
