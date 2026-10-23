'use strict';

// CAMI LEE IMÁGENES (José Manuel, 2026-10-23; DECISIONES_LOG "Cami lee
// imágenes"). Caso: lead 246 (Nora) mandó 6+ pantallazos y Cami contestó seis
// veces "La imagen quedó guardada; no puedo leerla…".

const test = require('node:test');
const assert = require('node:assert/strict');
const { InboundImageReader, createImageBurst, prepararTurnoImagen, iniciarLectura, registrarEntrega, textoConLecturas,
  sanearLectura, MARCADOR_IMAGEN } = require('../lib/pilot/inbound-image-reader');
const { createM0ClosedPilotDispatcher } = require('../lib/pilot/m0-closed-pilot');
const { createVozCallManager } = require('../lib/voz/call-manager');
const { avisoImagenEnChat, instruccionesCamiVoz } = require('../lib/voz/cami-voz');

const TEL = '573146892662';
const ADJ = { tipo: 'image', estado: 'guardado', mime_type: 'image/jpeg', contenido_base64: 'AAAA' };

function logger() {
  const lineas = [];
  const push = (nivel) => (msg, data) => lineas.push(`${nivel} ${msg} ${JSON.stringify(data ?? {})}`);
  return { lineas, info: push('info'), warn: push('warn'), error: push('error') };
}

// Doble del cliente de Anthropic: devuelve, por imagen, el JSON que daria el modelo.
function clienteFalso(respuestas) {
  const llamadas = [];
  let i = 0;
  return { llamadas, messages: { async create(body) {
    llamadas.push(body);
    const r = typeof respuestas === 'function' ? respuestas(body, i) : respuestas[Math.min(i, respuestas.length - 1)];
    i += 1;
    return { content: [{ type: 'text', text: JSON.stringify(r) }] };
  } } };
}

test('imagen de venta: el modelo multimodal la lee y el turno lleva lo que pide el cliente', async () => {
  const log = logger();
  const client = clienteFalso([{ categoria: 'solicitud', lectura: 'Busca del 1 al 30 de noviembre para 2 personas; vio en Airbnb el anuncio "Loft Poblado" a $3.500.000 al mes.' }]);
  const reader = new InboundImageReader({ client, model: 'claude-sonnet-5', logger: log });
  const burst = createImageBurst();
  const turno = await prepararTurnoImagen({ reader, burst, phone: TEL, raw: MARCADOR_IMAGEN, timestamp: '2026-10-23T15:00:00Z',
    adjunto: ADJ, caption: 'Este me gustó', begin: { leer_imagen: true }, logger: log });
  // Mismo modelo del webhook, imagen en base64 y salida estructurada.
  assert.equal(client.llamadas.length, 1);
  assert.equal(client.llamadas[0].model, 'claude-sonnet-5');
  const img = client.llamadas[0].messages[0].content.find((c) => c.type === 'image');
  assert.deepEqual(img.source, { type: 'base64', media_type: 'image/jpeg', data: 'AAAA' });
  assert.ok(client.llamadas[0].output_config?.format?.type === 'json_schema');
  assert.match(turno.text, /Texto que escribió con la imagen: Este me gustó/);
  assert.match(turno.text, /\[Lo que se lee en la imagen que envió el cliente\] Busca del 1 al 30 de noviembre para 2 personas/);
  assert.deepEqual(turno.lecturaImagen, { categoria: 'solicitud' });
  assert.equal(turno.superablePorImagen, true);
  // El log nunca lleva el texto leido.
  assert.ok(log.lineas.every((l) => !/noviembre|Loft|3\.500/.test(l)), log.lineas.join('\n'));
});

test('documento de identidad: no se procesa su contenido, no se guarda ningun numero y sigue el flujo de siempre', async () => {
  const log = logger();
  const client = clienteFalso([{ categoria: 'documento_identidad', lectura: 'Cédula 1032456789 de JUAN PEREZ' }]);
  const reader = new InboundImageReader({ client, model: 'claude-sonnet-5', logger: log });
  const leida = await reader.leer(ADJ);
  assert.deepEqual(leida, { categoria: 'documento_identidad', lectura: null });
  const burst = createImageBurst();
  const turno = await prepararTurnoImagen({ reader, burst, phone: TEL, raw: MARCADOR_IMAGEN, timestamp: '2026-10-23T15:00:00Z',
    adjunto: ADJ, begin: { leer_imagen: true }, logger: log });
  // El turno sigue con el marcador: el PMS responde como siempre (archivo guardado).
  assert.equal(turno.text, MARCADOR_IMAGEN);
  assert.deepEqual(turno.lecturaImagen, { categoria: 'documento_identidad' });
  assert.ok(log.lineas.every((l) => !/1032456789|JUAN|PEREZ/i.test(l)));
  assert.deepEqual(await burst.lecturasPendientes(TEL, '2026-10-23T15:00:00Z'), []);
  // Un documento nunca se mezcla con lecturas de venta pendientes de la rafaga.
  const burst2 = createImageBurst();
  burst2.registrar(TEL, '2026-10-23T14:59:58Z', Promise.resolve({ categoria: 'solicitud', lectura: 'Del 1 al 15 de noviembre' }));
  const t2 = await prepararTurnoImagen({ reader, burst: burst2, phone: TEL, raw: MARCADOR_IMAGEN, timestamp: '2026-10-23T15:00:00Z',
    adjunto: ADJ, begin: { leer_imagen: true }, logger: log });
  assert.equal(t2.text, MARCADOR_IMAGEN);
  // El instructivo del modelo exige lectura null y prohibe copiar datos.
  assert.match(client.llamadas[0].system, /documento_identidad[\s\S]*"lectura" MUST be null/);
  // Aunque el modelo copie numeros en una lectura de venta, se tachan.
  assert.equal(/\d{7,}/.test(sanearLectura('Llamar al 3001234567, cc 1032456789')), false);
  assert.equal(sanearLectura('Precio $3.300.000 al mes'), 'Precio $3.300.000 al mes');
});

test('comprobante de pago: categoria sola, sin texto; el turno sigue con el marcador (Cartera decide como hoy)', async () => {
  const client = clienteFalso([{ categoria: 'comprobante_pago', lectura: 'Transferencia de $500.000 desde cuenta 123456789' }]);
  const reader = new InboundImageReader({ client, model: 'm', logger: logger() });
  const turno = await prepararTurnoImagen({ reader, burst: createImageBurst(), phone: TEL, raw: MARCADOR_IMAGEN,
    timestamp: '2026-10-23T15:00:00Z', adjunto: ADJ, begin: { leer_imagen: true } });
  assert.equal(turno.text, MARCADOR_IMAGEN);
  assert.deepEqual(turno.lecturaImagen, { categoria: 'comprobante_pago' });
  // Caso en pago (pending_payment, etc.): el PMS no pide leer -> ni siquiera se llama al modelo.
  const c2 = clienteFalso([{ categoria: 'solicitud', lectura: 'x' }]);
  const t2 = await prepararTurnoImagen({ reader: new InboundImageReader({ client: c2, model: 'm', logger: logger() }),
    burst: createImageBurst(), phone: TEL, raw: MARCADOR_IMAGEN, timestamp: '2026-10-23T15:00:00Z', adjunto: ADJ,
    begin: { leer_imagen: false, state: 'pending_payment' } });
  assert.deepEqual(t2, { text: MARCADOR_IMAGEN, lecturaImagen: null, superablePorImagen: false });
  assert.equal(c2.llamadas.length, 0);
});

test('flag apagado (el PMS no pide leer): comportamiento actual, sin llamada al modelo ni cambio de texto', async () => {
  const client = clienteFalso([{ categoria: 'solicitud', lectura: 'x' }]);
  const reader = new InboundImageReader({ client, model: 'm', logger: logger() });
  const burst = createImageBurst();
  for (const begin of [null, {}, { leer_imagen: false }]) {
    assert.equal(iniciarLectura({ reader, burst, phone: TEL, raw: MARCADOR_IMAGEN, timestamp: '2026-10-23T15:00:00Z', adjunto: ADJ, begin }), null);
    const t = await prepararTurnoImagen({ reader, burst, phone: TEL, raw: MARCADOR_IMAGEN, timestamp: '2026-10-23T15:00:00Z', adjunto: ADJ, begin });
    assert.deepEqual(t, { text: MARCADOR_IMAGEN, lecturaImagen: null, superablePorImagen: false });
  }
  // Un texto normal sin imagenes en la rafaga tampoco cambia.
  const t = await prepararTurnoImagen({ reader, burst, phone: TEL, raw: 'Hola, ¿tienen para noviembre?', timestamp: '2026-10-23T15:00:05Z', begin: {} });
  assert.equal(t.text, 'Hola, ¿tienen para noviembre?');
  assert.equal(client.llamadas.length, 0);
  // Sin credencial / imagen no leible: no se llama al modelo.
  assert.equal((await new InboundImageReader({ client: null, model: 'm' }).leer(ADJ)).categoria, 'no_leida');
  assert.equal((await new InboundImageReader({ client, model: 'm' }).leer({ ...ADJ, mime_type: 'image/heic' })).categoria, 'no_leida');
  assert.equal((await new InboundImageReader({ client, model: 'm' }).leer({ ...ADJ, estado: 'no_descargado' })).categoria, 'no_leida');
  // Un fallo del modelo nunca rompe el turno.
  const roto = { messages: { async create() { throw Object.assign(new Error('boom'), { status: 529, type: 'overloaded_error' }); } } };
  assert.deepEqual(await new InboundImageReader({ client: roto, model: 'm', logger: logger() }).leer(ADJ),
    { categoria: 'no_leida', lectura: null, motivo: 'fallo' });
});

test('rafaga: varias imagenes seguidas -> el ultimo turno trae todas las lecturas (lectura en paralelo)', async () => {
  const lecturas = ['Del 1 al 30 de noviembre', 'Somos 3 personas', 'Anuncio "Loft 1109" en Booking'];
  const client = clienteFalso((body, i) => ({ categoria: 'solicitud', lectura: lecturas[i] }));
  const reader = new InboundImageReader({ client, model: 'm', logger: logger() });
  const burst = createImageBurst();
  const ats = ['2026-10-23T15:00:00Z', '2026-10-23T15:00:01Z', '2026-10-23T15:00:02Z'];
  // Como index.js: todas las lecturas arrancan al capturar el lote.
  const enCurso = ats.map((at) => iniciarLectura({ reader, burst, phone: TEL, raw: MARCADOR_IMAGEN, timestamp: at, adjunto: ADJ, begin: { leer_imagen: true } }));
  const turnos = [];
  for (const [i, at] of ats.entries()) {
    turnos.push(await prepararTurnoImagen({ reader, burst, phone: TEL, raw: MARCADOR_IMAGEN, timestamp: at, adjunto: ADJ,
      begin: { leer_imagen: true }, lecturaEnCurso: enCurso[i] }));
    // Los turnos 1 y 2 quedan superados en la entrega: no cuentan como respondidos.
    registrarEntrega(burst, TEL, at, i < 2 ? [{ id: i, status: 'superseded', sent: false }, { id: 90 + i, status: 'submitted', sent: true }]
      : [{ id: i, status: 'submitted', sent: true }]);
  }
  assert.equal(client.llamadas.length, 3);
  assert.match(turnos[2].text, /\[Lo que se lee en las 3 imágenes que envió el cliente seguidas\]\n1\) Del 1 al 30 de noviembre\n2\) Somos 3 personas\n3\) Anuncio/);
  assert.ok(turnos.every((t) => t.superablePorImagen === true));
  // Ya respondidas: un texto despues no las repite.
  const despues = await prepararTurnoImagen({ reader, burst, phone: TEL, raw: 'Gracias', timestamp: '2026-10-23T15:01:00Z', begin: {} });
  assert.equal(despues.text, 'Gracias');
});

test('rafaga + texto o nota de voz: el texto que llega despues de imagenes sin responder las incluye', async () => {
  const burst = createImageBurst();
  burst.registrar(TEL, '2026-10-23T15:00:00Z', Promise.resolve({ categoria: 'solicitud', lectura: 'Del 1 al 30 de noviembre, 2 personas' }));
  burst.registrar(TEL, '2026-10-23T15:00:01Z', Promise.resolve({ categoria: 'documento_identidad', lectura: null }));
  const t = await prepararTurnoImagen({ reader: new InboundImageReader({}), burst, phone: TEL, raw: '¿Tienen disponible?',
    timestamp: '2026-10-23T15:00:03Z', begin: {} });
  assert.equal(t.text, '¿Tienen disponible?\n[Lo que se lee en la imagen que envió el cliente] Del 1 al 30 de noviembre, 2 personas');
  assert.equal(t.lecturaImagen, null);
  assert.equal(t.superablePorImagen, false);
  assert.equal(textoConLecturas([]), '');
});

// --- Entrega: una sola respuesta por rafaga -------------------------------
const ACEPTA = { writer_provenance: true, superseded: true, superseded_reason: true };
const paquete = (action, texto) => ({ packet_version: 2, action, deterministic_text: texto, accepts: ACEPTA, numbers: [], dates: [],
  apartments: [], required_facts: [], facts: [], forbidden_claims: [], semantic_claims: [] });
const config = { enabled: true, guestPhone: TEL, internalPhone: '573006774425', metaSignatureRequired: true,
  pmsM0Enabled: true, controlledIngressEnabled: true, pmsConfigured: true, receiptsEnabled: true,
  internalTemplateName: 'm0_internal_escalation_v1', internalTemplateLanguage: 'es_CO' };

function montar(turnos) {
  const enviados = [], completados = [], procesados = [];
  const ids = new Map(Object.keys(turnos).map((m, i) => [m, 100 + i]));
  const porOutbox = new Map([...ids].map(([m, id]) => [id, turnos[m].packet]));
  const pms = {
    async beginClosedPilotCommercial() { return { processing_claimed: true, outboxes: [] }; },
    async processClosedPilotCommercial(body) {
      procesados.push(body);
      return { outboxes: [{ id: ids.get(body.external_message_id) }], authorized_response_packet: turnos[body.external_message_id].packet };
    },
    async claimClosedPilotOutbound(id) {
      return { outbox_id: id, claimable: true, recipient_kind: 'guest', recipient_phone: TEL, message_kind: 'text',
        message_text: porOutbox.get(id).deterministic_text };
    },
    async completeClosedPilotOutbound(body) { completados.push(body); }
  };
  const silencio = { info() {}, warn() {}, error() {} };
  const dispatcher = createM0ClosedPilotDispatcher({ config, pms, logger: silencio,
    async sendText(to, text) { enviados.push(text); return `wamid.out${enviados.length}`; } });
  return { dispatcher, enviados, completados, procesados };
}

test('rafaga de 6 imagenes de un lead en venta (lead 246) -> UNA sola respuesta, la del ultimo turno', async () => {
  const ats = [0, 1, 2, 3, 4, 5].map((s) => `2026-10-23T15:00:0${s}Z`);
  const turnos = Object.fromEntries(ats.map((at, i) => [`w.img${i}`, { at, packet: paquete('PROPUESTA PRESENTADA', `Respuesta ${i}`) }]));
  const { dispatcher, enviados, completados, procesados } = montar(turnos);
  for (const [m, t] of Object.entries(turnos)) await dispatcher.beginCommercial({ phone: TEL, messageId: m, occurredAt: t.at, deliver: false });
  for (const m of Object.keys(turnos)) {
    await dispatcher.completeCommercial({ externalMessageId: m, interpretation: {}, ai: {},
      lecturaImagen: { categoria: 'solicitud' }, superablePorImagen: true });
  }
  assert.deepEqual(enviados, ['Respuesta 5']);
  assert.equal(completados.filter((c) => c.status === 'superseded').length, 5);
  // Al PMS solo viaja la categoria, nunca el texto leido.
  assert.deepEqual(procesados[0].lectura_imagen, { categoria: 'solicitud' });
  // Sin la marca de imagen (flag apagado), cada turno distinto sale como siempre.
  const otro = montar(turnos);
  for (const [m, t] of Object.entries(turnos)) await otro.dispatcher.beginCommercial({ phone: TEL, messageId: m, occurredAt: t.at, deliver: false });
  for (const m of Object.keys(turnos)) await otro.dispatcher.completeCommercial({ externalMessageId: m, interpretation: {}, ai: {} });
  assert.equal(otro.enviados.length, 6);
  assert.equal('lectura_imagen' in otro.procesados[0], false);
});

// --- Paridad (dominio 25): llamada ----------------------------------------
test('paridad: si llega una imagen al chat durante una llamada, Cami de voz recibe el aviso (sin datos de documentos)', () => {
  const enviados = [];
  const manager = createVozCallManager({ config: { habilitada: true, duracionMaxMin: 10, costoUsdMinuto: 0.1 }, http: {}, WebSocketImpl: function () {},
    pms: {}, executePmsTool: async () => null, sendText: async () => null, logger: { info() {}, warn() {}, error() {} } });
  manager.activas.set('call_1', { telefono: `+${TEL}`, ws: { readyState: 1, send: (x) => enviados.push(JSON.parse(x)) } });
  assert.equal(manager.avisarImagenEnChat(TEL, { categoria: 'solicitud', lectura: 'Del 1 al 30 de noviembre, 2 personas' }), true);
  assert.equal(enviados[0].type, 'conversation.item.create');
  assert.equal(enviados[0].item.role, 'system');
  assert.match(enviados[0].item.content[0].text, /^AVISO DEL CHAT: .*Del 1 al 30 de noviembre/);
  // Ninguna respuesta forzada: Cami lo usa en su siguiente turno.
  assert.equal(enviados.some((e) => e.type === 'response.create'), false);
  assert.equal(manager.avisarImagenEnChat('573000000000', { categoria: 'solicitud', lectura: 'x' }), false);
  const doc = avisoImagenEnChat({ categoria: 'documento_identidad', lectura: 'CC 1032456789' });
  assert.equal(/1032456789/.test(doc), false);
  assert.match(doc, /no se leyó ni se guardó ningún dato/);
  assert.match(avisoImagenEnChat({ categoria: 'comprobante_pago' }), /administración/);
  assert.match(instruccionesCamiVoz({ hoy: '2026-10-23' }), /AVISOS DEL CHAT/);
});
