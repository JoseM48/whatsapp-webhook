'use strict';

// CLIENTE INDECISO (José Manuel, 2026-11-12; DECISIONES_LOG "Textos de pago en la ficha del
// edificio y cliente indeciso", punto 3). Paridad (dominio 25): el chat y las notas de voz
// reciben del PMS el hecho obligatorio "llegada_ejemplo" y el redactor sabe decirlo como
// ejemplo; la llamada tiene la misma regla en sus instrucciones.

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveWrittenReply } = require('../lib/pilot/llm/writer');
const voz = require('../lib/voz/cami-voz');

test('llamada: regla del cliente indeciso con ejemplo cotizado por la herramienta', () => {
  const t = voz.instruccionesCamiVoz({ hoy: '2026-11-12' });
  const texto = Array.isArray(t) ? t.join('\n') : String(t);
  assert.match(texto, /CLIENTE INDECISO/);
  assert.match(texto, /quote_stay un EJEMPLO llegando el 1 del mes/);
  assert.match(texto, /si esa fecha le sirve/);
  assert.match(texto, /Nunca un número que no venga de la herramienta/);
});

test('chat y notas de voz: el redactor recibe la excepción del ejemplo de llegada', async () => {
  const vistos = [];
  const provider = { model: 'falso', async structured({ system, input }) { vistos.push({ system, input });
    return { output: { reply: 'Por ejemplo, llegando el 1 de enero por 30 noches. ¿Te sirve esa fecha?', presented_codes: [], send_photos: [] }, usage: null }; } };
  const pms = { async validateAuthorizedResponse() { return { valid: true, failure_reasons: [] }; } };
  const packet = { packet_version: 2, action: 'PROPUESTA PRESENTADA', deterministic_text: 'x', numbers: [], dates: [], apartments: [], facts: [],
    required_facts: [{ id: 'llegada_ejemplo', text: 'Es un ejemplo con nuestro sistema: llegando el 1 de enero de 2027 por 30 noches. ¿Te sirve esa fecha o qué día prefieres?' }],
    notes: [], suggested_goals: [], forbidden_claims: [], semantic_claims: [], unit_context: [], building_facts: [], general_knowledge: [] };
  await resolveWrittenReply({ packet, provider, pms, guestText: 'dame un rango aproximado', transcript: [], today: '2026-11-12', logger: { info() {}, error() {} } });
  assert.ok(vistos.length >= 1);
  assert.match(vistos[0].system, /UNDECIDED GUEST/);
  assert.match(vistos[0].system, /llegada_ejemplo/);
});
