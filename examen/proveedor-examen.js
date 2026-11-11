'use strict';

// PROVEEDOR DEL EXAMEN: el mismo contrato que lib/pilot/llm/provider.js
// (structured({schema, system, input, ...}) -> {output, usage}), en dos modos:
//
//   grabado  responde con lo que el modelo contestó en una corrida en vivo anterior, buscado por
//            la huella (sha256) de system + input + schema. Sin red y sin costo: es el modo de la
//            compuerta antes de cada push. Si el prompt o el caso cambian, la huella cambia y el
//            caso sale "sin_grabacion": hay que correr en vivo y grabar (la compuerta no pasa).
//   vivo     llama al modelo real (OpenAiProvider de producción) con un TOPE DE GASTO: estima el
//            costo con los tokens de cada respuesta y, al llegar al tope, deja de llamar
//            (error "tope_gasto": el caso queda incompleto, nunca se gasta de más). Con grabar=true
//            guarda cada respuesta para el modo grabado.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Sin retornos de carro: un checkout de Windows (CRLF) da la misma huella que el de Linux (Render).
const sinCR = (x) => (typeof x === 'string' ? x.split(String.fromCharCode(13)).join('') : x);
const huella = ({ system, input, schema }) => crypto.createHash('sha256')
  .update(JSON.stringify({ system: sinCR(system), input: sinCR(input), schema })).digest('hex').slice(0, 24);

function error(code) { return Object.assign(new Error(code), { code }); }

function crearProveedorExamen({ modo, dirGrabaciones, proveedorReal = null, topeUsd = 5, precios = { entrada: 2.5, salida: 15 },
  grabar = false, modelo = null }) {
  const cache = new Map();
  const archivo = (caso) => path.join(dirGrabaciones, `${caso}.json`);
  const leer = (caso) => {
    if (!cache.has(caso)) {
      let d = {};
      try { d = JSON.parse(fs.readFileSync(archivo(caso), 'utf8')); } catch { d = {}; }
      cache.set(caso, d);
    }
    return cache.get(caso);
  };
  const estado = { caso: null, llamadas: 0, sinGrabacion: 0, tokensEntrada: 0, tokensSalida: 0, usd: 0, maxLlamada: 0.05, usadas: new Map() };
  const usdDe = (u) => ((Number(u?.input_tokens) || 0) * precios.entrada + (Number(u?.output_tokens) || 0) * precios.salida) / 1e6;

  return {
    name: modo === 'vivo' ? 'openai' : 'grabado',
    model: modelo || proveedorReal?.model || 'grabado',
    estado,
    empezarCaso(id) { estado.caso = id; },
    /** Grabaciones que ya no usa ningún caso: se borran al regrabar para que el repo no crezca. */
    guardar() {
      if (!grabar) return;
      fs.mkdirSync(dirGrabaciones, { recursive: true });
      for (const [caso, usadas] of estado.usadas) {
        const d = {};
        for (const [h, v] of usadas) d[h] = v;
        fs.writeFileSync(archivo(caso), `${JSON.stringify(d, null, 1)}\n`);
      }
    },
    /**
     * Validador del PMS (validateAuthorizedResponse). Con validadorReal (EXAMEN_PMS_DIR) se usa el
     * real y, al grabar, se guarda su veredicto; sin él (p. ej. en el modo grabado sin el PMS al
     * lado) se usa el veredicto grabado. Así una corrida grabada repite la misma secuencia.
     */
    async validar({ packet, candidate_text, presented_codes }, validadorReal) {
      const h = `v:${huella({ system: 'validador', input: JSON.stringify({ candidate_text, presented_codes: presented_codes || null }), schema: packet })}`;
      const caso = estado.caso || 'sin_caso';
      if (!estado.usadas.has(caso)) estado.usadas.set(caso, new Map());
      let v = null;
      if (validadorReal) v = validadorReal(packet, candidate_text, { presentedCodes: Array.isArray(presented_codes) ? presented_codes : null });
      else v = leer(caso)[h] || null;
      if (!v) { estado.sinGrabacion += 1; return { valid: false, failure_reasons: ['sin_grabacion_validador'] }; }
      const corto = { valid: Boolean(v.valid), failure_reasons: v.failure_reasons || [] };
      estado.usadas.get(caso).set(h, corto);
      return corto;
    },
    async structured({ schema, system, input, tools = [], timeoutMs }) {
      const h = huella({ system, input, schema });
      const caso = estado.caso || 'sin_caso';
      if (!estado.usadas.has(caso)) estado.usadas.set(caso, new Map());
      if (modo === 'grabado') {
        const g = leer(caso)[h];
        if (!g) { estado.sinGrabacion += 1; throw error('sin_grabacion'); }
        estado.llamadas += 1;
        estado.usadas.get(caso).set(h, g);
        return { output: g.output, tool_calls: [], usage: g.usage || null, meta: { grabado: true } };
      }
      if (!proveedorReal) throw error('sin_proveedor_real');
      // Se para ANTES de una llamada que, al costo de la llamada más cara hasta ahora, pasaría el tope.
      if (estado.usd + estado.maxLlamada >= topeUsd) throw error('tope_gasto');
      const r = await proveedorReal.structured({ schema, system, input, tools, timeoutMs });
      estado.llamadas += 1;
      estado.tokensEntrada += Number(r?.usage?.input_tokens) || 0;
      estado.tokensSalida += Number(r?.usage?.output_tokens) || 0;
      const usd = usdDe(r?.usage);
      estado.usd += usd;
      estado.maxLlamada = Math.max(estado.maxLlamada, usd);
      estado.usadas.get(caso).set(h, { output: r.output, usage: r.usage || null, model: proveedorReal.model || null });
      return r;
    }
  };
}

module.exports = { crearProveedorExamen, huella };
