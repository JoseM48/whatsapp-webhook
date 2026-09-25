'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveWrittenReply, buildWriterInput, writerViewOfPacket, WRITER_SYSTEM_PROMPT } = require('../lib/pilot/llm/writer.js');

// EL REDACTOR -- lo que protege: nunca un lazo abierto, nunca texto sin
// validar, y el determinista siempre como suelo.

const silencio = { info() {}, warn() {}, error() {} };

const paquete = {
  packet_version: 2, action: 'PROPUESTA PRESENTADA', deterministic_text: 'TEXTO DETERMINISTA',
  numbers: [{ id: 'LF-210.total', label: 'total LF-210', formatted: 'COP 3.900.000' }],
  dates: [{ id: 'check_in', formatted: '2026-10-15' }], apartments: ['LF-210'],
  required_facts: [{ id: 'no_real_money', statement: 'sin dinero real', patterns: ['sin dinero'] }],
  suggested_goals: [], facts: [], notes: ['ambiguo:arrival:x'], forbidden_claims: ['reserva_confirmada'],
  semantic_claims: [], ui: {}
};

function proveedorQueDevuelve(respuestas) {
  const cola = [...respuestas];
  const llamadas = [];
  return {
    model: 'modelo-de-prueba',
    async structured(req) { llamadas.push(req); const r = cola.shift(); if (r instanceof Error) throw r; return { output: { reply: r }, usage: { input_tokens: 1, output_tokens: 1 } }; },
    llamadas
  };
}

function pmsQueValida(veredictos) {
  const cola = [...veredictos];
  return { async validateAuthorizedResponse() { return cola.shift(); } };
}

test('un candidato valido sale tal cual, con una sola generacion', async () => {
  const provider = proveedorQueDevuelve(['Hola, tengo el LF-210 por COP 3.900.000 desde 2026-10-15, sin dinero real todavia.']);
  const out = await resolveWrittenReply({ packet: paquete, provider, pms: pmsQueValida([{ valid: true }]),
    guestText: 'hola', transcript: [], logger: silencio });
  assert.equal(out.presentation_source, 'llm_written');
  assert.equal(out.attempts, 1);
  assert.equal(provider.llamadas.length, 1);
});

test('un rechazo produce UNA regeneracion con el motivo, y si pasa, sale la segunda', async () => {
  const provider = proveedorQueDevuelve(['primer borrador', 'segundo borrador']);
  const out = await resolveWrittenReply({ packet: paquete, provider,
    pms: pmsQueValida([{ valid: false, failure_reasons: ['number_missing:LF-210.total'] }, { valid: true }]),
    guestText: 'hola', transcript: [], logger: silencio });
  assert.equal(out.presentation_source, 'llm_written');
  assert.equal(out.attempts, 2);
  assert.equal(out.text, 'segundo borrador');
  // La segunda llamada lleva el feedback del validador.
  assert.match(provider.llamadas[1].input, /number_missing:LF-210\.total/);
});

test('dos rechazos seguidos: texto determinista, y NUNCA una tercera generacion', async () => {
  const provider = proveedorQueDevuelve(['uno', 'dos', 'tres']);
  const out = await resolveWrittenReply({ packet: paquete, provider,
    pms: pmsQueValida([{ valid: false, failure_reasons: ['a'] }, { valid: false, failure_reasons: ['b'] }]),
    guestText: 'hola', transcript: [], logger: silencio });
  assert.equal(out.text, 'TEXTO DETERMINISTA');
  assert.equal(out.presentation_source, 'deterministic_after_rejection');
  assert.equal(provider.llamadas.length, 2);
});

test('si el proveedor falla, sale el determinista sin reintentar', async () => {
  const provider = proveedorQueDevuelve([Object.assign(new Error('caido'), { code: 'llm_timeout' })]);
  const out = await resolveWrittenReply({ packet: paquete, provider, pms: pmsQueValida([]),
    guestText: 'hola', transcript: [], logger: silencio });
  assert.equal(out.text, 'TEXTO DETERMINISTA');
  assert.equal(provider.llamadas.length, 1);
});

test('si el validador del PMS no responde, sale el determinista', async () => {
  const provider = proveedorQueDevuelve(['borrador']);
  const out = await resolveWrittenReply({ packet: paquete, provider,
    pms: { async validateAuthorizedResponse() { throw new Error('pms caido'); } },
    guestText: 'hola', transcript: [], logger: silencio });
  assert.equal(out.text, 'TEXTO DETERMINISTA');
});

test('sin paquete o sin proveedor no se genera nada', async () => {
  const provider = proveedorQueDevuelve(['x']);
  const a = await resolveWrittenReply({ packet: null, provider, pms: pmsQueValida([]), guestText: 'hola', logger: silencio });
  const b = await resolveWrittenReply({ packet: paquete, provider: null, pms: pmsQueValida([]), guestText: 'hola', logger: silencio });
  assert.equal(a.text, null);
  assert.equal(b.text, 'TEXTO DETERMINISTA');
  assert.equal(provider.llamadas.length, 0);
});

// Lo que el redactor VE: conversacion, interpretacion, paquete y mensaje --
// y lo que NO ve: el texto determinista (no debe copiarlo) ni fuentes internas.
test('el redactor recibe la conversacion, el mensaje y el paquete, pero no el texto determinista', () => {
  const input = buildWriterInput({ guestText: 'me quedo con el 210',
    transcript: [{ role: 'guest', text: 'hola' }, { role: 'cami', text: 'opciones...' }, { role: 'human', text: 'te recomiendo el 404' }],
    interpretation: { intent: 'lodging_search' }, packet: paquete, language: 'es', today: '2026-09-24' });
  assert.match(input, /"who":"guest","text":"hola"/);
  assert.match(input, /human_agent_jose_manuel/);
  assert.match(input, /me quedo con el 210/);
  assert.match(input, /COP 3\.900\.000/);
  assert.doesNotMatch(input, /TEXTO DETERMINISTA/);
  assert.deepEqual(Object.keys(writerViewOfPacket(paquete)).includes('deterministic_text'), false);
  assert.deepEqual(Object.keys(writerViewOfPacket(paquete)).includes('semantic_claims'), false);
});

test('el prompt fija la autoridad: solo el paquete es fuente de verdad y los numeros son exactos', () => {
  assert.match(WRITER_SYSTEM_PROMPT, /ONLY SOURCE OF TRUTH/);
  assert.match(WRITER_SYSTEM_PROMPT, /EXACTLY as given/);
  assert.match(WRITER_SYSTEM_PROMPT, /never guess/);
});
