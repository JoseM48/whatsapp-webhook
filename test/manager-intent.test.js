'use strict';

// Gerente conversacional interno -- D1.2 V1.
//
// Lo que se prueba aqui no es que el modelo entienda bien: es que cuando NO
// entiende, o cuando pide algo que no toca, no pase nada. Y sobre todo, que
// no exista ninguna ruta por la que un comando inventado llegue al ejecutor.

const test = require('node:test');
const assert = require('node:assert/strict');
const { interpretManagerMessage, commandForAction,
  offerAvailableActions } = require('../lib/pilot/llm/manager-intent.js');

const silencio = { log() {}, warn() {}, error() {} };

const CONTEXTO_TOMADO = {
  actor: { actor_type: 'internal', active_role: 'gerente', display_name: 'José Manuel Gómez' },
  case: { case_key: 'M0-20260915-2A492795', state: 'proposal_presented', human_takeover_active: true },
  allowed_actions: [
    { id: 'reply_case', label: 'Responder al huésped', command: 'RESPONDER CASO M0-20260915-2A492795: <texto>', requires_text: true },
    { id: 'return_case', label: 'Devolver la conversación al bot', command: 'DEVOLVER CASO M0-20260915-2A492795', requires_text: false }
  ]
};

const CONTEXTO_LIBRE = {
  actor: { actor_type: 'internal', active_role: 'gerente' },
  case: { case_key: 'M0-20260915-2A492795', state: 'proposal_presented', human_takeover_active: false },
  allowed_actions: [
    { id: 'take_case', label: 'Tomar la conversación', command: 'TOMAR CASO M0-20260915-2A492795', requires_text: false }
  ]
};

const proveedorQueDevuelve = (output) => ({ structured: async () => ({ output }) });

test('elige una accion permitida y devuelve el comando REAL del PMS', async () => {
  const r = await interpretManagerMessage({ text: 'Lo tomo', context: CONTEXTO_LIBRE },
    { provider: proveedorQueDevuelve({ kind: 'action', action_id: 'take_case', reply_text: null,
      answer: 'Listo, lo tomas tú.', confidence: 0.95 }), logger: silencio });

  assert.equal(r.kind, 'action');
  assert.equal(commandForAction(r.action, null), 'TOMAR CASO M0-20260915-2A492795');
});

test('una accion que NO esta en la lista se rechaza, aunque el modelo la pida', async () => {
  // El caso no esta tomado: devolver no aplica todavia.
  const r = await interpretManagerMessage({ text: 'Devuélveselo a Cami', context: CONTEXTO_LIBRE },
    { provider: proveedorQueDevuelve({ kind: 'action', action_id: 'return_case', reply_text: null,
      answer: 'Lo devuelvo.', confidence: 0.99 }), logger: silencio });

  assert.equal(r.kind, 'unclear');
  assert.equal(r.rejected_reason, 'action_not_in_allowed_list');
  assert.equal(r.action, null);
});

// LA PROPIEDAD CENTRAL: no hay ruta por la que un comando inventado llegue al
// ejecutor. El modelo devuelve un id; el comando lo puso el PMS.
test('un id inventado no produce ningun comando', async () => {
  const r = await interpretManagerMessage({ text: 'Apruébalo y cóbrale', context: CONTEXTO_TOMADO },
    { provider: proveedorQueDevuelve({ kind: 'action', action_id: 'approve_payment', reply_text: null,
      answer: 'Aprobado.', confidence: 0.99 }), logger: silencio });

  assert.equal(r.kind, 'unclear');
  assert.equal(commandForAction(r.action, null), null);
});

test('una accion economica no existe en el contexto, asi que no hay nada que elegir', () => {
  const comandos = CONTEXTO_TOMADO.allowed_actions.map((a) => a.command).join(' ');
  for (const prohibido of ['APROBAR', 'RECHAZAR', 'CONCILIAR', 'PAGO', 'PRE-RESERVA']) {
    assert.ok(!comandos.includes(prohibido), `V1 no debe ofrecer ${prohibido}`);
  }
});

test('responder sin texto no ejecuta: pregunta que decir', async () => {
  const r = await interpretManagerMessage({ text: 'Respóndele', context: CONTEXTO_TOMADO },
    { provider: proveedorQueDevuelve({ kind: 'action', action_id: 'reply_case', reply_text: '   ',
      answer: 'Ya le respondo.', confidence: 0.9 }), logger: silencio });

  assert.equal(r.kind, 'unclear');
  assert.equal(r.rejected_reason, 'reply_text_missing');
});

test('el texto del gerente se inserta tal cual en el comando de responder', async () => {
  const r = await interpretManagerMessage({ text: 'Respóndele que estoy revisando', context: CONTEXTO_TOMADO },
    { provider: proveedorQueDevuelve({ kind: 'action', action_id: 'reply_case',
      reply_text: 'Hola, estoy revisando tu solicitud.', answer: 'Enviado.', confidence: 0.93 }), logger: silencio });

  assert.equal(commandForAction(r.action, r.reply_text),
    'RESPONDER CASO M0-20260915-2A492795: Hola, estoy revisando tu solicitud.');
});

test('poca confianza no ejecuta', async () => {
  const r = await interpretManagerMessage({ text: 'mmm no sé, mira eso', context: CONTEXTO_TOMADO },
    { provider: proveedorQueDevuelve({ kind: 'action', action_id: 'return_case', reply_text: null,
      answer: 'Lo devuelvo.', confidence: 0.3 }), logger: silencio });

  assert.equal(r.kind, 'unclear');
  assert.equal(r.rejected_reason, 'low_confidence');
});

test('una pregunta de lectura responde y no ejecuta nada', async () => {
  const r = await interpretManagerMessage({ text: '¿Qué pasó con este caso?', context: CONTEXTO_TOMADO },
    { provider: proveedorQueDevuelve({ kind: 'read', action_id: null, reply_text: null,
      answer: 'El huésped pidió hablar con una persona; está tomado por ti.', confidence: 0.9 }), logger: silencio });

  assert.equal(r.kind, 'read');
  assert.equal(r.action, null);
  assert.ok(r.answer.length > 0);
});

test('si el proveedor falla, no se ejecuta nada', async () => {
  const r = await interpretManagerMessage({ text: 'Tómalo', context: CONTEXTO_LIBRE },
    { provider: { structured: async () => { throw Object.assign(new Error('boom'), { code: 'timeout' }); } },
      logger: silencio });

  assert.equal(r.kind, 'unclear');
  assert.equal(r.action, null);
  assert.equal(r.rejected_reason, 'provider_error');
});

test('sin proveedor tampoco se ejecuta nada', async () => {
  const r = await interpretManagerMessage({ text: 'Tómalo', context: CONTEXTO_LIBRE }, { logger: silencio });
  assert.equal(r.kind, 'unclear');
  assert.equal(r.action, null);
});

test('cuando no se entiende, se ofrecen las acciones reales del contexto', () => {
  assert.equal(offerAvailableActions(CONTEXTO_LIBRE), 'Puedes: tomar la conversación.');
  assert.ok(offerAvailableActions(CONTEXTO_TOMADO).includes('devolver la conversación al bot'));
  assert.ok(offerAvailableActions({ allowed_actions: [] }).includes('no hay acciones disponibles'));
});

// EL PREDICADO QUE DECIDE SI LA RUTA SE ACTIVA.
//
// `status()` redacta `internal` a proposito, para no filtrar el numero por
// /health. Comparar contra el desde fuera daba siempre `undefined` y la ruta
// del gerente habria quedado muerta sin que nada fallara. Esta prueba fija el
// predicado explicito, y sobre todo que NO se active para un huesped.
test('isInternal distingue al interno del huesped', () => {
  const { createM0ClosedPilotDispatcher } = require('../lib/pilot/m0-closed-pilot.js');
  const dispatcher = createM0ClosedPilotDispatcher({
    config: { enabled: true, guestPhone: '573146892662', internalPhone: '573000000099',
      metaSignatureRequired: true, pmsM0Enabled: true, controlledIngressEnabled: true,
      pmsConfigured: true, receiptsEnabled: true,
      internalTemplateName: 'm0_internal_escalation_v1', internalTemplateLanguage: 'es_CO' },
    pms: {}, sendText: async () => ({}), logger: silencio
  });
  assert.equal(dispatcher.isInternal('573000000099'), true);
  assert.equal(dispatcher.isInternal('+57 300 000 0099'), true);
  assert.equal(dispatcher.isInternal('573146892662'), false, 'el huesped NUNCA entra por la ruta del gerente');
  assert.equal(dispatcher.isInternal(''), false);
});

// EL CAMINO VIEJO NO PUEDE ROMPERSE.
//
// La ruta del gerente solo se activa cuando el texto NO es ya un comando
// literal. Si esta deteccion fallara, escribir "TOMAR CASO X" pasaria por el
// modelo -- que podria elegir otra cosa, o no elegir nada -- y una capacidad
// determinista que hoy funciona quedaria a merced de una interpretacion.
test('un comando literal nunca entra por la ruta nueva', () => {
  const { isLiteralCommand } = require('../lib/pilot/llm/manager-intent.js');
  for (const literal of ['TOMAR CASO', 'DEVOLVER CASO M0-20260915-2A492795',
    'RESPONDER CASO M0-1: hola', 'ESTADO CASO', 'CASOS ACTIVOS', 'NUEVA PRUEBA',
    'tomar caso m0-1', '  Devolver Caso  ', 'APAGAR PILOTO', '3']) {
    assert.equal(isLiteralCommand(literal), true, `"${literal}" debe seguir por el camino de siempre`);
  }
});

test('el lenguaje natural NO se confunde con un comando literal', () => {
  const { isLiteralCommand } = require('../lib/pilot/llm/manager-intent.js');
  for (const natural of ['Lo tomo', '¿Qué pasó con este caso?', 'Respóndele que estoy revisando',
    'Devuélveselo a Cami', 'tomalo tu', 'quiero tomar caso de este huesped', '', '   ']) {
    assert.equal(isLiteralCommand(natural), false, `"${natural}" debe ir al gerente conversacional`);
  }
});
