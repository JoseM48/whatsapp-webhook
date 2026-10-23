'use strict';

// CAMI LEE IMÁGENES (José Manuel, 2026-10-23; DECISIONES_LOG "Cami lee
// imágenes"). Caso: lead 246 (Nora) mandó 6+ pantallazos y Cami contestó seis
// veces "La imagen quedó guardada; no puedo leerla…".

const test = require('node:test');
const assert = require('node:assert/strict');
const { InboundImageReader, createImageBurst, prepararTurnoImagen, iniciarLectura, registrarEntrega, registrarTextoEnRafaga, textoConLecturas,
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
  const entrada = iniciarLectura({ reader, burst, phone: TEL, raw: MARCADOR_IMAGEN, adjunto: ADJ, begin: { leer_imagen: true } });
  const turno = await prepararTurnoImagen({ burst, phone: TEL, raw: MARCADOR_IMAGEN, caption: 'Este me gustó', entrada, logger: log });
  // Mismo modelo del webhook, imagen en base64 y salida estructurada.
  assert.equal(client.llamadas.length, 1);
  assert.equal(client.llamadas[0].model, 'claude-sonnet-5');
  const img = client.llamadas[0].messages[0].content.find((c) => c.type === 'image');
  assert.deepEqual(img.source, { type: 'base64', media_type: 'image/jpeg', data: 'AAAA' });
  assert.ok(client.llamadas[0].output_config?.format?.type === 'json_schema');
  assert.match(turno.text, /Texto que escribió con la imagen: Este me gustó/);
  assert.match(turno.text, /\[Lo que se lee en la imagen que envió el cliente\] Busca del 1 al 30 de noviembre para 2 personas/);
  assert.deepEqual(turno.lecturaImagen, { categoria: 'solicitud' });
  assert.equal(typeof turno.superadoPorRafaga, 'function');
  assert.equal(await turno.superadoPorRafaga(), false, 'sin mensaje posterior, su respuesta sale');
  // El log nunca lleva el texto leido.
  assert.ok(log.lineas.every((l) => !/noviembre|Loft|3\.500/.test(l)), log.lineas.join('\n'));
});

test('documento de identidad: no se procesa su contenido, no se guarda ningun numero y sigue el flujo de siempre', async () => {
  const log = logger();
  const client = clienteFalso([{ categoria: 'documento_identidad', lectura: 'Cédula 1032456789 de JUAN PEREZ' }]);
  const reader = new InboundImageReader({ client, model: 'claude-sonnet-5', logger: log });
  assert.deepEqual(await reader.leer(ADJ), { categoria: 'documento_identidad', lectura: null });
  const burst = createImageBurst();
  // Una lectura de venta anterior pendiente NO se mezcla con el documento.
  const previa = burst.registrarImagen(TEL, Promise.resolve({ categoria: 'solicitud', lectura: 'Del 1 al 15 de noviembre' }));
  const entrada = burst.registrarImagen(TEL, reader.leer(ADJ));
  const turno = await prepararTurnoImagen({ burst, phone: TEL, raw: MARCADOR_IMAGEN, entrada, logger: log });
  assert.equal(turno.text, MARCADOR_IMAGEN);
  assert.deepEqual(turno.lecturaImagen, { categoria: 'documento_identidad' });
  assert.equal(turno.superadoPorRafaga, null, 'el turno del documento nunca se descarta');
  // ...y el documento no deja sin respuesta a la imagen de venta anterior.
  assert.equal(await burst.haySiguienteQueLleva(TEL, previa), false);
  assert.ok(log.lineas.every((l) => !/1032456789|JUAN|PEREZ/i.test(l)));
  assert.match(client.llamadas[0].system, /documento_identidad[\s\S]*"lectura" MUST be null/);
});

test('saneo: se tachan telefonos, documentos y correos; se conservan fechas y precios', () => {
  for (const t of ['Llamar al 300 123 4567', 'cel 300-123-4567', '+57 3001234567', 'cc 1032456789', 'escribir a ana@correo.co']) {
    assert.doesNotMatch(sanearLectura(t), /\d{3}.?\d{3}.?\d{4}|\d{7,}|@/, t);
  }
  for (const t of ['15-11-2026', '15.11.2026', '2026-11-15 - 2026-12-15', '12.500.000', '2.800.000 - 3.300.000', 'Precio $3.300.000 al mes']) {
    assert.equal(sanearLectura(t), t);
  }
});

test('comprobante de pago: categoria sola, sin texto; el turno sigue con el marcador y nunca se descarta (Cartera como hoy)', async () => {
  const client = clienteFalso([{ categoria: 'comprobante_pago', lectura: 'Transferencia de $500.000 desde cuenta 123456789' }]);
  const reader = new InboundImageReader({ client, model: 'm', logger: logger() });
  const burst = createImageBurst();
  const entrada = iniciarLectura({ reader, burst, phone: TEL, raw: MARCADOR_IMAGEN, adjunto: ADJ, begin: { leer_imagen: true } });
  const turno = await prepararTurnoImagen({ burst, phone: TEL, raw: MARCADOR_IMAGEN, entrada });
  assert.equal(turno.text, MARCADOR_IMAGEN);
  assert.deepEqual(turno.lecturaImagen, { categoria: 'comprobante_pago' });
  assert.equal(turno.superadoPorRafaga, null);
  // Caso en pago (pending_payment, etc.): el PMS no pide leer -> ni siquiera se llama al modelo.
  const c2 = clienteFalso([{ categoria: 'solicitud', lectura: 'x' }]);
  const r2 = new InboundImageReader({ client: c2, model: 'm', logger: logger() });
  assert.equal(iniciarLectura({ reader: r2, burst, phone: TEL, raw: MARCADOR_IMAGEN, adjunto: ADJ, begin: { state: 'pending_payment' } }), null);
  assert.equal(c2.llamadas.length, 0);
});

test('flag apagado (el PMS no pide leer): comportamiento actual, sin llamada al modelo ni cambio de texto', async () => {
  const client = clienteFalso([{ categoria: 'solicitud', lectura: 'x' }]);
  const reader = new InboundImageReader({ client, model: 'm', logger: logger() });
  const burst = createImageBurst();
  for (const begin of [null, {}, { leer_imagen: false }]) {
    const entrada = iniciarLectura({ reader, burst, phone: TEL, raw: MARCADOR_IMAGEN, adjunto: ADJ, begin });
    assert.equal(entrada, null);
    const t = await prepararTurnoImagen({ burst, phone: TEL, raw: MARCADOR_IMAGEN, entrada });
    assert.deepEqual(t, { text: MARCADOR_IMAGEN, lecturaImagen: null, superadoPorRafaga: null, incluidas: [] });
  }
  // Un texto normal sin imagenes en la rafaga tampoco cambia (ni se registra).
  const et = registrarTextoEnRafaga({ burst, phone: TEL, raw: 'Hola, ¿tienen para noviembre?', begin: {}, claimed: true });
  assert.equal(et, null);
  assert.equal((await prepararTurnoImagen({ burst, phone: TEL, raw: 'Hola', entradaTexto: et })).text, 'Hola');
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

test('rafaga: varias imagenes seguidas (mismo segundo) -> el ultimo turno trae todas las lecturas, en paralelo', async () => {
  const lecturas = ['Del 1 al 30 de noviembre', 'Somos 3 personas', 'Anuncio "Loft 1109" en Booking'];
  const client = clienteFalso((body, i) => ({ categoria: 'solicitud', lectura: lecturas[i] }));
  const reader = new InboundImageReader({ client, model: 'm', logger: logger() });
  const burst = createImageBurst();
  // Como index.js: todas las lecturas arrancan al capturar el lote, en orden de llegada.
  const entradas = [0, 1, 2].map(() => iniciarLectura({ reader, burst, phone: TEL, raw: MARCADOR_IMAGEN, adjunto: ADJ, begin: { leer_imagen: true } }));
  const turnos = [];
  for (const [i, entrada] of entradas.entries()) {
    const t = await prepararTurnoImagen({ burst, phone: TEL, raw: MARCADOR_IMAGEN, entrada });
    turnos.push(t);
    // Los turnos 1 y 2 tienen un mensaje posterior que los lleva: quedan superados.
    assert.equal(await t.superadoPorRafaga(), i < 2);
    registrarEntrega(burst, t.incluidas, i < 2 ? [{ id: i, status: 'superseded', sent: false }, { id: 90 + i, status: 'submitted', sent: true }]
      : [{ id: i, status: 'submitted', sent: true }]);
  }
  assert.equal(client.llamadas.length, 3);
  assert.match(turnos[2].text, /\[Lo que se lee en las 3 imágenes que envió el cliente seguidas\]\n1\) Del 1 al 30 de noviembre\n2\) Somos 3 personas\n3\) Anuncio/);
  // Ya respondidas: un texto despues no las repite.
  const et = registrarTextoEnRafaga({ burst, phone: TEL, raw: 'Gracias por todo, ¿cuánto sería?', begin: {}, claimed: true });
  assert.equal((await prepararTurnoImagen({ burst, phone: TEL, raw: 'Gracias por todo, ¿cuánto sería?', entradaTexto: et })).text,
    'Gracias por todo, ¿cuánto sería?');
});

test('rafaga + texto o nota de voz: el texto que llega despues de imagenes sin responder las incluye y supera su respuesta', async () => {
  const burst = createImageBurst();
  const img = burst.registrarImagen(TEL, Promise.resolve({ categoria: 'solicitud', lectura: 'Del 1 al 30 de noviembre, 2 personas' }));
  const doc = burst.registrarImagen(TEL, Promise.resolve({ categoria: 'documento_identidad', lectura: null }));
  assert.equal(await burst.haySiguienteQueLleva(TEL, img), false, 'un documento no lleva lecturas');
  // "gracias" (sin contenido nuevo) no lleva lecturas: el PMS lo absorbe.
  assert.equal(registrarTextoEnRafaga({ burst, phone: TEL, raw: 'gracias', begin: { sin_contenido_nuevo: true }, claimed: true }), null);
  const et = registrarTextoEnRafaga({ burst, phone: TEL, raw: '¿Tienen disponible?', begin: {}, claimed: true });
  assert.ok(et);
  assert.equal(await burst.haySiguienteQueLleva(TEL, img), true);
  const t = await prepararTurnoImagen({ burst, phone: TEL, raw: '¿Tienen disponible?', entradaTexto: et });
  assert.equal(t.text, '¿Tienen disponible?\n[Lo que se lee en la imagen que envió el cliente] Del 1 al 30 de noviembre, 2 personas');
  assert.equal(t.lecturaImagen, null);
  assert.equal(t.superadoPorRafaga, null);
  assert.ok(t.incluidas.includes(img));
  assert.ok(doc);
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
  const burst = createImageBurst();
  const entradas = Object.keys(turnos).map(() => burst.registrarImagen(TEL, Promise.resolve({ categoria: 'solicitud', lectura: 'x' })));
  for (const [m, t] of Object.entries(turnos)) await dispatcher.beginCommercial({ phone: TEL, messageId: m, occurredAt: t.at, deliver: false });
  for (const [i, m] of Object.keys(turnos).entries()) {
    await dispatcher.completeCommercial({ externalMessageId: m, interpretation: {}, ai: {},
      lecturaImagen: { categoria: 'solicitud' }, superadoPorRafaga: () => burst.haySiguienteQueLleva(TEL, entradas[i]) });
  }
  assert.deepEqual(enviados, ['Respuesta 5']);
  assert.equal(completados.filter((c) => c.status === 'superseded').length, 5);
  // Al PMS solo viaja la categoria, nunca el texto leido.
  assert.deepEqual(procesados[0].lectura_imagen, { categoria: 'solicitud' });
  // Sin lectura (flag apagado), cada turno distinto sale como siempre.
  const otro = montar(turnos);
  for (const [m, t] of Object.entries(turnos)) await otro.dispatcher.beginCommercial({ phone: TEL, messageId: m, occurredAt: t.at, deliver: false });
  for (const m of Object.keys(turnos)) await otro.dispatcher.completeCommercial({ externalMessageId: m, interpretation: {}, ai: {} });
  assert.equal(otro.enviados.length, 6);
  assert.equal('lectura_imagen' in otro.procesados[0], false);
});

test('revision: una propuesta de imagen NO se descarta si lo siguiente es un documento de identidad o un comprobante', async () => {
  const turnos = {
    'w.pantallazo': { at: '2026-10-23T15:00:00Z', packet: paquete('PROPUESTA PRESENTADA', 'LF-510: COP 3.300.000 del 1 al 30 de noviembre') },
    'w.cedula': { at: '2026-10-23T15:00:01Z', packet: paquete('ARCHIVO RECIBIDO', 'Recibí tu imagen. Quedó guardada.') } };
  const { dispatcher, enviados } = montar(turnos);
  const burst = createImageBurst();
  const e1 = burst.registrarImagen(TEL, Promise.resolve({ categoria: 'solicitud', lectura: 'Del 1 al 30 de noviembre' }));
  burst.registrarImagen(TEL, Promise.resolve({ categoria: 'documento_identidad', lectura: null }));
  for (const [m, t] of Object.entries(turnos)) await dispatcher.beginCommercial({ phone: TEL, messageId: m, occurredAt: t.at, deliver: false });
  await dispatcher.completeCommercial({ externalMessageId: 'w.pantallazo', interpretation: {}, ai: {},
    lecturaImagen: { categoria: 'solicitud' }, superadoPorRafaga: () => burst.haySiguienteQueLleva(TEL, e1) });
  await dispatcher.completeCommercial({ externalMessageId: 'w.cedula', interpretation: {}, ai: {}, lecturaImagen: { categoria: 'documento_identidad' } });
  assert.deepEqual(enviados, ['LF-510: COP 3.300.000 del 1 al 30 de noviembre', 'Recibí tu imagen. Quedó guardada.']);
});

test('revision: un texto fijo aprobado nunca se descarta por la rafaga de imagenes', async () => {
  const turnos = { 'w.a': { at: '2026-10-23T15:00:00Z', packet: { ...paquete('PRE-CONFIRMACIÓN', 'Texto aprobado'), fixed_text: true } },
    'w.b': { at: '2026-10-23T15:00:01Z', packet: paquete('PROPUESTA PRESENTADA', 'Otra') } };
  const { dispatcher, enviados } = montar(turnos);
  for (const [m, t] of Object.entries(turnos)) await dispatcher.beginCommercial({ phone: TEL, messageId: m, occurredAt: t.at, deliver: false });
  await dispatcher.completeCommercial({ externalMessageId: 'w.a', interpretation: {}, ai: {}, superadoPorRafaga: async () => true });
  assert.deepEqual(enviados, ['Texto aprobado']);
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

// --- Revision final (2026-10-23): privacidad ------------------------------
test('privacidad: numeros largos con puntos o espacios se tachan; fechas y precios con $ se conservan', () => {
  for (const t of ['cc 1.032.456.789', 'tarjeta 1234 5678 9012', 'cuenta 0123 4567 89', 'doc 1 032 456 789']) {
    assert.match(sanearLectura(t), /\[número omitido\]/, t);
    assert.doesNotMatch(sanearLectura(t), /\d{3,}/, t);
  }
  for (const t of ['Precio $3.000.000 al mes', '$ 12.500.000 total', '15.11.2026', '15 11 2026', '2026-11-15 - 2026-12-15',
    'Del 1 al 30 de noviembre, 2 personas', '2.800.000 - 3.300.000']) {
    assert.equal(sanearLectura(t), t, t);
  }
});

test('privacidad: un nombre visto en una imagen nunca se toma como nombre del huesped (tampoco en el texto que arrastra lecturas)', async () => {
  const { createM0CommercialResponder } = require('../lib/pilot/m0-commercial-responder');
  const { turnoSinNombre } = require('../lib/pilot/inbound-image-reader');
  const burst = createImageBurst();
  burst.registrarImagen(TEL, Promise.resolve({ categoria: 'solicitud', lectura: 'Reserva de Laura Gómez del 1 al 30 de noviembre' }));
  const raw = 'Hola, ¿tienen disponible?';
  const et = registrarTextoEnRafaga({ burst, phone: TEL, raw, begin: {}, claimed: true });
  const turno = await prepararTurnoImagen({ burst, phone: TEL, raw, entradaTexto: et });
  assert.equal(turnoSinNombre(turno, raw), true, 'texto que arrastra lecturas');
  assert.equal(turnoSinNombre({ text: 'Soy Ana' }, 'Soy Ana'), false, 'un texto propio sin lecturas si toma nombre');
  const enviados = [];
  const responder = createM0CommercialResponder({
    capture: async () => ({}), pms: {}, logger: { info() {}, warn() {}, error() {} },
    ai: { async interpret() { return { intent: 'lodging_search', guest_name: 'Laura Gómez' }; } },
    closedPilot: { async completeCommercial(body) { enviados.push(body); return { deliveries: [] }; } }
  });
  await responder.processCaptured({ from: TEL, text: turno.text, messageId: 'w.1', today: '2026-10-23',
    sinNombreDeImagen: turnoSinNombre(turno, raw) });
  assert.equal('guest_name' in enviados[0].interpretation, false);
  await responder.processCaptured({ from: TEL, text: 'Soy Laura Gómez', messageId: 'w.2', today: '2026-10-23',
    sinNombreDeImagen: turnoSinNombre({ text: 'Soy Laura Gómez' }, 'Soy Laura Gómez') });
  assert.equal(enviados[1].interpretation.guest_name, 'Laura Gómez');
});
