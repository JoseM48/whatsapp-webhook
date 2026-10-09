'use strict';

// LEAD 131 (2026-10-08 noche, caso M0-20261009-E8B65FA5). Secuencias reales:
//  1. "Hola, quiero consultar..." / "Por noche" / "Q, cuesta" / "El apartamento"
//     / "Porfavor" en 14 s: cada mensaje produjo la misma aclaracion. Las 4
//     primeras ya quedaron superadas (lead 115) y solo salio la ultima.
//  2. "Gracias" y "Bendiciones" (3 s): dos respuestas casi iguales de la lista
//     de espera ya avisada ("Con gusto, Elena... te las cotizo" / "Igualmente,
//     Elena... te las cotizo con gusto").
//  3. "Por favor" (cotiza) / "Cotizando" / "A ver q cuesta" / "Porfavlt" /
//     "Porfavor" en 15 s: propuesta, tres "Claro, Elena, cuando quieras..." y
//     "el valor no me aparece" (este ultimo se corrige en el PMS).

const test = require('node:test');
const assert = require('node:assert/strict');
const { createM0ClosedPilotDispatcher } = require('../lib/pilot/m0-closed-pilot');
const { WRITER_SYSTEM_PROMPT } = require('../lib/pilot/llm/writer.js');

const silencio = { info() {}, warn() {}, error() {} };
const guest = '573146892662', internal = '573006774425';
const config = { enabled: true, guestPhone: guest, internalPhone: internal, metaSignatureRequired: true,
  pmsM0Enabled: true, controlledIngressEnabled: true, pmsConfigured: true, receiptsEnabled: true,
  internalTemplateName: 'm0_internal_escalation_v1', internalTemplateLanguage: 'es_CO' };
const ACEPTA = { writer_provenance: true, superseded: true, superseded_reason: true };

function paquete(action, texto, extra = {}) {
  return { packet_version: 2, action, deterministic_text: texto, accepts: ACEPTA, numbers: [], dates: [], apartments: [],
    required_facts: [], facts: [], forbidden_claims: [], semantic_claims: [], ...extra };
}

// turnos: messageId -> { at, packet }. Cada turno produce una fila de outbox.
function montar(turnos, { fallaEnvio = () => false } = {}) {
  const enviados = [], completados = [];
  const ids = new Map(Object.keys(turnos).map((m, i) => [m, 100 + i]));
  const porOutbox = new Map([...ids].map(([m, id]) => [id, turnos[m].packet]));
  const pms = {
    async beginClosedPilotCommercial() { return { processing_claimed: true, outboxes: [] }; },
    async processClosedPilotCommercial({ external_message_id: m }) {
      return { outboxes: [{ id: ids.get(m) }], authorized_response_packet: turnos[m].packet };
    },
    async claimClosedPilotOutbound(id) {
      return { outbox_id: id, claimable: true, recipient_kind: 'guest', recipient_phone: guest,
        message_kind: 'text', message_text: porOutbox.get(id).deterministic_text };
    },
    async completeClosedPilotOutbound(body) { completados.push(body); }
  };
  const dispatcher = createM0ClosedPilotDispatcher({ config, pms, logger: silencio,
    async sendText(to, text) {
      if (fallaEnvio(text)) throw Object.assign(new Error('bad request'), { response: { status: 400 } });
      enviados.push(text); return `wamid.out${enviados.length}`;
    } });
  const llega = (m) => dispatcher.beginCommercial({ phone: guest, messageId: m, occurredAt: turnos[m].at, deliver: false });
  const responde = (m) => dispatcher.completeCommercial({ externalMessageId: m, interpretation: {}, ai: {} });
  return { dispatcher, enviados, completados, llega, responde, ids };
}

const ACLARACION = '¿Qué fecha de llegada tienes prevista?\n¿Qué fecha de salida o cuántas noches necesitas?\n¿Para cuántas personas sería?';

test('lead 131 (1): rafaga de 5 mensajes cortos -> la aclaracion sale UNA vez (la del ultimo)', async () => {
  const turnos = {
    'w.hola': { at: '2026-10-09T03:47:17Z' }, 'w.noche': { at: '2026-10-09T03:47:20Z' }, 'w.cuesta': { at: '2026-10-09T03:47:22Z' },
    'w.apto': { at: '2026-10-09T03:47:27Z' }, 'w.porfa': { at: '2026-10-09T03:47:31Z' } };
  for (const t of Object.values(turnos)) t.packet = paquete('CLARIFICAR SOLICITUD', ACLARACION, { supersedable: true });
  const { enviados, completados, llega, responde } = montar(turnos);
  for (const m of Object.keys(turnos)) await llega(m);
  for (const m of Object.keys(turnos)) await responde(m);
  assert.deepEqual(enviados, [ACLARACION]);
  assert.equal(completados.filter((c) => c.status === 'superseded').length, 4);
  assert.ok(completados.filter((c) => c.status === 'superseded').every((c) => c.superseded_reason === 'turno_siguiente'));
});

test('lead 131 (1b): si el huesped YA vio la pregunta y vuelve a escribir, la repregunta si sale (revision independiente)', async () => {
  const turnos = { 'w.a': { at: '2026-10-09T03:47:17Z' }, 'w.b': { at: '2026-10-09T03:47:40Z' } };
  for (const t of Object.values(turnos)) t.packet = paquete('CLARIFICAR SOLICITUD', ACLARACION);
  const { enviados, llega, responde } = montar(turnos);
  await llega('w.a'); await responde('w.a');
  await new Promise((r) => setTimeout(r, 5));
  await llega('w.b'); await responde('w.b');
  assert.deepEqual(enviados, [ACLARACION, ACLARACION]);
});

test('lead 131 (2): "Gracias" + "Bendiciones" -> una sola respuesta de la lista de espera ya avisada', async () => {
  const turnos = {
    'w.gracias': { at: '2026-10-09T03:49:36Z', packet: paquete('SIN DISPONIBILIDAD -- LISTA DE ESPERA',
      'Lo más pronto que puedo recibirte por 4 noches es del 12 de octubre al 16 de octubre. Si te sirve, dime y te lo cotizo.', { supersedable: true }) },
    'w.bendiciones': { at: '2026-10-09T03:49:39Z', packet: paquete('SIN DISPONIBILIDAD -- LISTA DE ESPERA',
      'Lo más pronto que puedo recibirte por 4 noches es del 12 de octubre al 16 de octubre. Si te sirve, dime y te lo cotizo.', { supersedable: true }) } };
  const { enviados, completados, llega, responde } = montar(turnos);
  await llega('w.gracias'); await llega('w.bendiciones');
  await responde('w.gracias'); await responde('w.bendiciones');
  assert.equal(enviados.length, 1);
  assert.deepEqual(completados[0], { outbox_id: 100, status: 'superseded', superseded_reason: 'turno_siguiente' });
});

test('lead 131 (2b): aunque el PMS no marque el turno, dos textos casi iguales seguidos no salen dos veces', async () => {
  const turnos = {
    'w.gracias': { at: '2026-10-09T03:49:36Z', packet: paquete('SIN DISPONIBILIDAD -- LISTA DE ESPERA',
      'Con gusto, Elena 😊 Si te sirven las fechas del 12 al 16 de octubre, te las cotizo.') },
    'w.bendiciones': { at: '2026-10-09T03:49:39Z', packet: paquete('SIN DISPONIBILIDAD -- LISTA DE ESPERA',
      'Igualmente, Elena 😊 Si te sirven las fechas del 12 al 16 de octubre, te las cotizo con gusto.') } };
  const { enviados, completados, llega, responde } = montar(turnos);
  // Como en produccion: los dos llegaron antes de que saliera la primera respuesta.
  await llega('w.gracias'); await llega('w.bendiciones');
  await responde('w.gracias'); await responde('w.bendiciones');
  assert.equal(enviados.length, 1);
  assert.deepEqual(completados.at(-1), { outbox_id: 101, status: 'superseded', superseded_reason: 'texto_repetido' });
});

test('lead 131 (3): propuesta + 4 mensajes cortos -> propuesta, precio y un solo recordatorio', async () => {
  const PROPUESTA = 'Esta es una de las opciones que tenemos del 12 de octubre al 16 de octubre para 2 personas:\nLF-510: COP 1.837.784 total, anticipo COP 426.696';
  const VIGENTE = 'Con gusto. Las opciones que te mostré para esas fechas siguen siendo las que tengo (LF-510). Si alguna te sirve, dime cuál y seguimos; también te resuelvo cualquier duda.';
  const PRECIO = 'Claro. El valor del 12 de octubre al 16 de octubre es:\nLF-510: COP 1.837.784 en total, anticipo COP 426.696\n\nSi te sirve, dime y seguimos.';
  const vigente = () => paquete('PROPUESTA VIGENTE', VIGENTE, { apartments: ['LF-510'], supersedable: true });
  const turnos = {
    'w.porfavor': { at: '2026-10-09T03:49:59Z', packet: paquete('PROPUESTA PRESENTADA', PROPUESTA, { apartments: ['LF-510'] }) },
    'w.cotizando': { at: '2026-10-09T03:50:02Z', packet: vigente() },
    'w.cuesta': { at: '2026-10-09T03:50:06Z', packet: paquete('PROPUESTA VIGENTE', PRECIO, { apartments: ['LF-510'],
      numbers: [{ id: 'LF-510.total', formatted: 'COP 1.837.784' }, { id: 'LF-510.deposit', formatted: 'COP 426.696' }] }) },
    'w.porfavlt': { at: '2026-10-09T03:50:09Z', packet: vigente() },
    'w.porfavor2': { at: '2026-10-09T03:50:14Z', packet: vigente() } };
  const { enviados, completados, llega, responde } = montar(turnos);
  for (const m of Object.keys(turnos)) await llega(m);
  // Orden real de salida en produccion: 1815, 1817, 1818, 1819, 1816.
  for (const m of ['w.porfavor', 'w.cotizando', 'w.porfavlt', 'w.porfavor2', 'w.cuesta']) await responde(m);
  assert.deepEqual(enviados, [PROPUESTA, VIGENTE, PRECIO]);
  assert.equal(completados.filter((c) => c.status === 'superseded').length, 2);
});

test('lead 131: lo que NO es repeticion sale siempre (otra cifra, otro texto, PMS anterior, envio fallido)', async () => {
  const a = 'LF-510: COP 1.837.784 en total del 12 al 16 de octubre. Si te sirve, dime y seguimos.';
  const b = 'LF-510: COP 1.937.784 en total del 13 al 17 de octubre. Si te sirve, dime y seguimos.';
  {
    const { enviados, llega, responde } = montar({ 'w.1': { at: '2026-10-09T03:50:00Z', packet: paquete('PROPUESTA PRESENTADA', a) },
      'w.2': { at: '2026-10-09T03:50:30Z', packet: paquete('PROPUESTA PRESENTADA', b) } });
    await llega('w.1'); await llega('w.2'); await responde('w.1'); await responde('w.2');
    assert.equal(enviados.length, 2, 'otra cifra no es repeticion');
  }
  {
    // Dos preguntas seguidas con respuestas parecidas pero con contenido distinto.
    const x = 'Sí, el LF-510 incluye parqueadero cubierto dentro del edificio, y recepción te asigna el espacio al llegar sin costo adicional.';
    const y = 'Sí, el LF-510 incluye lavadora cubierto dentro del edificio, y recepción te asigna el espacio al llegar sin costo adicional.';
    const { enviados, llega, responde } = montar({ 'w.1': { at: '2026-10-09T03:50:00Z', packet: paquete('RESPONDER INFORMACIÓN APROBADA', x) },
      'w.2': { at: '2026-10-09T03:50:03Z', packet: paquete('RESPONDER INFORMACIÓN APROBADA', y) } });
    await llega('w.1'); await llega('w.2'); await responde('w.1'); await responde('w.2');
    assert.equal(enviados.length, 2, 'contenido nuevo no es repeticion');
  }
  {
    // Texto fijo (aprobado palabra por palabra): no pasa por el filtro.
    const fijo = (t) => paquete('PRE-CONFIRMACIÓN', t, { fixed_text: true });
    const { enviados, llega, responde } = montar({ 'w.1': { at: '2026-10-09T03:50:00Z', packet: fijo(a) },
      'w.2': { at: '2026-10-09T03:50:03Z', packet: fijo(a) } });
    await llega('w.1'); await llega('w.2'); await responde('w.1'); await responde('w.2');
    assert.equal(enviados.length, 2);
  }
  {
    // PMS anterior (no acepta "superseded"): se envia como siempre.
    const viejo = (t) => ({ ...paquete('CLARIFICAR SOLICITUD', t), accepts: { writer_provenance: true } });
    const { enviados, llega, responde } = montar({ 'w.1': { at: '2026-10-09T03:50:00Z', packet: viejo(ACLARACION) },
      'w.2': { at: '2026-10-09T03:50:30Z', packet: viejo(ACLARACION) } });
    await llega('w.1'); await llega('w.2'); await responde('w.1'); await responde('w.2');
    assert.equal(enviados.length, 2);
  }
  {
    // PMS que acepta "superseded" pero no el motivo: no se le manda el campo.
    const sinMotivo = (t) => ({ ...paquete('SIN DISPONIBILIDAD -- LISTA DE ESPERA', t), accepts: { writer_provenance: true, superseded: true } });
    const { completados, llega, responde } = montar({ 'w.1': { at: '2026-10-09T03:50:00Z', packet: sinMotivo(ACLARACION) },
      'w.2': { at: '2026-10-09T03:50:30Z', packet: sinMotivo(ACLARACION) } });
    await llega('w.1'); await llega('w.2'); await responde('w.1'); await responde('w.2');
    assert.deepEqual(completados.at(-1), { outbox_id: 101, status: 'superseded' });
  }
  {
    // Un envio que Meta rechazo no cuenta como enviado: el reintento sale.
    let primera = true;
    const { enviados, completados, llega, responde } = montar({ 'w.1': { at: '2026-10-09T03:50:00Z', packet: paquete('PROPUESTA PRESENTADA', a) },
      'w.2': { at: '2026-10-09T03:50:30Z', packet: paquete('PROPUESTA PRESENTADA', a) } },
    { fallaEnvio: () => { if (primera) { primera = false; return true; } return false; } });
    await llega('w.1'); await llega('w.2'); await responde('w.1'); await responde('w.2');
    assert.equal(completados[0].status, 'failed');
    assert.deepEqual(enviados, [a]);
  }
});

test('lead 131: el redactor sabe que con cifras en PROPUESTA VIGENTE repite el precio y nunca dice que no lo tiene', () => {
  assert.match(WRITER_SYSTEM_PROMPT, /lead 131/);
  assert.match(WRITER_SYSTEM_PROMPT, /never say the price or value "no me aparece"/);
});
