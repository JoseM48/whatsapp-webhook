'use strict';

// CAMI DE VOZ DE TENGO (GO de José Manuel, 2026-10-30): las llamadas de WhatsApp
// al numero de TenGo Camello (el 7355) las contesta "Cami, de TenGo", con su
// guion y SIN las herramientas de Miu. Nada sale por el numero de Miu: los
// textos salen por sendTextTengo. Numeros e ids FALSOS, sin red.

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { readVozConfig } = require('../lib/voz/config');
const { parseOpenAiCallIncoming } = require('../lib/voz/call-events');
const { createVozCallManager } = require('../lib/voz/call-manager');
const { herramientasTenGoVoz, instruccionesCamiTenGoVoz, presentacionTenGo, nombreTenGo } = require('../lib/voz/cami-voz');
const { atenderTengoCamello } = require('../lib/pilot/numero-entrante');
const { extractMetaMessages } = require('../lib/pilot/meta-inbound');

const TENGO = '570000000222';
const QUIEN_LLAMA = '999000000007';
const TEXTO_PMS_TENGO = 'Te escribo desde TenGo Camello (texto fijo del PMS).';

class FakeWs extends EventEmitter {
  constructor(url, opts) { super(); this.url = url; this.opts = opts; this.readyState = 1; this.enviados = []; FakeWs.ultima = this; }
  send(t) { this.enviados.push(JSON.parse(t)); }
  close() { this.readyState = 3; this.emit('close'); }
}

function entradaTenGo(callId = 'rtc_tc_1', { to = TENGO } = {}) {
  return parseOpenAiCallIncoming({ type: 'realtime.call.incoming', data: { call_id: callId, sip_headers: [
    { name: 'From', value: `<sip:+${QUIEN_LLAMA}@sip.example>` },
    ...(to ? [{ name: 'To', value: `<sip:+${to}@sip.example>` }] : []),
    { name: 'X-WA-Meta-Wacid', value: 'wacid.TC' }] } });
}

function montar({ tengocamello = { habilitada: true, duracion_max_min: 12, nombre_saludo: 'Carmen', tipo: 'prospecto', id: 3, nuevo: true },
  uso = 0, pmsFalla = false, sinEmisorTengo = false, finTengo = { seguimiento_texto: TEXTO_PMS_TENGO },
  resumenJson = { resumen: 'Tiene una floristería.', alerta: null, alerta_motivo: null }, envExtra = {} } = {}) {
  const posts = [], textosMiu = [], textosTengo = [], pmsLlamadas = [], logs = [];
  const config = readVozConfig({ VOZ_LLAMADAS_HABILITADAS: 'true', VOZ_OPENAI_API_KEY: 'sk-test-no-real',
    TENGOCAMELLO_DISPLAY_PHONE_NUMBER: `+57 000 000 0222`, ...envExtra });
  const http = { post: async (url, body) => {
    posts.push({ url, body });
    if (url.endsWith('/chat/completions')) return { data: { choices: [{ message: { content: JSON.stringify(resumenJson) } }] } };
    return { data: {} };
  } };
  const pms = {
    vozInicio: async (b) => { pmsLlamadas.push(['inicio', b]); if (pmsFalla) throw new Error('down');
      return { deduplicated: false, llamada_id: 11, lead_id: null, uso_mes_usd: uso, ...(tengocamello ? { tengocamello } : {}) }; },
    vozEstado: async (b) => { pmsLlamadas.push(['estado', b]);
      return b.avisar_huesped ? { estado: b.estado, seguimiento_via: 'tengocamello', seguimiento_texto: TEXTO_PMS_TENGO } : { estado: b.estado }; },
    vozFin: async (b) => { pmsLlamadas.push(['fin', b]); return { ...(finTengo ? { tengocamello: finTengo } : {}) }; },
    vozAlerta: async (b) => { pmsLlamadas.push(['alerta', b]); return { aviso_encolado: true }; },
    vozSeguimientoDirecto: async (b) => { pmsLlamadas.push(['directo', b]); return {}; },
    vozUsoAceptable: async (b) => { pmsLlamadas.push(['uso_aceptable', b]);
      return { decision: b.decision, texto_para_decir: `TEXTO PMS ${b.decision}`, aviso_encolado: true }; },
    vozConsultaTeo: async (b) => { pmsLlamadas.push(['consulta_teo', b]); return { registrada: true }; },
    vozFotos: async (b) => { pmsLlamadas.push(['fotos', b]); return { via: 'outbox', codigos: [] }; },
  };
  const pendientes = [];
  const timers = { setTimeout: (fn, ms) => { pendientes.push({ fn, ms }); return pendientes.length; }, clearTimeout: () => {} };
  let t = Date.now();
  const manager = createVozCallManager({ config, http, WebSocketImpl: FakeWs, pms, timers, now: () => t,
    executePmsTool: async (name) => { pmsLlamadas.push(['tool_pms', name]); return { status: 'ok' }; },
    sendText: async (to, body) => { textosMiu.push({ to, body }); },
    sendImage: async () => {},
    sendTextTengo: sinEmisorTengo ? null : async (to, body) => { textosTengo.push({ to, body }); },
    logger: { info(msg, datos) { logs.push([msg, datos]); }, warn(msg, datos) { logs.push([msg, datos]); }, error(msg, datos) { logs.push([msg, datos]); } } });
  const de = (paso) => pmsLlamadas.filter((c) => c[0] === paso).map((c) => c[1]);
  const correr = (ms) => { for (const p of pendientes.filter((x) => x.ms === ms && !x.hecho)) { p.hecho = true; p.fn(); } };
  return { manager, config, posts, textosMiu, textosTengo, pmsLlamadas, logs, de, correr, pendientes, avanzar: (ms) => { t += ms; } };
}

const mensaje = (ws, e) => ws.emit('message', Buffer.from(JSON.stringify(e)));

// ------------------------------------------------------------------ admision
test('llamada al 7355 con TenGo habilitada: acepta con el guion de TenGo y solo sus 3 herramientas', async () => {
  const m = montar();
  await m.manager._interno.atender(entradaTenGo());
  assert.deepEqual(m.de('inicio')[0], { call_id: 'rtc_tc_1', telefono: QUIEN_LLAMA, wacid: 'wacid.TC',
    modelo: 'gpt-realtime-mini', costo_max_llamada_usd: 0.6, duracion_max_min: 10, numero: 'tengocamello' });
  const accept = m.posts.find((p) => p.url.endsWith('/realtime/calls/rtc_tc_1/accept'));
  assert.ok(accept, 'la llamada se acepta');
  assert.match(accept.body.instructions, /Cami, de TenGo/);
  assert.match(accept.body.instructions, /inteligencia artificial/);
  assert.doesNotMatch(accept.body.instructions, /Miu La Frontera: apartamentos amoblados/);
  assert.deepEqual(accept.body.tools.map((h) => h.name).sort(), ['evaluar_uso_aceptable', 'pedir_persona', 'terminar_llamada']);
  // Nada del PMS de Miu ni del Paquete Magia ni late check-out.
  for (const prohibida of ['check_availability', 'quote_stay', 'get_policy', 'consultar_al_equipo', 'ofrecer_paquete_magia',
    'solicitar_late_checkout', 'solicitar_early_checkin', 'enviar_opciones_al_chat', 'anotar_lista_espera']) {
    assert.equal(accept.body.tools.some((h) => h.name === prohibida), false, prohibida);
  }
  // Duracion: min(techo 30, politica del PMS).
  assert.equal(m.logs.find((l) => l[0] === '[voz] llamada_aceptada')[1].duracion_max_min, 12);
  // El log de entrada trae el diagnostico del ruteo, sin numeros.
  const entrante = m.logs.find((l) => l[0] === '[voz] llamada_entrante')[1];
  assert.equal(entrante.numero, 'tengocamello');
  assert.equal(entrante.destino_presente, true);
  assert.deepEqual(entrante.sip_header_names, ['from', 'to', 'x-wa-meta-wacid']);
  assert.equal(JSON.stringify(entrante).includes(TENGO), false, 'el log no lleva el numero');
  // Nunca sale nada por el numero de Miu.
  assert.deepEqual(m.textosMiu, []);
  // El saludo es el de TenGo.
  const ws = FakeWs.ultima;
  ws.emit('open');
  m.correr(1500);
  assert.match(ws.enviados[0].response.instructions, /Cami, de TenGo/);
  assert.match(ws.enviados[0].response.instructions, /Qué bueno que llamas a TenGo Camello/);
});

test('TenGo apagada en el PMS: rechaza y el texto sale DESDE el 7355 (nunca desde Miu)', async () => {
  const m = montar({ tengocamello: { habilitada: false, duracion_max_min: 12 } });
  await m.manager._interno.atender(entradaTenGo());
  assert.equal(m.posts.some((p) => p.url.endsWith('/realtime/calls/rtc_tc_1/reject')), true);
  assert.equal(m.posts.some((p) => p.url.endsWith('/accept')), false);
  assert.deepEqual(m.de('estado')[0], { call_id: 'rtc_tc_1', estado: 'rechazada', motivo: 'tengocamello_apagada', avisar_huesped: true });
  assert.deepEqual(m.textosTengo, [{ to: QUIEN_LLAMA, body: TEXTO_PMS_TENGO }]);
  assert.deepEqual(m.textosMiu, []);
  assert.deepEqual(m.de('directo'), [{ call_id: 'rtc_tc_1', enviado: true }]);
});

test('PMS caido en una llamada al 7355: rechaza SIN aviso (no se puede saber nada)', async () => {
  const m = montar({ pmsFalla: true });
  await m.manager._interno.atender(entradaTenGo());
  assert.equal(m.posts.length, 1);
  assert.match(m.posts[0].url, /\/realtime\/calls\/rtc_tc_1\/reject$/);
  assert.deepEqual(m.de('estado'), []);
  assert.deepEqual(m.textosTengo, []);
  assert.deepEqual(m.textosMiu, []);
});

test('PMS viejo (sin el bloque tengocamello): rechaza sin aviso, para no encolarlo por la cola de Miu', async () => {
  const m = montar({ tengocamello: null });
  await m.manager._interno.atender(entradaTenGo());
  assert.equal(m.posts.some((p) => p.url.endsWith('/reject')), true);
  assert.deepEqual(m.de('estado')[0], { call_id: 'rtc_tc_1', estado: 'rechazada', motivo: 'tengocamello_sin_contexto' });
  assert.deepEqual(m.textosTengo, []);
  assert.deepEqual(m.textosMiu, []);
});

test('tope mensual: la llamada al 7355 se rechaza con el texto del PMS por el 7355', async () => {
  const m = montar({ uso: 49.9 });
  await m.manager._interno.atender(entradaTenGo());
  assert.equal(m.posts.some((p) => p.url.endsWith('/accept')), false);
  assert.equal(m.de('estado')[0].motivo, 'tope_mensual');
  assert.deepEqual(m.textosTengo, [{ to: QUIEN_LLAMA, body: TEXTO_PMS_TENGO }]);
  assert.deepEqual(m.textosMiu, []);
});

test('sin emisor de TenGo configurado no se envia nada y se reporta enviado:false', async () => {
  const m = montar({ tengocamello: { habilitada: false }, sinEmisorTengo: true });
  await m.manager._interno.atender(entradaTenGo());
  assert.deepEqual(m.textosMiu, []);
  assert.deepEqual(m.de('directo'), [{ call_id: 'rtc_tc_1', enviado: false }]);
  assert.ok(m.logs.some((l) => l[0] === '[voz] tengocamello_sin_emisor'));
});

// --------------------------------------------------------------------- ciclo
test('fin de la llamada: resumen de TenGo, sin paso ni seguimiento de Miu, y el texto sale por el 7355', async () => {
  const m = montar();
  await m.manager._interno.atender(entradaTenGo());
  const ws = FakeWs.ultima;
  ws.emit('open');
  m.correr(1500);
  mensaje(ws, { type: 'conversation.item.input_audio_transcription.completed', transcript: 'Tengo una floristería en Envigado.' });
  m.avanzar(60_000);
  ws.close();
  await new Promise((r) => setTimeout(r, 20));
  const fin = m.de('fin')[0];
  assert.equal(fin.siguiente_paso, null);
  assert.equal(fin.enviar_seguimiento, false);
  assert.equal(fin.resumen, 'Tiene una floristería.');
  // El prompt del resumen es el de TenGo, no el de Miu.
  const resumen = m.posts.find((p) => p.url.endsWith('/chat/completions'));
  assert.match(resumen.body.messages[0].content, /TenGo Camello/);
  assert.doesNotMatch(resumen.body.messages[0].content, /apartamentos amoblados en Medellín/);
  assert.deepEqual(m.textosTengo, [{ to: QUIEN_LLAMA, body: TEXTO_PMS_TENGO }]);
  assert.deepEqual(m.textosMiu, []);
  assert.deepEqual(m.de('directo'), [{ call_id: 'rtc_tc_1', enviado: true }]);
  assert.equal(m.logs.find((l) => l[0] === '[voz] llamada_terminada')[1].seguimiento, 'tengocamello');
});

test('fin sin texto de seguimiento: no se envia nada ni se reporta', async () => {
  const m = montar({ finTengo: { seguimiento_texto: null } });
  await m.manager._interno.atender(entradaTenGo());
  const ws = FakeWs.ultima;
  ws.emit('open');
  mensaje(ws, { type: 'conversation.item.input_audio_transcription.completed', transcript: 'Hola.' });
  ws.close();
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(m.textosTengo, []);
  assert.deepEqual(m.de('directo'), []);
});

test('en una llamada de TenGo una herramienta de Miu se rechaza por codigo', async () => {
  const m = montar();
  await m.manager._interno.atender(entradaTenGo());
  const ws = FakeWs.ultima;
  ws.emit('open');
  mensaje(ws, { type: 'response.done', response: { status: 'completed', output: [
    { type: 'function_call', call_id: 'c1', name: 'quote_stay', arguments: '{"arrival_date":"2026-11-10","nights":3}' },
    { type: 'function_call', call_id: 'c2', name: 'evaluar_uso_aceptable', arguments: '{"decision":"restringido","categoria":"quimicos_controlados"}' }] } });
  await new Promise((r) => setTimeout(r, 20));
  const salidas = ws.enviados.filter((e) => e.type === 'conversation.item.create').map((e) => JSON.parse(e.item.output));
  assert.equal(salidas[0].status, 'not_authorized');
  assert.equal(salidas[0].reason, 'herramienta_no_disponible');
  assert.deepEqual(m.de('tool_pms'), [], 'el PMS de Miu no se toca');
  // Uso aceptable si funciona (paridad, dominio 25).
  assert.equal(salidas[1].data.decision, 'restringido');
  assert.equal(m.de('uso_aceptable').length, 1);
});

test('aviso de imagen del chat: no aplica a una llamada de TenGo (las imagenes llegan a otro numero)', async () => {
  const m = montar();
  await m.manager._interno.atender(entradaTenGo());
  FakeWs.ultima.emit('open');
  assert.equal(m.manager.avisarImagenEnChat(QUIEN_LLAMA, { categoria: 'solicitud', lectura: 'x' }), false);
});

test('una llamada a Miu sigue igual: su guion, sus herramientas y el campo numero no se manda', async () => {
  const m = montar();
  await m.manager._interno.atender(entradaTenGo('rtc_miu_1', { to: null }));
  const inicio = m.de('inicio')[0];
  assert.equal('numero' in inicio, false);
  const accept = m.posts.find((p) => p.url.endsWith('/realtime/calls/rtc_miu_1/accept'));
  assert.match(accept.body.instructions, /Miu La Frontera/);
  assert.equal(accept.body.tools.some((h) => h.name === 'quote_stay'), true);
  const entrante = m.logs.find((l) => l[0] === '[voz] llamada_entrante')[1];
  assert.equal(entrante.numero, 'miu');
  assert.equal(entrante.destino_presente, false);
});

// --------------------------------------------------------------------- guion
test('guion de TenGo: categoria, promesa, precios publicos y lo que nunca promete', () => {
  const t = instruccionesCamiTenGoVoz({ hoy: '2026-10-30', nombre: 'Carmen', duracionMaxMin: 12 });
  assert.match(t, /se crea y se maneja hablando/);
  assert.match(t, /Nosotros vendemos por ti y gestionamos tu negocio/);
  assert.match(t, /Miu La Frontera/, 'el caso real se menciona');
  assert.match(t, /49\.900/);
  assert.match(t, /150\.000/);
  assert.match(t, /99\.000/);
  assert.match(t, /NUNCA prometas ingresos/);
  assert.match(t, /USO ACEPTABLE/);
  assert.match(t, /no cotizas alojamiento de Miu La Frontera/i);
  assert.match(t, /12 minutos/);
  assert.match(t, /La persona se llama Carmen/);
  assert.match(t, /se transcribe/);
  // La marca de TenGo no es un nombre de persona.
  assert.equal(nombreTenGo('TenGo Camello'), null);
  assert.equal(nombreTenGo('Miu'), null);
  assert.equal(nombreTenGo('Carmen'), 'Carmen');
  assert.doesNotMatch(instruccionesCamiTenGoVoz({ hoy: '2026-10-30', nombre: 'TenGo Camello' }), /La persona se llama/);
  assert.match(presentacionTenGo('Carmen'), /^¡Hola, Carmen!/);
  assert.deepEqual(herramientasTenGoVoz().map((h) => h.name).sort(), ['evaluar_uso_aceptable', 'pedir_persona', 'terminar_llamada']);
});

// ------------------------------------------------- notas de voz al 7355 (chat)
function cambioAudio(mediaId = 'media.1', { from = '573000000901' } = {}) {
  return { field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: '200000000000002' },
    contacts: [{ wa_id: from, profile: { name: 'Prueba' } }],
    messages: [{ from, id: 'wamid.a1', timestamp: '1761600000', type: 'audio', audio: { id: mediaId, mime_type: 'audio/ogg' } }] } };
}

test('nota de voz al 7355: se transcribe antes de reenviarla al PMS', async () => {
  const cuerpos = [];
  const r = await atenderTengoCamello([cambioAudio()], { pms: { postUrl: async (url, body) => { cuerpos.push(body); return { responder: false }; } },
    pmsBaseUrl: 'https://pms.example', enviarTexto: async () => {}, extractMetaMessages,
    transcribirAudio: async (mediaId) => `transcrito de ${mediaId}`, logger: { info() {}, warn() {}, error() {} } });
  assert.equal(r.mensajes, 1);
  assert.equal(cuerpos[0].text, 'transcrito de media.1');
  assert.equal(cuerpos[0].message_type, 'audio');
});

test('si el transcriptor falla, el mensaje igual llega al PMS con texto vacio', async () => {
  const cuerpos = [], errores = [];
  await atenderTengoCamello([cambioAudio()], { pms: { postUrl: async (url, body) => { cuerpos.push(body); return { responder: false }; } },
    pmsBaseUrl: 'https://pms.example', enviarTexto: async () => {}, extractMetaMessages,
    transcribirAudio: async () => { throw Object.assign(new Error('x'), { code: 'ECONNABORTED' }); },
    logger: { info() {}, warn() {}, error: (msg, d) => errores.push([msg, d]) } });
  assert.equal(cuerpos[0].text, '');
  assert.ok(errores.some((e) => e[0] === '[tengocamello] audio_transcripcion_fallo'));
  assert.equal(JSON.stringify(errores).includes('transcrito'), false, 'el log no lleva texto');
});

test('sin transcriptor (o con texto) el cuerpo al PMS no cambia', async () => {
  const cuerpos = [];
  await atenderTengoCamello([cambioAudio()], { pms: { postUrl: async (url, body) => { cuerpos.push(body); return { responder: false }; } },
    pmsBaseUrl: 'https://pms.example', enviarTexto: async () => {}, extractMetaMessages, logger: { info() {}, warn() {}, error() {} } });
  assert.equal(cuerpos[0].text, '');
  assert.equal(cuerpos[0].message_type, 'audio');
});

// RED DE SEGURIDAD (2026-10-30): una llamada sobre TenGo que entre por el camino
// de Miu no se trata como huésped y se manda al chat del 7355.
test('Cami de Miu por voz sabe atender a quien llama por TenGo Camello', () => {
  const { instruccionesCamiVoz, TENGO_EN_MIU_VOZ } = require('../lib/voz/cami-voz');
  const texto = instruccionesCamiVoz({ hoy: '2026-10-30' });
  assert.ok(texto.includes(TENGO_EN_MIU_VOZ));
  assert.match(TENGO_EN_MIU_VOZ, /305 453 7355/);
  assert.match(TENGO_EN_MIU_VOZ, /No prometas ingresos/);
  // Un huésped que vio un anuncio de Miu sigue siendo huésped (revisión 2026-10-30).
  assert.match(TENGO_EN_MIU_VOZ, /vio un anuncio o un video NO basta/);
  assert.match(TENGO_EN_MIU_VOZ, /si busca alojamiento sigue como Cami de Miu/);
  assert.ok(!instruccionesCamiVoz({ hoy: '2026-10-30', paqueteMagia: true }).includes(TENGO_EN_MIU_VOZ));
});

// RUTEO POR phone_number_id (llamada de prueba real, 2026-10-30): el To traía un
// número que no coincidía con el publicado; Meta manda x-wa-meta-phone-number-id
// con el id del número llamado, y ese manda.
function entradaConId(callId, id, to = '570000000999') {
  return parseOpenAiCallIncoming({ type: 'realtime.call.incoming', data: { call_id: callId, sip_headers: [
    { name: 'From', value: `<sip:+${QUIEN_LLAMA}@sip.example>` },
    { name: 'To', value: `<sip:+${to}@sip.example>` },
    { name: 'X-WA-Meta-Wacid', value: 'wacid.ID' },
    { name: 'X-WA-Meta-Phone-Number-Id', value: id }] } });
}

test('ruteo: el phone_number_id de TenGo manda aunque el To no coincida', async () => {
  const m = montar({ envExtra: { TENGOCAMELLO_PHONE_NUMBER_ID: '1425974090599345', PHONE_NUMBER_ID: '111222333444' } });
  const e = entradaConId('rtc_id_tc', '1425974090599345');
  assert.equal(e.destinoId, '1425974090599345');
  await m.manager._interno.atender(e);
  const log = m.logs.find(([msg]) => msg === '[voz] llamada_entrante')[1];
  assert.equal(log.numero, 'tengocamello');
  assert.equal(log.destino_id_presente, true);
  assert.equal(m.de('inicio')[0].numero, 'tengocamello');
});

test('ruteo: el phone_number_id de Miu sigue en Miu', async () => {
  const m = montar({ envExtra: { TENGOCAMELLO_PHONE_NUMBER_ID: '1425974090599345', PHONE_NUMBER_ID: '111222333444' } });
  await m.manager._interno.atender(entradaConId('rtc_id_miu', '111222333444'));
  const log = m.logs.find(([msg]) => msg === '[voz] llamada_entrante')[1];
  assert.equal(log.numero, 'miu');
  assert.equal(m.de('inicio')[0].numero, undefined);
});

test('ruteo: si el id de TenGo coincide con el de Miu, no se desvía nada (fail-closed)', () => {
  const c = readVozConfig({ TENGOCAMELLO_PHONE_NUMBER_ID: '111222333444', PHONE_NUMBER_ID: '111222333444' });
  assert.equal(c.tengoPhoneNumberId, '');
});
