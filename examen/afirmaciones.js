'use strict';

// AFIRMACIONES DEL EXAMEN DE CAMI (paquete 3 "se equivoca menos", José Manuel 2026-11-11).
// Cada caso del banco (banco-oro.json) declara lo que la respuesta DEBE y NO DEBE hacer.
// Reglas puras sobre el texto final que recibiría la persona. Sin IA.
//
// Comunes a todo caso de Cami (salvo que el caso las apague con false):
//   sin_cifras_inventadas  toda cifra de dinero sale del paquete del sistema o del mensaje de la persona
//   no_mecanica_interna    no habla de validadores, paquetes, JSON ni avisos automáticos
//   no_repite              no dice lo mismo que el último mensaje de Cami (anti-repeticion.js)
// Del caso:
//   responde, pregunta, espera, no_espera, idioma ('en'), contiene_alguno, contiene_alguno_2,
//   no_contiene, no_cotiza, periodo_claro

const { normalizar, ultimasDeCami, repiteAnterior } = require('../lib/pilot/anti-repeticion');

const n = (s) => normalizar(s);
const DINERO = /(?:\$|cop)\s?\d[\d.,]*|\b\d{1,3}(?:[.,]\d{3})+\b|\b\d+(?:[.,]\d+)?\s?(?:millones|millon|mil)\b/gi;
const PERIODO = /\b(al mes|mensual|mensuales|cada mes|por mes|mes a mes|en total|total de|por noche|la noche|por estadia|per month|monthly|in total|per night|a month)\b/;
const ESPERA = /\b(confirm|te respondo|te escribo|te escribimos|te responderemos|te respondemos|reviso|revisa|revisara|revisare|consulto|valido|lo valida|jose manuel|equipo|let me check|i ll check|i will check|get back|reply here)/;
const PROMESA_ESPERA = /(lo confirmo|te lo confirmo|te respondo en (unos|pocos) minutos|no (lo |la )?tengo confirmad|i ll (check|confirm)|i will (check|confirm)|reply here in a few|let me (check|confirm)|still need to confirm)/;
const CONCEPTO = /\b(deposito|anticipo|separa|separacion|confirmacion|recargo|cargo adicional|limpieza|mascota|incluye hasta|primer mes|wompi|deposit|advance|fee)\b/;
const MECANICA = /\b(validador|json|paquete|packet|aviso automatico|notificacion automatica|el sistema (me )?(dice|indica|marca))\b/;
const INGLES = /\b(the|you|your|is|are|and|for|with|we|our|this|that|can|will|not|of|to|it|i|have|here|in|a|yet|be|do|don)\b/g;

function cifrasDinero(texto) {
  // "$3.100.000", "COP 600.000", "1,500", "3 millones". Años y horas no son dinero.
  return [...String(texto || '').matchAll(DINERO)].map((m) => m[0].replace(/\D/g, ''))
    .filter((d) => d.length >= 3 && !/^20[2-3]\d$/.test(d));
}
function cifrasPermitidas(caso) {
  const fuente = `${JSON.stringify(caso.paquete || {})} ${caso.texto || ''}`;
  return new Set([...fuente.matchAll(/\d[\d.,]*\d|\d/g)].map((m) => m[0].replace(/\D/g, '')));
}

const REGLAS = {
  responde: (t) => ({ ok: Boolean(String(t).trim()), detalle: 'no hubo respuesta' }),
  // Pregunta o invita a responder con un ejemplo ("llego el __ y somos __").
  pregunta: (t) => ({ ok: /[?]|__/.test(t) || /\b(dime|cuentame|respondeme|responderme|escribeme|escribirme|por ejemplo|tell me|for example)\b/.test(n(t)), detalle: 'no pregunta ni invita a responder' }),
  espera: (t) => ({ ok: ESPERA.test(n(t)), detalle: 'no da mensaje de espera ni dice quién lo revisa' }),
  no_espera: (t) => ({ ok: !PROMESA_ESPERA.test(n(t)), detalle: 'promete confirmar algo que no hacía falta' }),
  idioma: (t, v) => ({ ok: v !== 'en' || (n(t).match(INGLES) || []).length >= 3, detalle: `no respondió en ${v}` }),
  contiene_alguno: (t, v) => ({ ok: v.some((x) => n(t).includes(n(x))), detalle: `falta alguna de: ${v.join(' | ')}` }),
  contiene_alguno_2: (t, v) => ({ ok: v.some((x) => n(t).includes(n(x))), detalle: `falta alguna de: ${v.join(' | ')}` }),
  no_contiene: (t, v) => { const s = v.filter((x) => n(t).includes(n(x))); return { ok: !s.length, detalle: `dice: ${s.join(' | ')}` }; },
  no_cotiza: (t) => { const c = cifrasDinero(t); return { ok: !c.length, detalle: `da cifras: ${c.join(', ')}` }; },
  // Cada cifra lleva al lado qué es: al mes, por noche, en total, o un concepto (depósito, anticipo...).
  periodo_claro: (t) => {
    const sueltas = [];
    for (const m of String(t).matchAll(DINERO)) {
      const d = m[0].replace(/\D/g, '');
      if (d.length < 3 || /^20[2-3]\d$/.test(d)) continue;
      const ventana = n(String(t).slice(Math.max(0, m.index - 60), m.index + m[0].length + 45));
      if (!PERIODO.test(ventana) && !CONCEPTO.test(ventana)) sueltas.push(m[0]);
    }
    return { ok: !sueltas.length, detalle: `valor sin decir si es al mes, por noche o en total: ${sueltas.join(', ')}` };
  },
  sin_cifras_inventadas: (t, v, caso) => {
    const permitidas = cifrasPermitidas(caso);
    const raras = cifrasDinero(t).filter((d) => !permitidas.has(d));
    return { ok: !raras.length, detalle: `cifras que no están en el paquete: ${raras.join(', ')}` };
  },
  no_mecanica_interna: (t) => ({ ok: !MECANICA.test(n(t)), detalle: 'habla de la mecánica interna' }),
  no_repite: (t, v, caso) => {
    const previa = ultimasDeCami(caso.antes || [], 1);
    return { ok: !String(t).trim() || !repiteAnterior(t, previa), detalle: 'repite casi igual el último mensaje de Cami' };
  }
};

const COMUNES = { sin_cifras_inventadas: true, no_mecanica_interna: true, no_repite: true };

/** Evalúa un texto contra las afirmaciones del caso. Devuelve [{afirmacion, ok, detalle}]. */
function evaluar(caso, texto) {
  const afirmaciones = { ...COMUNES, ...(caso.afirmaciones || {}) };
  const out = [];
  for (const [k, v] of Object.entries(afirmaciones)) {
    if (v === false || v == null) continue;
    const regla = REGLAS[k];
    if (!regla) { out.push({ afirmacion: k, ok: false, detalle: 'afirmación desconocida' }); continue; }
    const r = regla(String(texto || ''), v, caso);
    out.push({ afirmacion: k, ok: r.ok, ...(r.ok ? {} : { detalle: r.detalle }) });
  }
  return out;
}

module.exports = { evaluar, REGLAS, COMUNES, cifrasDinero };
