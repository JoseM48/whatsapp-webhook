'use strict';

// D0 — evaluacion de la ruta conversacional contra el corpus real anonimizado.
//
// QUE MIDE. Por cada turno real: que entiende la ruta nueva, que tools invoca
// contra el PMS de PRODUCCION (solo lectura) y en que difiere de lo que la
// ruta legacy entendio en su momento.
//
// LEGACY ES BASELINE, NO GOLD. La comparacion sirve para PRIORIZAR revision
// humana, no para declarar correcto al legacy. Un desacuerdo puede ser la ruta
// nueva corrigiendo un error viejo: eso lo decide una persona, no este script.
//
// CONTEXTO POR TURNO, y es una decision con consecuencias: a cada turno se le
// da el contexto comercial que el sistema tenia ANTES de ese turno -- es decir,
// el resultado del turno legacy anterior -- y el transcripto de los turnos
// previos del huesped. Asi se mide la comprension DE ESE MENSAJE y no se
// arrastran errores propios de turno en turno, que convertiria una
// equivocacion temprana en veinte fallos aparentes.
//
// `today` es la fecha real del turno: sin eso, "el 10 de octubre" o "la semana
// que viene" se resolverian contra hoy y la medicion no valdria nada.

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { OpenAiProvider } = require('../lib/pilot/llm/provider.js');
const { PmsPilotClient } = require('../lib/pilot/pms-client.js');
const { interpretConversationally } = require('../lib/pilot/llm/conversational-engine.js');
const { createPmsToolExecutor } = require('../lib/pilot/llm/pms-executor.js');

const CORPUS = path.join(__dirname, 'corpus-d0.json');
const SALIDA = path.join(__dirname, 'resultados-d0.json');

const mudo = { log() {}, warn() {}, error() {} };

function leerClaveOpenAi() {
  const env = fs.readFileSync('D:/DESARROLLOS/whatsapp-webhook/.env', 'utf8');
  const m = env.match(/^OPENAI_API_KEY=(.*)$/m);
  if (!m) throw new Error('sin OPENAI_API_KEY');
  return m[1].trim();
}

// El contexto comercial que tenia el sistema ANTES de este turno.
function contextoPrevio(turnos, indice) {
  const previo = turnos[indice - 1];
  if (!previo) return {};
  return {
    check_in: previo.l_check_in, check_in_status: previo.l_status,
    nights: previo.l_nights ? Number(previo.l_nights) : null,
    guests: previo.l_guests ? Number(previo.l_guests) : null,
    requested_apartment_code: previo.l_apt,
    language: previo.l_lang
  };
}

function transcriptoPrevio(turnos, indice) {
  return turnos.slice(Math.max(0, indice - 6), indice)
    .map((t) => ({ role: 'guest', text: t.texto }));
}

async function main() {
  const corpus = JSON.parse(fs.readFileSync(CORPUS, 'utf8'));
  const provider = new OpenAiProvider({
    apiKey: leerClaveOpenAi(),
    model: process.env.MODEL || 'gpt-5.6-luna',
    http: axios
  });
  const pms = new PmsPilotClient({
    http: axios, baseUrl: 'https://pms-lite-pilot.onrender.com',
    inboundUrl: '', secret: 'no-aplica-a-este-puente',
    conversationalToolsToken: fs.readFileSync(process.argv[2], 'utf8').trim()
  });

  const porConversacion = new Map();
  for (const t of corpus) {
    if (!porConversacion.has(t.conv)) porConversacion.set(t.conv, []);
    porConversacion.get(t.conv).push(t);
  }

  const resultados = [];
  let hechos = 0;

  for (const [conv, turnos] of porConversacion) {
    for (let i = 0; i < turnos.length; i += 1) {
      const t = turnos[i];
      const hoy = t.cuando.slice(0, 10);
      const contexto = contextoPrevio(turnos, i);
      const arranque = Date.now();

      const executor = createPmsToolExecutor({
        pmsClient: pms, context: { as_of: hoy }, logger: mudo
      });

      let r;
      try {
        r = await interpretConversationally({
          text: t.texto, today: hoy,
          transcript: transcriptoPrevio(turnos, i),
          commercialContext: contexto,
          language: contexto.language || null,
          pendingConfirmation: null, olderSummary: null, caseState: null
        }, { provider, executor, logger: mudo,
          flags: { shadowParser: true, semanticConfirmation: true } });
      } catch (error) {
        r = { ok: false, fallback: true, error_code: 'excepcion:' + String(error?.message || '').slice(0, 80),
          tool_trace: [], latency_ms: Date.now() - arranque };
      }

      const i2 = r.ok ? r.interpretation : null;
      resultados.push({
        conv, turno: t.turno, cuando: t.cuando, texto: t.texto,
        legacy: { check_in: t.l_check_in, status: t.l_status,
          nights: t.l_nights ? Number(t.l_nights) : null,
          guests: t.l_guests ? Number(t.l_guests) : null,
          apt: t.l_apt, lang: t.l_lang, accion: t.accion, fallback: t.fallback === 'true' },
        llm: i2 ? { check_in: i2.check_in, status: i2.check_in_status,
          nights: i2.nights, guests: i2.guests,
          apt: i2.requested_apartment_code, lang: i2.language,
          intent: i2.intent, knowledge_topics: i2.knowledge_topics,
          requests_human: i2.requests_human, exception_request: i2.exception_request,
          needs_clarification: i2.needs_clarification, missing: i2.missing_fields } : null,
        ok: Boolean(r.ok), error_code: r.error_code || null,
        ambiguity: r.v2?.ambiguity || null,
        unmapped: r.v2?.unmapped_meaning || null,
        confirmation: r.confirmation ? { triggers: r.confirmation.triggers, fields: r.confirmation.fields } : null,
        tools: (r.tool_trace || []).map((x) => ({ tool: x.tool, args: x.arguments, status: x.status, reason: x.reason })),
        usage: r.usage || null, latency_ms: r.latency_ms ?? (Date.now() - arranque),
        shadow: r.shadow?.discrepancies || null
      });

      hechos += 1;
      if (hechos % 20 === 0) console.log(`  ${hechos}/${corpus.length}`);
      fs.writeFileSync(SALIDA, JSON.stringify(resultados, null, 1));
    }
  }

  fs.writeFileSync(SALIDA, JSON.stringify(resultados, null, 1));
  console.log(`listo: ${resultados.length} turnos -> ${SALIDA}`);
}

main().catch((e) => { console.error('FALLO:', e.message); process.exit(1); });
