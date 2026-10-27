'use strict';

// CLIENTES CORPORATIVOS Y FRECUENTES (José Manuel, 2026-10-27) y regla
// "HASTA = SALIDA" en extensiones (José Manuel, 2026-10-27). Paridad dominio 25:
// chat y notas de voz comparten intérprete y redactor; la llamada, cami-voz.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { writerViewOfPacket, WRITER_SYSTEM_PROMPT } = require('../lib/pilot/llm/writer');
const { SYSTEM_PROMPT } = require('../lib/pilot/llm/conversational-engine');
const { instruccionesCamiVoz, instruccionSaludo, PRESENTACION } = require('../lib/voz/cami-voz');

const SALUDO = '¡Hola, Daniela! Te damos la bienvenida nuevamente a Miu La Frontera.';

test('chat y notas de voz: el redactor recibe el saludo de regreso y la regla de no prometer descuentos', () => {
  const vista = writerViewOfPacket({ returning_guest: { name: 'Daniela', greeting: SALUDO }, required_facts: [] });
  assert.deepEqual(vista.returning_guest, { greeting: SALUDO });
  assert.equal(writerViewOfPacket({}).returning_guest, null);
  assert.match(WRITER_SYSTEM_PROMPT, /RETURNING GUEST/);
  assert.match(WRITER_SYSTEM_PROMPT, /trato_especial_consulta/);
});

test('llamada: cliente reconocido se saluda con la bienvenida, tarifas normales y pedir_persona para descuentos', () => {
  const reconocido = { tipo: 'corporativo', empresa: 'Quantum Data Systems', saludo: SALUDO };
  const ins = instruccionesCamiVoz({ hoy: '2026-10-27', clienteReconocido: reconocido });
  assert.match(ins, /cliente corporativo \(Quantum Data Systems\)/);
  assert.match(ins, /tarifas son las NORMALES/);
  assert.match(ins, /pedir_persona/);
  assert.ok(instruccionSaludo(null, reconocido).includes(SALUDO));
  assert.ok(instruccionSaludo(null, null).includes(PRESENTACION));
  // Con una persona al mando no se cotiza: no aplica el bloque comercial.
  assert.doesNotMatch(instruccionesCamiVoz({ hoy: '2026-10-27', clienteReconocido: reconocido, personaAlMando: true }), /tarifas son las NORMALES/);
  assert.doesNotMatch(instruccionesCamiVoz({ hoy: '2026-10-27' }), /cliente corporativo/);
});

test('"hasta X" en una extensión es la fecha de salida, en los tres canales', () => {
  assert.match(SYSTEM_PROMPT, /UNTIL = CHECK-OUT/); // intérprete v2 (chat y notas de voz)
  const ai = fs.readFileSync(path.join(__dirname, '../lib/pilot/ai.js'), 'utf8');
  assert.match(ai, /UNTIL = CHECK-OUT/); // intérprete de respaldo
  assert.match(instruccionesCamiVoz({ hoy: '2026-10-27' }), /"HASTA" ES LA SALIDA/); // llamada
});
