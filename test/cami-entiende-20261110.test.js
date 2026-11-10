'use strict';

// CAMI ENTIENDE PRIMERO (José Manuel, 2026-11-10). Las tres reglas viven en los tres
// canales (dominio 25): chat y notas de voz por el redactor y el intérprete (y el PMS,
// supervised-pilot/cami-entiende.js), llamada por las instrucciones de voz.
//   1. intención primero (leads 359 y 334);
//   2. no confirmar un día que la persona no dijo; la última fecha manda (lead 357);
//   3. nunca la misma pregunta una tercera vez (lead 334).

const test = require('node:test');
const assert = require('node:assert/strict');
const { WRITER_SYSTEM_PROMPT, writerViewOfPacket } = require('../lib/pilot/llm/writer');
// El intérprete se lee como texto: cargarlo exige el SDK del proveedor.
const SYSTEM_PROMPT = require('node:fs').readFileSync(require('node:path').join(__dirname, '../lib/pilot/llm/conversational-engine.js'), 'utf8');
const { instruccionesCamiVoz, CAMI_ENTIENDE_VOZ } = require('../lib/voz/cami-voz');

test('chat y notas de voz: el redactor conoce ACLARAR INTENCIÓN, las fechas no dichas y la regla de la tercera pregunta', () => {
  assert.match(WRITER_SYSTEM_PROMPT, /UNDERSTAND FIRST/);
  assert.match(WRITER_SYSTEM_PROMPT, /"ACLARAR INTENCIÓN"/);
  assert.match(WRITER_SYSTEM_PROMPT, /do NOT ask for dates or number of people/);
  assert.match(WRITER_SYSTEM_PROMPT, /DATES YOU WERE NOT TOLD/);
  assert.match(WRITER_SYSTEM_PROMPT, /latest one is the one that counts/);
  assert.match(WRITER_SYSTEM_PROMPT, /NEVER THE SAME QUESTION A THIRD TIME/);
  assert.match(WRITER_SYSTEM_PROMPT, /"repeticion:"/);
});

test('el intérprete: con solo el mes la llegada es aproximada y la última corrección manda', () => {
  assert.match(SYSTEM_PROMPT, /only a month/);
  assert.match(SYSTEM_PROMPT, /the latest one wins/);
});

test('el redactor recibe la nota "repeticion:" y el nombre que manda el PMS', () => {
  const vista = writerViewOfPacket({ action: 'ACLARAR INTENCIÓN', notes: ['repeticion: ya hiciste esta misma pregunta dos veces'], guest_name: 'Astrid', first_contact: true });
  assert.equal(vista.action, 'ACLARAR INTENCIÓN');
  assert.deepEqual(vista.notes, ['repeticion: ya hiciste esta misma pregunta dos veces']);
  assert.equal(vista.guest.name, 'Astrid');
});

test('llamada: las mismas tres reglas en las instrucciones de voz', () => {
  assert.equal(CAMI_ENTIENDE_VOZ.length, 2);
  const comercial = instruccionesCamiVoz({ hoy: '2026-11-10' });
  assert.match(comercial, /PRIMERO ENTIENDE QUÉ NECESITA/);
  assert.match(comercial, /no supongas que busca alojamiento ni le pidas fechas/);
  // A un huésped de Airbnb o con una persona al mando no se le pregunta si busca dónde quedarse.
  assert.doesNotMatch(instruccionesCamiVoz({ hoy: '2026-11-10', huespedAirbnb: true }), /PRIMERO ENTIENDE/);
  for (const opciones of [{}, { huespedAirbnb: true }, { personaAlMando: true }]) {
    const ins = instruccionesCamiVoz({ hoy: '2026-11-10', ...opciones });
    assert.match(ins, /nunca propongas ni confirmes un día que la persona no dijo/);
    assert.match(ins, /usa la última que dijo/);
    assert.match(ins, /no lo preguntes una tercera vez igual/);
  }
});
