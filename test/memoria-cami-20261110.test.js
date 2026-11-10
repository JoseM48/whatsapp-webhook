'use strict';

// MEMORIA DE CAMI (José Manuel, 2026-11-10; DECISIONES_LOG "Memoria de Cami").
// Antes: el intérprete veía 6 turnos (tope 3.000 tokens, resumen 300) y el redactor 10.
// Ahora: hasta 40 mensajes de los últimos 7 días (los recorta el PMS), resumen de lo
// anterior y la ficha viva de la persona; la llamada recibe la misma ficha.
// También mide el costo por turno antes y después (tokens de entrada estimados).

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');

// El SDK del proveedor no está instalado en este entorno de pruebas: se simula.
const original = Module._resolveFilename;
Module._resolveFilename = function r(req, ...rest) { return req === '@anthropic-ai/sdk' ? req : original.call(this, req, ...rest); };
require.cache['@anthropic-ai/sdk'] = require.cache['@anthropic-ai/sdk'] || { id: '@anthropic-ai/sdk', filename: '@anthropic-ai/sdk', loaded: true, exports: class {} };
const { buildConversationContext, DEFAULTS, estimateTokens } = require('../lib/pilot/llm/context-builder');
const { buildWriterInput, WRITER_SYSTEM_PROMPT } = require('../lib/pilot/llm/writer');
const { SYSTEM_PROMPT } = require('../lib/pilot/llm/conversational-engine');
Module._resolveFilename = original;
const { instruccionesCamiVoz } = require('../lib/voz/cami-voz');

const ANTES = { windowTurns: 6, maxContextTokens: 3000, maxWindowTokens: 1500, maxSummaryTokens: 300 };

// Conversación realista de 40 mensajes (20 del huésped, 20 de Cami).
function conversacion(n = 40) {
  const t = [];
  for (let i = 0; i < n; i += 1) {
    t.push(i % 2 === 0
      ? { role: 'guest', text: `Mensaje ${i} del huésped: llego en enero, somos dos, trabajo desde casa y quiero saber si el edificio tiene gimnasio y parqueadero.`, at: `2026-11-0${1 + (i % 9)}T12:00:00Z` }
      : { role: 'cami', text: `Respuesta ${i} de Cami: claro, te cuento lo del edificio, el parqueadero y la zona; ¿qué día de enero llegarías y por cuántos meses?`, at: `2026-11-0${1 + (i % 9)}T12:01:00Z` });
  }
  return t;
}
const FICHA = {
  roles: ['huesped_anterior', 'huesped_que_cotizo'],
  busca: { intencion: 'lodging_search', llegada: '2027-01-15', salida: null, noches: 90, personas: 2, apartamento_pedido: null, preferencias: ['balcón'], requisitos: [] },
  cotizados: [{ apartamento: 'LF-210', llegada: '2027-01-15', salida: '2027-04-15', elegido: false }],
  prometido: ['Está en lista de espera: se le avisa si se libera algo.'],
  ya_preguntado: [{ pregunta: 'CLARIFICAR SOLICITUD|check_in', veces: 2 }],
  ya_respondido: ['parking', 'location'],
  historial: { estadias: [{ apartamento: 'LF-510', llegada_mes: '2024-03', noches: 30, canal: 'airbnb', momento: 'pasada' }], total_estadias: 1, pasadas: 1,
    apartamentos: ['LF-510'], tuvo_incidencia: false, viaje_de_negocios: false, corporativo: null },
};
const RESUMEN = { text: 'Antes de la ventana hubo 12 mensajes de la persona (del 2026-10-01 al 2026-10-20).', covers_turns: 12, generated_by: 'pms:resumen_antiguo' };

test('el intérprete ve los 40 mensajes, el resumen de lo anterior y la ficha viva', () => {
  const { context, meta } = buildConversationContext({ transcript: conversacion(), today: '2026-11-10', fichaViva: FICHA, olderSummary: RESUMEN });
  assert.equal(DEFAULTS.windowTurns, 40);
  assert.equal(context.recent_turns.length, 40);
  assert.equal(context.older_summary.text, RESUMEN.text);
  assert.deepEqual(context.person.roles, FICHA.roles);
  assert.equal(context.person.historial.apartamentos[0], 'LF-510');
  assert.equal(meta.over_budget, false);
});

test('known no duplica la ventana, la ficha ni el resumen (revisión P2-3)', () => {
  const { context } = buildConversationContext({ transcript: conversacion(), today: '2026-11-10',
    commercialContext: { guests: 2, transcript: conversacion(), ficha_viva: FICHA, older_summary: RESUMEN } });
  assert.equal(context.known.guests, 2);
  assert.equal(context.known.transcript, undefined);
  assert.equal(context.known.ficha_viva, undefined);
  assert.equal(context.known.older_summary, undefined);
});

test('el redactor no recibe identificadores ni el nombre de la empresa en la ficha', () => {
  const input = buildWriterInput({ guestText: 'hola', transcript: [], packet: {}, today: '2026-11-10',
    fichaViva: { ...FICHA, lead_id: 9, telefono: '573000000000', historial: { ...FICHA.historial, corporativo: { empresa: 'ACME SAS' } } } });
  assert.doesNotMatch(input, /ACME|573000000000|"lead_id"/);
});

test('la ficha nunca lleva teléfonos, ids ni nombres aunque vengan', () => {
  const { context } = buildConversationContext({ transcript: [], today: '2026-11-10', fichaViva: { ...FICHA, telefono: '573000000000', lead_id: 5, nombre: 'X' } });
  assert.equal(context.person.telefono, undefined);
  assert.equal(context.person.lead_id, undefined);
  assert.equal(context.person.nombre, undefined);
});

test('el redactor ve 40 turnos, el resumen y la ficha, marcada como contexto y no autorización', () => {
  const input = buildWriterInput({ guestText: 'hola', transcript: conversacion(), packet: { action: 'CLARIFICAR SOLICITUD' }, today: '2026-11-10', fichaViva: FICHA, olderSummary: RESUMEN });
  assert.match(input, /Mensaje 0 del huésped/);
  assert.match(input, /What the system knows about this person \(context, NOT authorization/);
  assert.match(input, /Earlier conversation \(summary from the system\)/);
  assert.match(WRITER_SYSTEM_PROMPT, /PERSON FILE/);
  assert.match(WRITER_SYSTEM_PROMPT, /Qué bueno tenerte de vuelta/);
  assert.match(WRITER_SYSTEM_PROMPT, /if the packet has returning_guest, its greeting is that welcome/);
  assert.match(SYSTEM_PROMPT, /PERSON FILE/);
});

test('llamada: la misma ficha en las instrucciones (paridad, dominio 25)', () => {
  const ins = instruccionesCamiVoz({ hoy: '2026-11-10', fichaViva: FICHA });
  assert.match(ins, /LO QUE YA SABEMOS DE ESTA PERSONA/);
  assert.match(ins, /Qué bueno tenerte de vuelta/);
  assert.match(ins, /el 210 del 2027-01-15 al 2027-04-15/);
  assert.doesNotMatch(ins, /LF-510/);
  assert.doesNotMatch(instruccionesCamiVoz({ hoy: '2026-11-10' }), /LO QUE YA SABEMOS/);
  // Una reserva próxima no es "ya se ha quedado" (revisión P2-6).
  const proxima = { historial: { ...FICHA.historial, pasadas: 0, total_estadias: 1 } };
  assert.doesNotMatch(instruccionesCamiVoz({ hoy: '2026-11-10', fichaViva: proxima }), /tenerte de vuelta/);
});

test('costo por turno: tokens de entrada estimados antes y después (se reporta)', () => {
  const t = conversacion();
  // Antes, `known` llevaba además la ventana de 10 turnos del PMS sin recortar (se suma aquí).
  const interpAntes = buildConversationContext({ transcript: t, today: '2026-11-10' }, ANTES).meta.estimated_tokens
    + estimateTokens(JSON.stringify(t.slice(-10)), 4);
  const interpDespues = buildConversationContext({ transcript: t, today: '2026-11-10', fichaViva: FICHA, olderSummary: RESUMEN }).meta.estimated_tokens;
  const sys = (s) => estimateTokens(s, 4);
  const escritorAntes = sys(buildWriterInput({ guestText: 'hola', transcript: t.slice(-10), packet: {}, today: '2026-11-10' }));
  const escritorDespues = sys(buildWriterInput({ guestText: 'hola', transcript: t, packet: {}, today: '2026-11-10', fichaViva: FICHA, olderSummary: RESUMEN }));
  const fijo = sys(SYSTEM_PROMPT) + sys(WRITER_SYSTEM_PROMPT);
  const antes = fijo + interpAntes + escritorAntes, despues = fijo + interpDespues + escritorDespues;
  console.log(`[costo-turno] 40 mensajes. Contexto del intérprete: ${interpAntes} -> ${interpDespues} tokens; entrada del redactor: ${escritorAntes} -> ${escritorDespues}; `
    + `con los dos prompts de sistema (${fijo}): ${antes} -> ${despues} tokens por turno (+${despues - antes}, x${(despues / antes).toFixed(2)}).`);
  assert.ok(interpDespues > interpAntes);
  assert.ok(interpDespues < 20000);
});
