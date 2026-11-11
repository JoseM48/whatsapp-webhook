#!/usr/bin/env node
'use strict';

// EXAMEN DE CAMI (paquete 3 "se equivoca menos"; GO de José Manuel 2026-11-11 al rediseño de
// comunicaciones; decisión 2026-11-10 "examen fijo con conversaciones reales antes de cada cambio").
//
// Corre cada caso del banco de oro (examen/banco-oro.json, conversaciones reales anonimizadas)
// por el mismo camino con el que Cami escribe en producción: resolveWrittenReply (redactor +
// validador del PMS + regeneración + anti-repetición) sobre el paquete que el PMS armó ese día.
// No envía nada a nadie: no hay WhatsApp ni PMS en este camino.
//
// Modos:
//   --modo grabado  (por defecto) respuestas del modelo grabadas: sin red ni costo. Compuerta.
//   --modo vivo     modelo real con tope de gasto (--tope-usd, por defecto 5). Con --grabar
//                   guarda las respuestas para el modo grabado.
//   --modo real     califica lo que Cami de verdad respondió en producción (línea base "antes").
// Otras opciones: --casos E5794,E5795  --grupo walter  --salida ruta.json  --version "texto"
// Variables: EXAMEN_PMS_DIR (checkout del PMS para usar su validador real), OPENAI_API_KEY o
// EXAMEN_ENV_FILE (archivo .env con la clave), EXAMEN_MODELO (por defecto el de producción:
// NEW_LLM_CONVERSATIONAL_MODEL o gpt-5.6-luna), EXAMEN_USD_MTOK_ENTRADA / _SALIDA (precios para el tope).
//
// Salida: resumen en consola, informe JSON y código de salida 1 si la compuerta no pasa:
// algún caso no pendiente falla, falta una grabación o la corrida quedó incompleta.

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { resolveWrittenReply } = require('../lib/pilot/llm/writer');
const { evaluar } = require('./afirmaciones');
const { crearProveedorExamen } = require('./proveedor-examen');

const AQUI = __dirname;
function args(argv) {
  const o = { modo: 'grabado', casos: null, grupo: null, topeUsd: Number(process.env.EXAMEN_TOPE_USD || 5), grabar: false, salida: null, version: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i], v = argv[i + 1];
    if (a === '--modo') { o.modo = v; i += 1; } else if (a === '--casos') { o.casos = v.split(',').map((s) => s.trim()).filter(Boolean); i += 1; }
    else if (a === '--grupo') { o.grupo = v; i += 1; } else if (a === '--tope-usd') { o.topeUsd = Number(v); i += 1; }
    else if (a === '--grabar') o.grabar = true; else if (a === '--salida') { o.salida = v; i += 1; } else if (a === '--version') { o.version = v; i += 1; }
  }
  if (!['grabado', 'vivo', 'real'].includes(o.modo)) throw new Error(`modo desconocido: ${o.modo}`);
  return o;
}

async function validadorDelPms() {
  const dir = process.env.EXAMEN_PMS_DIR;
  if (!dir) return null;
  const f = path.join(dir, 'src/modules/supervised-pilot/m0-response-validator.js');
  if (!fs.existsSync(f)) throw new Error(`EXAMEN_PMS_DIR sin validador: ${f}`);
  return (await import(pathToFileURL(f).href)).validateAuthorizedResponse;
}

function proveedorReal() {
  if (process.env.EXAMEN_ENV_FILE) require('dotenv').config({ path: process.env.EXAMEN_ENV_FILE, quiet: true });
  const { OpenAiProvider } = require('../lib/pilot/llm/provider');
  if (!process.env.OPENAI_API_KEY) throw new Error('falta OPENAI_API_KEY (o EXAMEN_ENV_FILE)');
  const axios = require('axios');
  return new OpenAiProvider({ apiKey: process.env.OPENAI_API_KEY, http: axios,
    model: process.env.EXAMEN_MODELO || process.env.NEW_LLM_CONVERSATIONAL_MODEL || 'gpt-5.6-luna' });
}

const silencioso = { info() {}, warn() {}, error() {} };

// Lo que el PMS agrega al paquete despues del turno (agregarConocimientoGeneral) y la BD no
// guarda: hechos del edificio, FAQ, direccion y oferta. Sale de la foto del banco.
function paqueteCompleto(caso, conocimiento) {
  const p = JSON.parse(JSON.stringify(caso.paquete || {}));
  if (!conocimiento || Number(p.packet_version) !== 2) return p;
  const k = caso.conocimiento || {};
  p.building_facts = [...new Set([...(p.building_facts || []), ...(conocimiento.building_facts || [])])];
  p.general_knowledge = [...(conocimiento.faq || [])];
  const dir = k.direccion === 'exacta' ? conocimiento.direccion?.exacta : conocimiento.direccion?.aproximada;
  if (dir) p.general_knowledge.push({ topic: 'address', text: dir });
  if (k.oferta && conocimiento.oferta && !(p.facts || []).some((f) => f?.topic === 'oferta_lanzamiento')) p.facts = [...(p.facts || []), conocimiento.oferta];
  if (!Array.isArray(p.direction_notes)) p.direction_notes = [];
  return p;
}

async function main() {
  const o = args(process.argv.slice(2));
  const banco = JSON.parse(fs.readFileSync(path.join(AQUI, 'banco-oro.json'), 'utf8'));
  let casos = banco.casos;
  const cadena = casos.filter((c) => c.capa !== 'cami');
  casos = casos.filter((c) => c.capa === 'cami');
  if (o.casos) casos = casos.filter((c) => o.casos.includes(c.id));
  if (o.grupo) casos = casos.filter((c) => String(c.grupo).includes(o.grupo));

  const validadorReal = o.modo === 'real' ? null : await validadorDelPms();
  // En vivo sin el validador real se gastaría en el modelo para nada: no hay veredictos grabados de prompts nuevos.
  if (o.modo === 'vivo' && !validadorReal) throw new Error('el modo vivo exige EXAMEN_PMS_DIR (validador real del PMS)');
  if (!casos.length) throw new Error('ningún caso coincide con --casos/--grupo');
  const prov = o.modo === 'real' ? null : crearProveedorExamen({
    modo: o.modo, dirGrabaciones: path.join(AQUI, 'grabaciones'), proveedorReal: o.modo === 'vivo' ? proveedorReal() : null, topeUsd: o.topeUsd,
    precios: { entrada: Number(process.env.EXAMEN_USD_MTOK_ENTRADA || 2.5), salida: Number(process.env.EXAMEN_USD_MTOK_SALIDA || 15) },
    grabar: o.modo === 'vivo' && o.grabar
  });
  const pms = prov ? { validateAuthorizedResponse: (body) => prov.validar(body, validadorReal) } : null;

  const resultados = [];
  for (const c of casos) {
    let texto = '', fuente = 'real', intentos = 0, motivos = [], sinGrabacion = false, errorCaso = null;
    if (o.modo === 'real') {
      texto = (c.real || []).join('\n\n');
      if (!texto.trim()) fuente = c.real_anulado ? 'real_anulado' : 'real_sin_texto';
    } else {
      prov.empezarCaso(c.id);
      const antes = prov.estado.sinGrabacion;
      try {
        const r = await resolveWrittenReply({ packet: paqueteCompleto(c, banco.conocimiento), provider: prov, pms, guestText: c.texto, transcript: c.antes,
          interpretation: c.interpretacion, language: c.interpretacion?.language || null, today: c.hoy, timeoutMs: 45000, logger: silencioso });
        texto = r.text || '';
        fuente = r.presentation_source; intentos = r.attempts; motivos = r.failure_reasons || [];
      } catch (e) { errorCaso = String(e?.code || e?.message || e).slice(0, 80); }
      sinGrabacion = prov.estado.sinGrabacion > antes;
      if (motivos.includes('tope_gasto')) errorCaso = 'tope_gasto';
    }
    const evaluacion = evaluar({ ...c, paquete: paqueteCompleto(c, banco.conocimiento) }, texto);
    const fallas = evaluacion.filter((x) => !x.ok);
    const estado = errorCaso ? 'error' : sinGrabacion ? 'sin_grabacion'
      // En produccion un turno sin texto suele ser una rafaga (otro turno respondio): solo cuenta
      // como falla cuando el caso exige respuesta (p. ej. la respuesta anulada del defecto 1.5).
      : (o.modo === 'real' && !texto.trim() && !c.afirmaciones?.responde) ? 'sin_texto'
        : fallas.length ? 'falla' : 'pasa';
    resultados.push({ id: c.id, grupo: c.grupo, estado, pendiente: c.pendiente || null, fuente, intentos, motivos_validador: motivos,
      fallas: fallas.map((f) => `${f.afirmacion}${f.detalle ? `: ${f.detalle}` : ''}`), texto, ...(errorCaso ? { error: errorCaso } : {}) });
  }
  if (prov) prov.guardar();

  const cuenta = (pred) => resultados.filter(pred).length;
  const evaluables = resultados.filter((r) => r.estado !== 'sin_texto');
  const noPend = evaluables.filter((r) => !r.pendiente);
  const resumen = {
    modo: o.modo, version: o.version, fecha: new Date().toISOString(), casos_cami: resultados.length, casos_cadena_fuera: cadena.length,
    evaluados: evaluables.length, pasan: cuenta((r) => r.estado === 'pasa'), fallan: cuenta((r) => r.estado === 'falla'),
    sin_texto_real: cuenta((r) => r.estado === 'sin_texto'), sin_grabacion: cuenta((r) => r.estado === 'sin_grabacion'), errores: cuenta((r) => r.estado === 'error'),
    puntaje: evaluables.length ? Math.round((1000 * cuenta((r) => r.estado === 'pasa')) / evaluables.length) / 10 : null,
    puntaje_sin_pendientes: noPend.length ? Math.round((1000 * noPend.filter((r) => r.estado === 'pasa').length) / noPend.length) / 10 : null,
    afirmaciones: (() => { const a = {}; for (const r of evaluables) for (const f of r.fallas) { const k = f.split(':')[0]; a[k] = (a[k] || 0) + 1; } return a; })(),
    validador: o.modo === 'real' ? 'no aplica' : validadorReal ? 'PMS real' : 'grabado',
    modelo: prov?.model || null,
    llamadas_modelo: prov?.estado.llamadas ?? 0,
    tokens: prov ? { entrada: prov.estado.tokensEntrada, salida: prov.estado.tokensSalida } : null,
    costo_estimado_usd: prov ? Math.round(prov.estado.usd * 10000) / 10000 : 0
  };
  const compuertaFalla = o.modo !== 'real' && resultados.some((r) => r.estado !== 'pasa' && !(r.estado === 'falla' && r.pendiente));
  resumen.compuerta = o.modo === 'real' ? 'no aplica' : compuertaFalla ? 'NO PASA' : 'PASA';

  const salida = o.salida || path.join(AQUI, 'out', `informe-${o.modo}.json`);
  fs.mkdirSync(path.dirname(salida), { recursive: true });
  fs.writeFileSync(salida, `${JSON.stringify({ resumen, resultados }, null, 1)}\n`);

  console.log(`Examen de Cami (${o.modo}) — ${resumen.pasan}/${resumen.evaluados} pasan (${resumen.puntaje} %); sin pendientes: ${resumen.puntaje_sin_pendientes} %`);
  for (const r of resultados.filter((x) => x.estado !== 'pasa' && x.estado !== 'sin_texto')) {
    console.log(`  ${r.estado.toUpperCase()}${r.pendiente ? ' (pendiente)' : ''} ${r.id} [${r.grupo}] ${r.fallas.join('; ') || r.error || ''}`);
  }
  console.log(`Fallas por afirmación: ${JSON.stringify(resumen.afirmaciones)}`);
  if (prov) console.log(`Modelo ${resumen.modelo}, validador ${resumen.validador}, ${resumen.llamadas_modelo} llamadas, costo estimado USD ${resumen.costo_estimado_usd}`);
  console.log(`Casos de la cadena (mini Teo / guardia) fuera de este examen: ${cadena.length} (los corre el examen del banco del PMS).`);
  console.log(`Compuerta: ${resumen.compuerta}. Informe: ${path.relative(process.cwd(), salida)}`);
  if (compuertaFalla) process.exitCode = 1;
}

main().catch((e) => { console.error('[examen] fallo:', e?.message || e); process.exitCode = 2; });
