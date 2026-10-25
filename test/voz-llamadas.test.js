'use strict';

// Llamadas de WhatsApp con Cami por voz: firma del webhook de OpenAI, tope de
// gasto, lectura de eventos y el ciclo de una llamada con dobles de prueba.
// Sin red, sin secretos reales y con numeros ficticios (prefijo 999, no
// asignado a ningun pais).

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { verifyOpenAiWebhook, signOpenAiWebhook } = require('../lib/voz/openai-webhook-signature');
const { decidirAdmision, costoDeLlamada, costoMaximoPorLlamada } = require('../lib/voz/cost-guard');
const { extractMetaCalls, isCallsOnlyPayload, parseOpenAiCallIncoming, telefonoDeSip } = require('../lib/voz/call-events');
const { readVozConfig, vozConfigParaLog, costoMaxExcedePms } = require('../lib/voz/config');
const { herramientasDeVoz, instruccionesCamiVoz, normalizarArgsVoz, bloqueInventario } = require('../lib/voz/cami-voz');
const { createVozCallManager } = require('../lib/voz/call-manager');

const SECRETO = `whsec_${Buffer.from('secreto-de-prueba-voz').toString('base64')}`;
const FICTICIO = '999000000001';

function firmado(evento, { secret = SECRETO, nowMs = Date.now(), id = 'wh_test_1' } = {}) {
  const rawBody = JSON.stringify(evento);
  const timestamp = String(Math.floor(nowMs / 1000));
  return { rawBody: Buffer.from(rawBody), body: evento,
    headers: { 'webhook-id': id, 'webhook-timestamp': timestamp,
      'webhook-signature': signOpenAiWebhook({ id, timestamp, rawBody, secret }) } };
}

function eventoEntrante(callId = 'rtc_test_1', from = `"X" <sip:+${FICTICIO}@example.invalid>;tag=1`) {
  return { object: 'event', id: 'evt_1', type: 'realtime.call.incoming',
    data: { call_id: callId, sip_headers: [{ name: 'From', value: from }, { name: 'x-wa-meta-wacid', value: 'wacid.TEST' }] } };
}

// ---------------------------------------------------------------- firma
test('firma valida de OpenAI se acepta', () => {
  const r = firmado(eventoEntrante());
  assert.equal(verifyOpenAiWebhook({ ...r, secret: SECRETO }).ok, true);
});

test('cuerpo alterado, secreto distinto o firma vieja se rechazan', () => {
  const r = firmado(eventoEntrante());
  assert.equal(verifyOpenAiWebhook({ ...r, rawBody: Buffer.from(`${r.rawBody} `), secret: SECRETO }).error, 'invalid_signature');
  const otro = `whsec_${Buffer.from('otro').toString('base64')}`;
  assert.equal(verifyOpenAiWebhook({ ...r, secret: otro }).error, 'invalid_signature');
  const viejo = firmado(eventoEntrante(), { nowMs: Date.now() - 10 * 60 * 1000 });
  assert.equal(verifyOpenAiWebhook({ ...viejo, secret: SECRETO }).error, 'stale_timestamp');
});

test('sin secreto configurado o sin cabeceras no pasa', () => {
  const r = firmado(eventoEntrante());
  assert.equal(verifyOpenAiWebhook({ ...r, secret: '' }).status, 503);
  assert.equal(verifyOpenAiWebhook({ ...r, headers: {}, secret: SECRETO }).error, 'missing_signature_headers');
});

test('acepta si una de varias firmas coincide (rotacion de secreto)', () => {
  const r = firmado(eventoEntrante());
  r.headers['webhook-signature'] = `v1,${Buffer.from('x'.repeat(32)).toString('base64')} ${r.headers['webhook-signature']}`;
  assert.equal(verifyOpenAiWebhook({ ...r, secret: SECRETO }).ok, true);
});

// ---------------------------------------------------------------- tope
test('costo por llamada y maximo por llamada', () => {
  assert.equal(costoDeLlamada(150, 0.06), 0.15);
  assert.equal(costoMaximoPorLlamada({ duracionMaxMin: 10, costoUsdMinuto: 0.06 }), 0.6);
});

test('admite mientras el peor caso cabe en el tope y rechaza al llegar', () => {
  const base = { topeUsdMes: 50, duracionMaxMin: 10, costoUsdMinuto: 0.06 };
  assert.equal(decidirAdmision({ ...base, usoMesUsd: 49.4, enCurso: 0 }).admitir, true);
  assert.equal(decidirAdmision({ ...base, usoMesUsd: 49.41, enCurso: 0 }).admitir, false);
  // dos llamadas en curso cuentan como su maximo
  assert.equal(decidirAdmision({ ...base, usoMesUsd: 48.5, enCurso: 2 }).motivo, 'tope_mensual');
  assert.equal(decidirAdmision({ ...base, usoMesUsd: undefined }).motivo, 'uso_desconocido');
});

test('configuracion: apagada por defecto y valores por defecto', () => {
  const c = readVozConfig({});
  assert.equal(c.habilitada, false);
  assert.equal(c.modelo, 'gpt-realtime-mini');
  assert.equal(c.topeUsdMes, 50);
  assert.equal(c.costoUsdMinuto, 0.06);
  assert.equal(c.duracionMaxMin, 10);
  const log = vozConfigParaLog(readVozConfig({ VOZ_OPENAI_API_KEY: 'sk-no-real', VOZ_OPENAI_WEBHOOK_SECRET: SECRETO }));
  assert.equal(JSON.stringify(log).includes('sk-no-real'), false);
  assert.equal(log.api_key_present, true);
});

// ---------------------------------------------------------------- eventos
test('eventos calls de Meta: connect y terminate', () => {
  const payload = { entry: [{ changes: [{ field: 'calls', value: { calls: [
    { id: 'wacid.A', from: FICTICIO, event: 'connect', direction: 'USER_INITIATED', timestamp: '1760000000', session: { sdp: 'v=0' } },
    { id: 'wacid.A', from: FICTICIO, event: 'terminate', status: 'COMPLETED', duration: 42, timestamp: '1760000042' },
  ] } }] }] };
  const calls = extractMetaCalls(payload);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((c) => c.evento), ['connect', 'terminate']);
  assert.equal(calls[0].telefono, FICTICIO);
  assert.equal(calls[1].duracionSegundos, 42);
  assert.equal('session' in calls[0], false, 'el SDP no se copia');
  assert.equal(isCallsOnlyPayload(payload), true);
  assert.equal(isCallsOnlyPayload({ entry: [{ changes: [{ field: 'messages', value: {} }] }] }), false);
  assert.deepEqual(extractMetaCalls({ entry: [{ changes: [{ field: 'messages', value: { calls: [{ id: 'x', event: 'connect' }] } }] }] }), []);
});

test('evento realtime.call.incoming: id, telefono y wacid', () => {
  const r = parseOpenAiCallIncoming(eventoEntrante());
  assert.deepEqual(r, { callId: 'rtc_test_1', telefono: FICTICIO, wacid: 'wacid.TEST' });
  assert.equal(parseOpenAiCallIncoming({ type: 'otro' }), null);
  assert.equal(parseOpenAiCallIncoming(eventoEntrante('../malo')), null);
  assert.equal(telefonoDeSip('<sip:BSUID.abc@example.invalid>'), null, 'identificador opaco no es telefono');
});

// ---------------------------------------------------------------- Cami voz
test('instrucciones: IA, sin cobro por telefono y regla de Airbnb', () => {
  const t = instruccionesCamiVoz({ hoy: '2026-10-19', huespedAirbnb: true });
  assert.match(t, /inteligencia artificial/);
  assert.match(t, /Nunca reservas, apartas, cobras/);
  assert.match(t, /huésped de una reserva de Airbnb/);
  const nombres = herramientasDeVoz().map((h) => h.name);
  assert.deepEqual(nombres.filter((n) => !['terminar_llamada', 'pedir_persona', 'enviar_opciones_al_chat', 'anotar_lista_espera', 'consultar_al_equipo', 'evaluar_uso_aceptable', 'ofrecer_paquete_magia'].includes(n)).sort(),
    ['check_availability', 'get_policy', 'get_public_apartment_attributes', 'quote_stay', 'search_commercial_knowledge']);
  assert.equal(nombres.includes('prepare_pre_reservation'), false);
});

// ---------------------------------------------------------------- ciclo
class FakeWs extends EventEmitter {
  constructor(url, opts) { super(); this.url = url; this.opts = opts; this.readyState = 1; this.enviados = []; FakeWs.ultima = this; }
  send(t) { this.enviados.push(JSON.parse(t)); }
  close() { this.readyState = 3; this.emit('close'); }
}

const TEXTO_FIJO_PMS = 'Hola, soy Cami (texto fijo del PMS).';

function montar({ uso = 0, pmsFalla = false, habilitada = true, inicio = {}, viaFin = 'outbox', viaRechazo = 'outbox',
  resumenJson = { resumen: 'Busca 30 noches.', alerta: null, alerta_motivo: null }, huerfanas = [],
  fotosResp = (b) => ({ via: 'outbox', codigos: b.apartamentos, texto: 'TEXTO FOTOS', fotos_encoladas: 3 }),
  disponibles = ['LF-510', 'LF-904', 'LF-1208'], fueraHorizonte = null,
  listaEsperaResp = (b) => ({ anotado: true, ya_anotado: false, check_in: b.check_in, mensaje_para_el_huesped: 'Listo, quedaste en la lista de espera.' }) } = {}) {
  const posts = [], textos = [], pmsLlamadas = [], herramientas = [], imagenes = [], entregas = [];
  const estado = { alertaFalla: false };
  const config = readVozConfig({ VOZ_LLAMADAS_HABILITADAS: habilitada ? 'true' : '', VOZ_OPENAI_API_KEY: 'sk-test-no-real',
    VOZ_OPENAI_WEBHOOK_SECRET: SECRETO });
  const http = { post: async (url, body) => {
    posts.push({ url, body });
    if (url.endsWith('/chat/completions')) return { data: { choices: [{ message: { content: JSON.stringify(resumenJson) } }] } };
    return { data: {} };
  } };
  const pms = {
    vozInicio: async (b) => { pmsLlamadas.push(['inicio', b]); if (pmsFalla) throw new Error('down');
      return { lead_id: 7, nombre_saludo: 'Ana', huesped_airbnb: false, persona_al_mando: false, uso_mes_usd: uso, ...inicio }; },
    vozEstado: async (b) => { pmsLlamadas.push(['estado', b]); if (pmsFalla) throw new Error('down');
      return b.avisar_huesped ? { estado: b.estado, seguimiento_via: viaRechazo, seguimiento_texto: TEXTO_FIJO_PMS } : { estado: b.estado }; },
    vozFin: async (b) => { pmsLlamadas.push(['fin', b]);
      return { seguimiento_via: b.siguiente_paso && b.enviar_seguimiento ? viaFin : 'no_enviado', seguimiento_texto: TEXTO_FIJO_PMS }; },
    vozAlerta: async (b) => { pmsLlamadas.push(['alerta', b]); if (estado.alertaFalla) throw new Error('down'); return { aviso_encolado: true }; },
    vozSeguimientoDirecto: async (b) => { pmsLlamadas.push(['directo', b]); return {}; },
    vozHuerfanas: async (b) => { pmsLlamadas.push(['huerfanas', b]); return { llamadas: huerfanas }; },
    vozFotos: async (b) => { pmsLlamadas.push(['fotos', b]); return fotosResp(b); },
    vozMetaEvento: async (b) => { pmsLlamadas.push(['meta', b]); return {}; },
    vozListaEspera: async (b) => { pmsLlamadas.push(['lista_espera', b]); return listaEsperaResp(b); },
    vozConsultaTeo: async (b) => { pmsLlamadas.push(['consulta_teo', b]); if (estado.consultaFalla) throw new Error('down');
      return { registrada: true, via: 'teo', consulta_id: 1, instruccion_modelo: 'Quedó registrada. Dile que lo confirmas.' }; },
    vozPaqueteMagia: async (b) => { pmsLlamadas.push(['paquete_magia', b]); if (estado.magiaFalla) throw new Error('down');
      return { iniciada: true, demo_id: 3, instruccion_modelo: 'Listo: le acabo de escribir por el chat.' }; },
    vozUsoAceptable: async (b) => { pmsLlamadas.push(['uso_aceptable', b]); if (estado.usoFalla) throw new Error('down');
      return { decision: b.decision, texto_para_decir: `TEXTO PMS ${b.decision}`, aviso_encolado: true }; },
  };
  const pendientes = [];
  const logs = [];
  const timers = { setTimeout: (fn, ms) => { pendientes.push({ fn, ms }); return pendientes.length; }, clearTimeout: () => {} };
  let t = Date.now();
  const manager = createVozCallManager({ config, http, WebSocketImpl: FakeWs, pms, timers, now: () => t,
    executePmsTool: async (name, args, ctx) => { herramientas.push({ name, args, ctx });
      if (fueraHorizonte && (name === 'check_availability' || name === 'quote_stay')) return fueraHorizonte;
      return name === 'check_availability' ? { status: 'ok', data: { available: disponibles.map((c) => ({ apartment_code: c })) } }
        : { status: 'ok', data: { total: 1 } }; },
    sendText: async (to, body) => { textos.push({ to, body }); },
    sendImage: async (to, link, caption) => { imagenes.push({ to, link, caption }); },
    entregarAhora: async () => { entregas.push(1); },
    logger: { info(msg, datos) { logs.push([msg, datos]); }, warn() {}, error() {} } });
  const de = (paso) => pmsLlamadas.filter((c) => c[0] === paso).map((c) => c[1]);
  // Corre los temporizadores programados con exactamente `ms` (p. ej. el saludo).
  // Cada temporizador corre una sola vez (como uno real).
  const correr = (ms) => { for (const p of pendientes.filter((x) => x.ms === ms && !x.hecho)) { p.hecho = true; p.fn(); } };
  return { logs, pendientes, manager, posts, textos, pmsLlamadas, herramientas, imagenes, entregas, de, correr, avanzar: (ms) => { t += ms; },
    fallarAlerta: () => { estado.alertaFalla = true; }, fallarUsoAceptable: () => { estado.usoFalla = true; }, estado };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));
const mensaje = (ws, e) => ws.emit('message', Buffer.from(JSON.stringify(e)));

test('apagada: el webhook responde 404 y no hace nada', async () => {
  const m = montar({ habilitada: false });
  const r = m.manager.handleWebhook(firmado(eventoEntrante()));
  assert.equal(r.status, 404);
  assert.equal(m.posts.length, 0);
  assert.deepEqual(await m.manager.barrerHuerfanas(), { colgadas: 0 });
});

test('firma invalida: 400 y no se toca OpenAI', () => {
  const m = montar();
  const r = m.manager.handleWebhook({ ...firmado(eventoEntrante()), rawBody: Buffer.from('{}') });
  assert.equal(r.status, 400);
  assert.equal(m.posts.length, 0);
});

test('tope alcanzado: rechaza y el PMS encola el aviso fijo (no se escribe directo)', async () => {
  const m = montar({ uso: 49.9 });
  await m.manager.handleWebhook(firmado(eventoEntrante())).procesando;
  assert.equal(m.posts.some((p) => p.url.endsWith('/accept')), false);
  assert.equal(m.posts.some((p) => p.url.endsWith('/realtime/calls/rtc_test_1/reject')), true);
  assert.deepEqual(m.de('estado')[0], { call_id: 'rtc_test_1', estado: 'rechazada', motivo: 'tope_mensual', avisar_huesped: true });
  assert.deepEqual(m.textos, []);
});

test('P2-5: rechazo de quien nunca escribio: el texto fijo del PMS sale directo y se marca', async () => {
  const m = montar({ uso: 49.9, viaRechazo: 'sin_caso' });
  await m.manager.handleWebhook(firmado(eventoEntrante())).procesando;
  assert.deepEqual(m.textos, [{ to: FICTICIO, body: TEXTO_FIJO_PMS }]);
  assert.deepEqual(m.de('directo'), [{ call_id: 'rtc_test_1', enviado: true }]);
});

test('P2-5: rechazo con persona al mando (PMS suprime): no sale nada', async () => {
  const m = montar({ uso: 49.9, viaRechazo: 'suprimido' });
  await m.manager.handleWebhook(firmado(eventoEntrante())).procesando;
  assert.deepEqual(m.textos, []);
});

test('PMS caido: no se puede medir el gasto, se rechaza y no se escribe', async () => {
  const m = montar({ pmsFalla: true });
  await m.manager.handleWebhook(firmado(eventoEntrante())).procesando;
  assert.equal(m.posts.some((p) => p.url.endsWith('/reject')), true);
  assert.equal(m.posts.some((p) => p.url.endsWith('/accept')), false);
  assert.deepEqual(m.textos, []);
});

test('llamada completa: aceptada antes de aceptar, herramienta, cuelga, resumen interno y paso fijo', async () => {
  const m = montar();
  const r = m.manager.handleWebhook(firmado(eventoEntrante()));
  assert.equal(r.status, 200);
  await r.procesando;
  const dup = m.manager.handleWebhook(firmado(eventoEntrante(), { id: 'wh_test_2' }));
  assert.equal(dup.body.deduplicated, true);

  // P2-2: 'aceptada' se registra antes del POST accept.
  const iEstado = m.pmsLlamadas.findIndex((c) => c[0] === 'estado' && c[1].estado === 'aceptada');
  assert.ok(iEstado >= 0);
  const accept = m.posts.find((p) => p.url.endsWith('/realtime/calls/rtc_test_1/accept'));
  assert.equal(accept.body.model, 'gpt-realtime-mini');
  assert.match(accept.body.instructions, /La persona se llama Ana/);
  assert.equal(accept.body.tools.some((t) => t.name === 'quote_stay'), true);

  const ws = FakeWs.ultima;
  ws.emit('open');
  assert.equal(ws.enviados.length, 0, 'A: el saludo espera a que fluya el audio');
  m.correr(1500);
  assert.equal(ws.enviados[0].type, 'response.create');
  mensaje(ws, { type: 'conversation.item.input_audio_transcription.completed', transcript: 'Quiero un mes desde noviembre' });
  mensaje(ws, { type: 'response.done', response: { output: [{ type: 'function_call', name: 'check_availability', call_id: 'fc_0',
    arguments: JSON.stringify({ nights: 30, arrival_date: '2026-11-01', guests: 2 }) }] } });
  await tick();
  mensaje(ws, { type: 'response.done', response: { output: [{ type: 'function_call', name: 'quote_stay', call_id: 'fc_1',
    arguments: JSON.stringify({ nights: 30, arrival_date: '2026-11-01', apartment_code: null }) }] } });
  await tick();
  assert.equal(m.herramientas[1].name, 'quote_stay');
  assert.equal(m.herramientas[1].ctx.proposal_snapshot, null);
  mensaje(ws, { type: 'response.output_audio_transcript.done', transcript: 'Con gusto, te cotizo.' });

  m.avanzar(150_000);
  ws.close();
  await tick();

  const fin = m.de('fin')[0];
  assert.equal(fin.duracion_segundos, 150);
  assert.equal(fin.costo_estimado_usd, 0.15);
  assert.deepEqual(fin.transcripcion.map((t) => t.quien), ['huesped', 'cami']);
  assert.equal(fin.resumen, 'Busca 30 noches.');
  assert.equal(fin.siguiente_paso, 'cotizacion');
  assert.equal(fin.enviar_seguimiento, true);
  assert.equal('seguimiento_texto' in fin, false, 'el webhook no redacta el texto al huesped');
  assert.deepEqual(fin.herramientas_usadas, ['check_availability', 'quote_stay']);
  assert.deepEqual(m.textos, [], 'salio por la cola del PMS, no directo');
  assert.equal(m.manager.activas.size, 0);
});

test('P1-1: pedir_persona avisa de inmediato al PMS con tipo y motivo; el paso es "persona"', async () => {
  const m = montar();
  await m.manager.handleWebhook(firmado(eventoEntrante('rtc_test_5'))).procesando;
  const ws = FakeWs.ultima;
  mensaje(ws, { type: 'conversation.item.input_audio_transcription.completed', transcript: 'Hay una fuga de agua' });
  mensaje(ws, { type: 'response.done', response: { output: [{ type: 'function_call', name: 'pedir_persona', call_id: 'fc_p',
    arguments: JSON.stringify({ tipo: 'emergencia', motivo: 'fuga de agua' }) }] } });
  await tick();
  assert.deepEqual(m.de('alerta'), [{ call_id: 'rtc_test_5', tipo: 'emergencia', motivo: 'fuga de agua' }]);
  ws.close();
  await tick();
  const fin = m.de('fin')[0];
  assert.equal(fin.siguiente_paso, 'persona');
  assert.equal(fin.requiere_persona, true);
  assert.equal(fin.alerta, 'emergencia', 'se repite al cerrar; el PMS no duplica el aviso');
  assert.equal(fin.alerta_motivo, 'fuga de agua');
});

test('Cami pregunta primero a Teo (2026-10-24): consultar_al_equipo registra la pregunta en el PMS y devuelve la instrucción', async () => {
  const m = montar();
  await m.manager.handleWebhook(firmado(eventoEntrante('rtc_teo_wh'))).procesando;
  const ws = FakeWs.ultima;
  const accept = m.posts.find((p) => p.url.endsWith('/accept'));
  assert.equal(accept.body.tools.some((t) => t.name === 'consultar_al_equipo'), true);
  assert.match(accept.body.instructions, /usa consultar_al_equipo/);
  mensaje(ws, { type: 'response.done', response: { output: [{ type: 'function_call', name: 'consultar_al_equipo', call_id: 'fc_t',
    arguments: JSON.stringify({ pregunta: '¿El gimnasio abre los domingos?', contexto: '30 noches en diciembre' }) }] } });
  await tick();
  assert.deepEqual(m.de('consulta_teo'), [{ call_id: 'rtc_teo_wh', pregunta: '¿El gimnasio abre los domingos?', contexto: '30 noches en diciembre' }]);
  const salida = ws.enviados.find((e) => e.type === 'conversation.item.create' && e.item?.call_id === 'fc_t');
  const out = JSON.parse(salida.item.output);
  assert.equal(out.status, 'ok');
  assert.match(out.instruccion_modelo, /Quedó registrada/);
  // Pregunta vacía: no llama al PMS.
  mensaje(ws, { type: 'response.done', response: { output: [{ type: 'function_call', name: 'consultar_al_equipo', call_id: 'fc_t2',
    arguments: JSON.stringify({ pregunta: ' ' }) }] } });
  await tick();
  assert.equal(m.de('consulta_teo').length, 1);
  // PMS caído (revisión P2-3): no se promete sin rastro; va como aviso (pedir_persona).
  m.estado.consultaFalla = true;
  mensaje(ws, { type: 'response.done', response: { output: [{ type: 'function_call', name: 'consultar_al_equipo', call_id: 'fc_t3',
    arguments: JSON.stringify({ pregunta: '¿Hay piscina?' }) }] } });
  await tick();
  assert.deepEqual(m.de('alerta').map((a) => a.tipo), ['persona']);
  assert.match(m.de('alerta')[0].motivo, /Cami no supo responder: ¿Hay piscina\?/);
  const out3 = JSON.parse(ws.enviados.find((e) => e.type === 'conversation.item.create' && e.item?.call_id === 'fc_t3').item.output);
  assert.match(out3.instruccion_modelo, /aviso para José Manuel/);
});

test('P1-1: el resumen que detecta una queja la manda como alerta al cerrar', async () => {
  const m = montar({ resumenJson: { resumen: 'Se queja del ruido.', alerta: 'queja', alerta_motivo: 'ruido del vecino' } });
  await m.manager.handleWebhook(firmado(eventoEntrante('rtc_test_6'))).procesando;
  const ws = FakeWs.ultima;
  mensaje(ws, { type: 'conversation.item.input_audio_transcription.completed', transcript: 'Hay mucho ruido' });
  ws.close();
  await tick();
  const fin = m.de('fin')[0];
  assert.equal(fin.alerta, 'queja');
  assert.equal(fin.alerta_motivo, 'ruido del vecino');
  assert.equal(fin.siguiente_paso, 'persona');
});

test('P2-4: huesped de Airbnb: sin quote_stay ni check_availability, y el PMS no las ejecuta aunque las pidan', async () => {
  const m = montar({ inicio: { huesped_airbnb: true } });
  await m.manager.handleWebhook(firmado(eventoEntrante('rtc_test_7'))).procesando;
  const accept = m.posts.find((p) => p.url.endsWith('/accept'));
  const nombres = accept.body.tools.map((t) => t.name);
  assert.equal(nombres.includes('quote_stay'), false);
  assert.equal(nombres.includes('check_availability'), false);
  assert.equal(nombres.includes('get_policy'), true);
  const ws = FakeWs.ultima;
  mensaje(ws, { type: 'response.done', response: { output: [{ type: 'function_call', name: 'quote_stay', call_id: 'fc_q', arguments: '{}' }] } });
  await tick();
  assert.equal(m.herramientas.length, 0);
  ws.close();
  await tick();
  assert.equal(m.de('fin')[0].siguiente_paso, 'estadia');
});

test('P2-4/P2-5: persona al mando: sin herramientas comerciales y sin seguimiento', async () => {
  const m = montar({ inicio: { persona_al_mando: true }, viaFin: 'sin_caso' });
  await m.manager.handleWebhook(firmado(eventoEntrante('rtc_test_8'))).procesando;
  const accept = m.posts.find((p) => p.url.endsWith('/accept'));
  assert.equal(accept.body.tools.some((t) => t.name === 'quote_stay'), false);
  FakeWs.ultima.close();
  await tick();
  assert.equal(m.de('fin')[0].enviar_seguimiento, false);
  assert.deepEqual(m.textos, []);
});

test('propietaria en onboarding (2026-10-23): la reconoce, no cotiza ni ofrece y no hay seguimiento automatico', async () => {
  const m = montar({ inicio: { lead_id: null, nombre_saludo: null, propietaria_onboarding: { no_cotizar: true, nombre_saludo: 'Margarita', estado: 'en_curso' } }, viaFin: 'sin_caso' });
  await m.manager.handleWebhook(firmado(eventoEntrante('rtc_test_prop'))).procesando;
  const accept = m.posts.find((p) => p.url.endsWith('/accept'));
  const nombres = accept.body.tools.map((t) => t.name);
  for (const n of ['check_availability', 'quote_stay', 'enviar_opciones_al_chat', 'anotar_lista_espera']) assert.equal(nombres.includes(n), false, n);
  assert.equal(nombres.includes('pedir_persona'), true);
  assert.match(accept.body.instructions, /PROPIETARIA de un apartamento de Miu Canal/);
  assert.match(accept.body.instructions, /siguen por el chat de WhatsApp/);
  assert.match(accept.body.instructions, /La persona se llama Margarita/);
  assert.doesNotMatch(accept.body.instructions, /CÓMO ATENDER UNA BÚSQUEDA/);
  FakeWs.ultima.close();
  await tick();
  assert.equal(m.de('fin')[0].enviar_seguimiento, false);
  assert.deepEqual(m.textos, []);
});

test('seguimiento sin caso en el PMS: el texto fijo devuelto sale directo', async () => {
  const m = montar({ viaFin: 'sin_caso' });
  await m.manager.handleWebhook(firmado(eventoEntrante('rtc_test_10'))).procesando;
  FakeWs.ultima.close();
  await tick();
  assert.deepEqual(m.textos, [{ to: FICTICIO, body: TEXTO_FIJO_PMS }]);
  assert.deepEqual(m.de('directo'), [{ call_id: 'rtc_test_10', enviado: true }]);
});

test('herramienta que no es de lectura no llega al PMS ni a herramientas_usadas (P2-6)', async () => {
  const m = montar();
  await m.manager.handleWebhook(firmado(eventoEntrante('rtc_test_9'))).procesando;
  const ws = FakeWs.ultima;
  mensaje(ws, { type: 'response.done', response: { output: [
    { type: 'function_call', name: 'prepare_pre_reservation', call_id: 'fc_x', arguments: '{}' },
    { type: 'function_call', name: 'x'.repeat(500), call_id: 'fc_y', arguments: '{}' }] } });
  await tick();
  assert.equal(m.herramientas.length, 0);
  const salida = ws.enviados.find((e) => e.type === 'conversation.item.create');
  assert.match(salida.item.output, /not_authorized/);
  ws.close();
  await tick();
  assert.deepEqual(m.de('fin')[0].herramientas_usadas, []);
});

test('P2-1: el barrido cuelga las huerfanas y las cierra con el costo maximo', async () => {
  const m = montar({ huerfanas: [{ call_id: 'rtc_old_1', estado: 'aceptada' }] });
  const r = await m.manager.barrerHuerfanas();
  assert.deepEqual(r, { colgadas: 1 });
  assert.deepEqual(m.de('huerfanas'), [{ mayor_a_min: 15 }]);
  assert.equal(m.posts.some((p) => p.url.endsWith('/realtime/calls/rtc_old_1/hangup')), true);
  const fin = m.de('fin')[0];
  assert.equal(fin.estado, 'fallida');
  assert.equal(fin.costo_estimado_usd, 0.6);
  assert.equal(fin.enviar_seguimiento, false);
});

test('P2-3: costo por minuto 0 no se acepta y se avisa si excede el maximo del PMS', () => {
  assert.equal(readVozConfig({ VOZ_COSTO_USD_MINUTO: '0' }).costoUsdMinuto, 0.06);
  assert.equal(costoMaxExcedePms(readVozConfig({ VOZ_COSTO_USD_MINUTO: '5', VOZ_DURACION_MAX_MIN: '30' })), true);
  assert.equal(costoMaxExcedePms(readVozConfig({})), false);
});

test('eventos de Meta se registran en el PMS solo con la funcion encendida', async () => {
  const ev = [{ wacid: 'wacid.B', evento: 'connect', estado: null, direccion: 'USER_INITIATED', telefono: FICTICIO,
    duracionSegundos: null, ocurridoAt: new Date().toISOString() }];
  const on = montar();
  await on.manager.registrarEventosMeta(ev);
  assert.equal(on.de('meta').length, 1);
  const off = montar({ habilitada: false });
  await off.manager.registrarEventosMeta(ev);
  assert.equal(off.pmsLlamadas.length, 0);
});

test('P2-1 (2a revision): si el aviso durante la llamada falla, la alerta sale al cerrar', async () => {
  const m = montar();
  const pmsAlerta = m.de;
  await m.manager.handleWebhook(firmado(eventoEntrante('rtc_test_11'))).procesando;
  const ws = FakeWs.ultima;
  m.fallarAlerta();
  mensaje(ws, { type: 'response.done', response: { output: [{ type: 'function_call', name: 'pedir_persona', call_id: 'fc_p2',
    arguments: JSON.stringify({ tipo: 'persona', motivo: 'quiere hablar con José' }) }] } });
  await tick();
  ws.close();
  await tick();
  const fin = pmsAlerta('fin')[0];
  assert.equal(fin.alerta, 'persona');
  assert.equal(fin.alerta_motivo, 'quiere hablar con José');
});

// ---------------------------------------------------------------- 2026-10-19: primera llamada real
test('argumentos de la voz: sin codigo busca en todos; salida -> noches; basura -> null', () => {
  assert.deepEqual(normalizarArgsVoz('check_availability', { arrival_date: '2026-11-15', departure_date: '2026-12-15', guests: 2,
    apartment_code: 'cualquiera' }), { arrival_date: '2026-11-15', nights: 30, apartment_code: null, guests: 2 });
  assert.deepEqual(normalizarArgsVoz('quote_stay', { arrival_date: '2026-11-15', nights: 30, apartment_code: 'el 510' }),
    { arrival_date: '2026-11-15', nights: 30, apartment_code: 'LF-510' });
  assert.equal(normalizarArgsVoz('check_availability', { arrival_date: '15 de noviembre', nights: 30 }).arrival_date, null);
  assert.equal(normalizarArgsVoz('check_availability', { arrival_date: '2026-02-30', nights: 3 }).arrival_date, null);
  assert.equal(normalizarArgsVoz('check_availability', { arrival_date: '2026-11-15', apartment_code: '' }).apartment_code, null);
  const ca = herramientasDeVoz().find((t) => t.name === 'check_availability');
  assert.deepEqual(ca.parameters.required, ['arrival_date']);
  assert.equal(JSON.stringify(ca.parameters).includes('null'), false, 'sin tipos nulos en el esquema de voz');
});

test('instrucciones: inventario publicado, nunca pedir codigo, opciones y fotos', () => {
  const inv = { unidades: [{ codigo: 'LF-510', titulo: 'Apartaestudio con balcón', resumen: null, capacidad: 2, area_m2: 31,
    camas: ['cama queen'], balcon: true, destacados: [] }], edificio: ['Piscina en la terraza.'] };
  const t = instruccionesCamiVoz({ hoy: '2026-10-19', inventario: inv });
  assert.match(t, /el 510 \(código LF-510\): Apartaestudio con balcón; hasta 2 personas; unos 31 m²; cama queen; con balcón/);
  assert.match(t, /NUNCA pidas código, tipo ni tamaño de apartamento/);
  assert.match(t, /enviar_opciones_al_chat/);
  assert.match(t, /seguir por ahí escribiendo o con notas de voz, o volver a llamarte/);
  assert.match(bloqueInventario(null), /No describas tipos de apartamento/);
  const airbnb = instruccionesCamiVoz({ hoy: '2026-10-19', huespedAirbnb: true, inventario: inv });
  assert.equal(/enviar_opciones_al_chat/.test(airbnb), false);
});

async function llamadaConDisponibilidad(m, callId) {
  await m.manager.handleWebhook(firmado(eventoEntrante(callId))).procesando;
  const ws = FakeWs.ultima;
  mensaje(ws, { type: 'response.done', response: { output: [{ type: 'function_call', name: 'check_availability', call_id: 'fc_ca',
    arguments: JSON.stringify({ arrival_date: '2026-11-15', departure_date: '2026-12-15', guests: 2 }) }] } });
  await tick();
  return ws;
}

test('check_availability por voz llega al PMS sin codigo y con noches; las fotos van por el PMS y se entregan ya', async () => {
  const m = montar({ inicio: { inventario: { unidades: [{ codigo: 'LF-510', titulo: 'Apartaestudio' }], edificio: [] } } });
  const ws = await llamadaConDisponibilidad(m, 'rtc_f1');
  assert.match(m.posts.find((p) => p.url.endsWith('/accept')).body.instructions, /el 510 \(código LF-510\): Apartaestudio/);
  assert.deepEqual(m.herramientas[0].args, { arrival_date: '2026-11-15', nights: 30, apartment_code: null, guests: 2 });
  mensaje(ws, { type: 'response.done', response: { output: [{ type: 'function_call', name: 'enviar_opciones_al_chat', call_id: 'fc_f',
    arguments: JSON.stringify({ apartment_codes: ['LF-510', '904', 'LF-210'] }) }] } });
  await tick();
  assert.deepEqual(m.de('fotos')[0], { call_id: 'rtc_f1', apartamentos: ['LF-510', 'LF-904'], check_in: '2026-11-15',
    check_out: '2026-12-15', guests: 2 });
  assert.equal(m.entregas.length, 1);
  const salida = ws.enviados.filter((e) => e.type === 'conversation.item.create').pop();
  const res = JSON.parse(salida.item.output);
  assert.deepEqual(res.data.enviadas_ahora, [{ posicion: 1, decir: 'el 510' }, { posicion: 2, decir: 'el 904' }]);
  assert.equal(res.data.total_enviadas_ahora, 2);
  ws.close();
  await tick();
  assert.equal(m.de('fin')[0].siguiente_paso, 'fotos');
  assert.deepEqual(m.textos, []);
});

test('fotos sin check_availability previo o de unidades no disponibles: no se envia nada', async () => {
  const m = montar();
  await m.manager.handleWebhook(firmado(eventoEntrante('rtc_f2'))).procesando;
  const ws = FakeWs.ultima;
  mensaje(ws, { type: 'response.done', response: { output: [{ type: 'function_call', name: 'enviar_opciones_al_chat', call_id: 'fc_x',
    arguments: JSON.stringify({ apartment_codes: ['LF-510'] }) }] } });
  await tick();
  assert.match(ws.enviados.filter((e) => e.type === 'conversation.item.create').pop().item.output, /primero_check_availability/);
  const m2 = montar({ disponibles: ['LF-904'] });
  const ws2 = await llamadaConDisponibilidad(m2, 'rtc_f3');
  mensaje(ws2, { type: 'response.done', response: { output: [{ type: 'function_call', name: 'enviar_opciones_al_chat', call_id: 'fc_y',
    arguments: JSON.stringify({ apartment_codes: ['LF-510'] }) }] } });
  await tick();
  assert.equal(m2.de('fotos').length, 0);
  assert.equal(m.de('fotos').length, 0);
});

test('quien nunca escribio: el texto fijo y las fotos del catalogo salen directo', async () => {
  const m = montar({ fotosResp: () => ({ via: 'sin_caso', codigos: ['LF-510'], texto: 'TEXTO FIJO FOTOS',
    apartamentos: [{ codigo: 'LF-510', ficha: 'Apartamento LF-510', fotos: [{ clave: 'LF-510/01-portada', pie: 'LF-510 · Vista general' },
      { clave: 'LF-510/no-existe', pie: 'x' }] }] }) });
  const ws = await llamadaConDisponibilidad(m, 'rtc_f4');
  mensaje(ws, { type: 'response.done', response: { output: [{ type: 'function_call', name: 'enviar_opciones_al_chat', call_id: 'fc_z',
    arguments: JSON.stringify({ apartment_codes: ['LF-510'] }) }] } });
  await tick();
  assert.deepEqual(m.textos, [{ to: FICTICIO, body: 'TEXTO FIJO FOTOS' }, { to: FICTICIO, body: 'Apartamento LF-510' }]);
  assert.equal(m.imagenes.length, 1, 'solo claves del catalogo aprobado');
  assert.match(m.imagenes[0].link, /\/media\/photos\/LF-510\/01-portada\.jpg/);
  assert.equal(m.imagenes[0].caption, 'LF-510 · Vista general');
});

test('huesped de Airbnb: sin herramienta de fotos', async () => {
  const m = montar({ inicio: { huesped_airbnb: true } });
  await m.manager.handleWebhook(firmado(eventoEntrante('rtc_f5'))).procesando;
  const nombres = m.posts.find((p) => p.url.endsWith('/accept')).body.tools.map((t) => t.name);
  assert.equal(nombres.includes('enviar_opciones_al_chat'), false);
});

// ---------------------------------------------------------------- revision de las fotos (P2-1, P2-2, P2-4)
function pedirFotos(ws, codigos, id = 'fc_r') {
  mensaje(ws, { type: 'response.done', response: { output: [{ type: 'function_call', name: 'enviar_opciones_al_chat', call_id: id,
    arguments: JSON.stringify({ apartment_codes: codigos }) }] } });
}
const ultimaSalida = (ws) => ws.enviados.filter((e) => e.type === 'conversation.item.create').pop().item.output;

test('P2-1: pedir otra vez las mismas fotos no las reenvia (ni por el PMS ni directo)', async () => {
  const m = montar({ fotosResp: (b) => ({ via: 'sin_caso', codigos: b.apartamentos, texto: 'TEXTO FIJO',
    apartamentos: [{ codigo: 'LF-510', ficha: 'Apartamento LF-510', fotos: [{ clave: 'LF-510/01-portada', pie: 'LF-510 · Vista general' }] }] }) });
  const ws = await llamadaConDisponibilidad(m, 'rtc_r1');
  pedirFotos(ws, ['LF-510']);
  await tick();
  pedirFotos(ws, ['LF-510'], 'fc_r2');
  await tick();
  assert.equal(m.de('fotos').length, 1);
  assert.equal(m.textos.length, 2);
  assert.equal(m.imagenes.length, 1);
  const res = JSON.parse(ultimaSalida(ws));
  assert.equal(res.data.total_enviadas_ahora, 0);
  assert.deepEqual(res.data.no_enviadas, [{ decir: 'el 510', motivo: 'ya_enviada_en_esta_llamada' }]);
  assert.match(res.instruccion, /no digas que enviaste fotos/);
});

test('P2-2: si el PMS no tiene nada nuevo que mandar, el modelo lo sabe y no es error', async () => {
  const m = montar({ fotosResp: () => ({ via: 'rechazado', motivo: 'ya_enviadas_en_esta_llamada', codigos: [], texto: null }) });
  const ws = await llamadaConDisponibilidad(m, 'rtc_r3');
  pedirFotos(ws, ['LF-510']);
  await tick();
  assert.match(ultimaSalida(ws), /"status":"ok".*"total_enviadas_ahora":0/);
  ws.close();
  await tick();
  assert.notEqual(m.de('fin')[0].siguiente_paso, 'fotos');
});

test('P2-4: una consulta posterior de una sola unidad con las mismas fechas no achica las opciones', async () => {
  const m = montar();
  const ws = await llamadaConDisponibilidad(m, 'rtc_r4');
  mensaje(ws, { type: 'response.done', response: { output: [{ type: 'function_call', name: 'check_availability', call_id: 'fc_ca2',
    arguments: JSON.stringify({ arrival_date: '2026-11-15', departure_date: '2026-12-15', guests: 2, apartment_code: 'LF-904' }) }] } });
  await tick();
  pedirFotos(ws, ['LF-510', 'LF-1208']);
  await tick();
  assert.deepEqual(m.de('fotos')[0].apartamentos, ['LF-510', 'LF-1208']);
});

test('P2-4: con otras fechas la lista se reemplaza', async () => {
  const m = montar({ disponibles: ['LF-904'] });
  const ws = await llamadaConDisponibilidad(m, 'rtc_r5');
  mensaje(ws, { type: 'response.done', response: { output: [{ type: 'function_call', name: 'check_availability', call_id: 'fc_ca3',
    arguments: JSON.stringify({ arrival_date: '2026-12-01', nights: 30, guests: 2 }) }] } });
  await tick();
  pedirFotos(ws, ['LF-904']);
  await tick();
  assert.deepEqual(m.de('fotos')[0], { call_id: 'rtc_r5', apartamentos: ['LF-904'], check_in: '2026-12-01', check_out: '2026-12-31', guests: 2 });
});

// ---------------------------------------------------------------- naturalidad (José Manuel, 2026-10-19)
test('saludo paisa: calido, corto, dice asistente virtual y que se transcribe', () => {
  const { PRESENTACION } = require('../lib/voz/cami-voz');
  assert.equal(PRESENTACION, '¡Hola! Qué bueno que llamas a Miu La Frontera. Te habla Cami, la asistente virtual. '
    + 'Te cuento que la llamada se transcribe para seguirte ayudando por el chat. ¿En qué te puedo ayudar?');
});

test('instrucciones: disponibilidad primero, sin prometer cotizacion, sin LF, sin relleno, despedida y marca', () => {
  const t = instruccionesCamiVoz({ hoy: '2026-10-19', inventario: { unidades: [{ codigo: 'LF-1109', titulo: 'Estudio en Mío La Frontera' }] } });
  assert.match(t, /usa PRIMERO check_availability/);
  assert.match(t, /NO prometas enviar una cotización o propuesta escrita/);
  assert.match(t, /di "el 510", "el 1109": nunca digas "LF"/);
  assert.match(t, /No pidas confirmaciones innecesarias/);
  assert.match(t, /UNA sola frase corta/);
  assert.match(t, /usa el orden que devolvió enviar_opciones_al_chat/);
  assert.match(t, /responder ahí escribiendo o con una nota de voz/);
  assert.match(t, /se pronuncia "miu". Nunca digas "Mío"/);
  assert.match(t, /el 1109 \(código LF-1109\): Estudio en Miu La Frontera/);
  assert.equal(/Mío La Frontera/.test(t), false);
});

test('enviar_opciones_al_chat devuelve el orden y como decirlo, acumulado en la llamada', async () => {
  const m = montar();
  const ws = await llamadaConDisponibilidad(m, 'rtc_n1');
  pedirFotos(ws, ['LF-1208', 'LF-510']);
  await tick();
  const out = JSON.parse(ultimaSalida(ws));
  assert.deepEqual(out.data.enviadas_ahora, [{ posicion: 1, decir: 'el 1208' }, { posicion: 2, decir: 'el 510' }]);
  pedirFotos(ws, ['LF-904'], 'fc_n2');
  await tick();
  const out2 = JSON.parse(ultimaSalida(ws));
  assert.deepEqual(out2.data.enviadas_ahora, [{ posicion: 3, decir: 'el 904' }]);
  assert.deepEqual(out2.data.todas_en_esta_llamada.map((o) => o.decir), ['el 1208', 'el 510', 'el 904']);
});

// ---------------------------------------------------------------- tercera llamada real (A, B, C, E)
test('A: si la persona habla antes del saludo, no se fuerza el saludo a los 1500 ms', async () => {
  const m = montar();
  await m.manager.handleWebhook(firmado(eventoEntrante('rtc_a1'))).procesando;
  const ws = FakeWs.ultima;
  ws.emit('open');
  mensaje(ws, { type: 'input_audio_buffer.speech_started' });
  await tick();
  m.correr(1500);
  assert.equal(ws.enviados.filter((e) => e.type === 'response.create').length, 0);
  assert.equal(readVozConfig({ VOZ_SALUDO_DEMORA_MS: '900' }).saludoDemoraMs, 900);
});

test('B: quote_stay se rechaza por codigo sin disponibilidad de esas fechas en esta llamada', async () => {
  const m = montar();
  await m.manager.handleWebhook(firmado(eventoEntrante('rtc_b1'))).procesando;
  const ws = FakeWs.ultima;
  mensaje(ws, { type: 'response.done', response: { output: [{ type: 'function_call', name: 'quote_stay', call_id: 'fc_q1',
    arguments: JSON.stringify({ arrival_date: '2026-11-15', departure_date: '2026-12-15' }) }] } });
  await tick();
  assert.equal(m.herramientas.length, 0);
  assert.match(ultimaSalida(ws), /primero_check_availability/);
  mensaje(ws, { type: 'response.done', response: { output: [{ type: 'function_call', name: 'check_availability', call_id: 'fc_c1',
    arguments: JSON.stringify({ arrival_date: '2026-11-15', departure_date: '2026-12-15', guests: 2 }) }] } });
  await tick();
  mensaje(ws, { type: 'response.done', response: { output: [{ type: 'function_call', name: 'quote_stay', call_id: 'fc_q2',
    arguments: JSON.stringify({ arrival_date: '2026-12-01', nights: 10 }) }] } });
  await tick();
  assert.match(ultimaSalida(ws), /primero_check_availability/, 'otras fechas: otra vez disponibilidad');
  mensaje(ws, { type: 'response.done', response: { output: [{ type: 'function_call', name: 'quote_stay', call_id: 'fc_q3',
    arguments: JSON.stringify({ arrival_date: '2026-11-15', nights: 30 }) }] } });
  await tick();
  assert.deepEqual(m.herramientas.map((h) => h.name), ['check_availability', 'quote_stay']);
});

test('C/E: la herramienta dice exactamente lo que salio, incluidas zonas comunes y lo que no salio', async () => {
  const m = montar({ fotosResp: (b) => ({ via: 'outbox', codigos: [b.apartamentos[0]], zonas_comunes: true,
    no_enviadas: b.apartamentos.slice(1).map((codigo) => ({ codigo, motivo: 'limite_3' })), texto: 'T', fotos_encoladas: 9 }) });
  const ws = await llamadaConDisponibilidad(m, 'rtc_c1');
  pedirFotos(ws, ['LF-510', 'LF-904']);
  await tick();
  const res = JSON.parse(ultimaSalida(ws));
  assert.deepEqual(res.data.enviadas_ahora, [{ posicion: 1, decir: 'el 510' }]);
  assert.deepEqual(res.data.no_enviadas, [{ decir: 'el 904', motivo: 'limite_3' }]);
  assert.equal(res.data.zonas_comunes_enviadas, true);
  assert.match(res.instruccion, /UNA opción ahora y fotos de las zonas comunes/);
});

test('E: envio directo con zonas comunes al final, sin contarlas como opcion', async () => {
  const m = montar({ fotosResp: () => ({ via: 'sin_caso', codigos: ['LF-510'], texto: 'T',
    apartamentos: [{ codigo: 'LF-510', ficha: 'Apartamento LF-510', fotos: [{ clave: 'LF-510/01-portada', pie: 'LF-510 · Vista general' }] },
      { codigo: 'EDIFICIO', ficha: 'Zonas comunes', fotos: [{ clave: 'EDIFICIO/01-fachada', pie: 'Zonas comunes · Fachada' }] }] }) });
  const ws = await llamadaConDisponibilidad(m, 'rtc_e1');
  pedirFotos(ws, ['LF-510']);
  await tick();
  assert.deepEqual(m.textos.map((t) => t.body), ['T', 'Apartamento LF-510', 'Zonas comunes']);
  assert.deepEqual(m.imagenes.map((i) => i.caption), ['LF-510 · Vista general', 'Zonas comunes · Fachada']);
  const res = JSON.parse(ultimaSalida(ws));
  assert.deepEqual(res.data.enviadas_ahora, [{ posicion: 1, decir: 'el 510' }]);
  assert.equal(res.data.zonas_comunes_enviadas, true);
});

// ---------------------------------------------------------------- saludo de respaldo (2026-10-22)
// Llamada real 15:43 UTC: un "¿aló?" cancelo el saludo y Cami quedo ~13 s en silencio.
async function llamadaAbierta(id) {
  const m = montar();
  await m.manager.handleWebhook(firmado(eventoEntrante(id))).procesando;
  const ws = FakeWs.ultima;
  ws.emit('open');
  return { m, ws };
}
const saludos = (ws) => ws.enviados.filter((e) => e.type === 'response.create' && e.response?.instructions);
const hitos = (m) => m.logs.filter(([msg]) => msg === '[voz] tiempo').map(([, d]) => d.hito);

test('respaldo: "¿aló?" sin respuesta ni transcripcion -> se saluda igual a los 3 s, una sola vez', async () => {
  const { m, ws } = await llamadaAbierta('rtc_r1');
  m.avanzar(800);
  mensaje(ws, { type: 'input_audio_buffer.speech_started' });
  m.avanzar(400);
  mensaje(ws, { type: 'input_audio_buffer.speech_stopped' });
  await tick();
  m.correr(1500);
  assert.equal(saludos(ws).length, 0, 'el saludo normal quedo cancelado');
  m.avanzar(2600);
  m.correr(3000);
  assert.equal(saludos(ws).length, 1, 'saludo forzado');
  m.correr(3000); m.correr(1000); m.correr(1500);
  assert.equal(saludos(ws).length, 1, 'nunca dos saludos');
  assert.deepEqual(hitos(m).slice(0, 5), ['ws_open', 'saludo_programado', 'primer_habla', 'saludo_cancelado', 'saludo_forzado']);
});

test('respaldo: si Cami ya sono (audio), no se fuerza el saludo', async () => {
  const { m, ws } = await llamadaAbierta('rtc_r2');
  mensaje(ws, { type: 'input_audio_buffer.speech_started' });
  mensaje(ws, { type: 'input_audio_buffer.speech_stopped' });
  mensaje(ws, { type: 'response.created', response: { id: 'resp_1' } });
  mensaje(ws, { type: 'output_audio_buffer.started' });
  await tick();
  m.avanzar(3000);
  m.correr(1500); m.correr(3000);
  assert.equal(saludos(ws).length, 0);
  assert.ok(hitos(m).includes('saludo_respaldo_innecesario'));
});

test('respaldo P1: respuesta automatica cancelada por el VAD sin audio -> se saluda igual', async () => {
  const { m, ws } = await llamadaAbierta('rtc_r2b');
  mensaje(ws, { type: 'input_audio_buffer.speech_started' });
  mensaje(ws, { type: 'input_audio_buffer.speech_stopped' });
  mensaje(ws, { type: 'response.created', response: { id: 'resp_1' } });
  await tick();
  m.avanzar(2000);
  m.correr(3000);
  assert.equal(saludos(ws).length, 0, 'respuesta en curso: espera');
  mensaje(ws, { type: 'response.done', response: { id: 'resp_1', status: 'cancelled', output: [] } });
  await tick();
  m.avanzar(1000); m.correr(1000);
  assert.equal(saludos(ws).length, 1);
  // El response.created del saludo forzado no produce otro saludo.
  mensaje(ws, { type: 'response.created', response: { id: 'resp_2' } });
  await tick();
  m.avanzar(3000); m.correr(1000); m.correr(3000);
  assert.equal(saludos(ws).length, 1);
});

test('respaldo: respuesta en curso al tope -> no se manda otro response.create', async () => {
  const { m, ws } = await llamadaAbierta('rtc_r2c');
  mensaje(ws, { type: 'input_audio_buffer.speech_started' });
  mensaje(ws, { type: 'input_audio_buffer.speech_stopped' });
  mensaje(ws, { type: 'response.created', response: { id: 'resp_1' } });
  await tick();
  m.avanzar(3000); m.correr(3000);
  for (let i = 0; i < 3; i += 1) { m.avanzar(1000); m.correr(1000); }
  assert.equal(saludos(ws).length, 0);
  assert.ok(hitos(m).includes('saludo_respaldo_omitido'));
});

test('respaldo: con transcripcion del huesped no se fuerza; una transcripcion vacia (ruido) no cuenta', async () => {
  const a = await llamadaAbierta('rtc_r3');
  mensaje(a.ws, { type: 'input_audio_buffer.speech_started' });
  mensaje(a.ws, { type: 'input_audio_buffer.speech_stopped' });
  mensaje(a.ws, { type: 'conversation.item.input_audio_transcription.completed', transcript: '¿Aló?' });
  await tick();
  a.m.avanzar(3000); a.m.correr(3000);
  assert.equal(saludos(a.ws).length, 0);

  const b = await llamadaAbierta('rtc_r4');
  mensaje(b.ws, { type: 'input_audio_buffer.speech_started' });
  mensaje(b.ws, { type: 'input_audio_buffer.speech_stopped' });
  mensaje(b.ws, { type: 'conversation.item.input_audio_transcription.completed', transcript: '  ' });
  await tick();
  b.m.avanzar(3000); b.m.correr(3000);
  assert.equal(saludos(b.ws).length, 1);
});

test('respaldo: si la persona sigue hablando espera; saluda 1 s despues de que calla', async () => {
  const { m, ws } = await llamadaAbierta('rtc_r5');
  mensaje(ws, { type: 'input_audio_buffer.speech_started' });
  await tick();
  m.avanzar(3000); m.correr(3000);
  assert.equal(saludos(ws).length, 0, 'sigue hablando: espera');
  mensaje(ws, { type: 'input_audio_buffer.speech_stopped' });
  await tick();
  m.avanzar(500); m.correr(1000);
  assert.equal(saludos(ws).length, 0, 'acaba de callar: la respuesta automatica puede venir');
  m.avanzar(500); m.correr(500);
  assert.equal(saludos(ws).length, 1);
});

test('respaldo: ruido continuo (nunca calla) -> se saluda al tope de 6 s', async () => {
  const { m, ws } = await llamadaAbierta('rtc_r6');
  mensaje(ws, { type: 'input_audio_buffer.speech_started' });
  await tick();
  m.avanzar(3000); m.correr(3000);
  for (let i = 0; i < 2; i += 1) { m.avanzar(1000); m.correr(1000); }
  assert.equal(saludos(ws).length, 0);
  m.avanzar(1000); m.correr(1000);
  assert.equal(saludos(ws).length, 1);
  assert.equal(m.logs.find(([msg, d]) => msg === '[voz] tiempo' && d.hito === 'saludo_forzado')[1].tope, true);
});

test('respaldo: el saludo normal ya salio -> un "¿aló?" posterior no programa otro', async () => {
  const { m, ws } = await llamadaAbierta('rtc_r7');
  m.correr(1500);
  assert.equal(saludos(ws).length, 1);
  mensaje(ws, { type: 'input_audio_buffer.speech_started' });
  await tick();
  m.avanzar(6000); m.correr(3000); m.correr(1000);
  assert.equal(saludos(ws).length, 1);
});

test('respaldo: si la llamada se cierra antes, no hace nada', async () => {
  const { m, ws } = await llamadaAbierta('rtc_r8');
  mensaje(ws, { type: 'input_audio_buffer.speech_started' });
  await tick();
  ws.close();
  await tick();
  m.avanzar(3000); m.correr(3000);
  assert.equal(saludos(ws).length, 0);
});

test('tiempos: hitos sin texto ni audio, y resumen en llamada_terminada', async () => {
  const { m, ws } = await llamadaAbierta('rtc_r9');
  m.avanzar(1500); m.correr(1500);
  mensaje(ws, { type: 'response.created', response: { id: 'resp_1' } });
  mensaje(ws, { type: 'output_audio_buffer.started' });
  mensaje(ws, { type: 'response.output_audio.delta', delta: 'AAAA' });
  mensaje(ws, { type: 'input_audio_buffer.speech_started' });
  mensaje(ws, { type: 'conversation.item.input_audio_transcription.completed', transcript: 'Texto privado del huesped' });
  await tick();
  ws.close();
  await tick();
  const h = hitos(m);
  for (const x of ['ws_open', 'saludo_programado', 'saludo_enviado', 'primera_respuesta', 'primer_audio', 'primer_habla', 'primera_transcripcion', 'fin']) {
    assert.ok(h.includes(x), x);
  }
  assert.equal(h.filter((x) => x === 'primer_audio').length, 1);
  assert.equal(h.includes('saludo_cancelado'), false);
  const enviado = m.logs.find(([msg, d]) => msg === '[voz] tiempo' && d.hito === 'saludo_enviado')[1];
  assert.equal(enviado.ms_desde_ws_open, 1500);
  const fin = m.logs.find(([msg]) => msg === '[voz] llamada_terminada')[1];
  assert.equal(typeof fin.tiempos_ms.primera_respuesta, 'number');
  const todo = JSON.stringify(m.logs);
  assert.equal(todo.includes('Texto privado'), false);
  assert.equal(todo.includes('AAAA'), false);
});

test('config: VOZ_SALUDO_RESPALDO_MS por defecto 3000 y acotado', () => {
  assert.equal(readVozConfig({}).saludoRespaldoMs, 3000);
  assert.equal(readVozConfig({ VOZ_SALUDO_RESPALDO_MS: '2000' }).saludoRespaldoMs, 2000);
  assert.equal(readVozConfig({ VOZ_SALUDO_RESPALDO_MS: '50' }).saludoRespaldoMs, 3000);
});

// ------------------------------------------- fuera del horizonte (2026-10-23)
// Llamada real voz_llamadas 8: 1-10 de enero, 2 personas. Cami invento "a
// partir del 1 de diciembre ya puedo revisar fechas".
const FUERA = { status: 'unavailable', reason: 'outside_direct_quote_horizon', missing: [], source: null,
  data: { max_direct_quote_until: '2026-11-30', precios_revisados_hasta: '2026-11-30', cotizacion_reservable: false,
    tarifa_estimada: { estimada: true, reservable: false, modo: 'noche', por_noche_promedio: 169000 },
    mensaje_para_el_huesped: 'Para esas fechas te puedo dar una tarifa estimada de referencia: $169.000 por noche…',
    instruccion_modelo: 'No digas ni inventes una fecha desde la cual hay disponibilidad.' } };

test('reglas de voz: fuera del horizonte usa el mensaje de la herramienta, tarifa estimada, lista de espera y nunca una fecha "desde"', () => {
  const t = instruccionesCamiVoz({ hoy: '2026-10-23' });
  assert.match(t, /FECHAS FUERA DEL HORIZONTE/);
  assert.match(t, /mensaje_para_el_huesped/);
  assert.match(t, /ESTIMADA/);
  assert.match(t, /anotar_lista_espera/);
  assert.match(t, /por el chat de WhatsApp/);
  assert.match(t, /NUNCA afirmes una fecha "desde la cual"/);
  assert.match(t, /precios_revisados_hasta \(o max_direct_quote_until\) NO es una fecha desde la cual/);
  // Airbnb / persona al mando: sin herramienta de lista de espera.
  assert.equal(herramientasDeVoz({ sinComerciales: true }).some((h) => h.name === 'anotar_lista_espera'), false);
  assert.equal(herramientasDeVoz().some((h) => h.name === 'anotar_lista_espera'), true);
});

test('writer del chat: la fecha de precios revisados nunca es una fecha "desde"', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'lib', 'pilot', 'llm', 'writer.js'), 'utf8');
  assert.match(src, /OUT OF HORIZON \(voice call 2026-10-23/);
  assert.match(src, /never a date FROM which dates, availability or quotes open/);
});

test('fuera del horizonte: la voz anota en la lista de espera por el PMS con las fechas y personas de la consulta', async () => {
  const m = montar({ fueraHorizonte: FUERA });
  await m.manager.handleWebhook(firmado(eventoEntrante('rtc_h1'))).procesando;
  const ws = FakeWs.ultima;
  mensaje(ws, { type: 'response.done', response: { output: [{ type: 'function_call', name: 'check_availability', call_id: 'fc_h1',
    arguments: JSON.stringify({ arrival_date: '2027-01-01', departure_date: '2027-01-10', guests: 2 }) }] } });
  await tick();
  // El modelo pide anotar sin repetir personas: se completan con las de la consulta.
  mensaje(ws, { type: 'response.done', response: { output: [{ type: 'function_call', name: 'anotar_lista_espera', call_id: 'fc_h2',
    arguments: JSON.stringify({ arrival_date: '2027-01-01', nights: 9 }) }] } });
  await tick();
  assert.deepEqual(m.de('lista_espera'), [{ call_id: 'rtc_h1', check_in: '2027-01-01', nights: 9, guests: 2 }]);
  const res = JSON.parse(ws.enviados.filter((e) => e.type === 'conversation.item.create').pop().item.output);
  assert.equal(res.status, 'ok');
  assert.equal(res.data.anotado, true);
  ws.close();
  await tick();
  assert.ok(m.de('fin')[0].herramientas_usadas.includes('anotar_lista_espera'));
});

test('lista de espera por voz: sin fechas no llama al PMS; si el PMS no anota, la herramienta lo dice', async () => {
  const m = montar({ listaEsperaResp: () => ({ anotado: false, motivo: 'sin_caso',
    instruccion_modelo: 'No quedó anotado automáticamente: dile que el equipo le confirma la lista de espera por el chat de WhatsApp.' }) });
  await m.manager.handleWebhook(firmado(eventoEntrante('rtc_h2'))).procesando;
  const ws = FakeWs.ultima;
  mensaje(ws, { type: 'response.done', response: { output: [{ type: 'function_call', name: 'anotar_lista_espera', call_id: 'fc_h3',
    arguments: JSON.stringify({}) }] } });
  await tick();
  assert.equal(m.de('lista_espera').length, 0);
  let res = JSON.parse(ws.enviados.filter((e) => e.type === 'conversation.item.create').pop().item.output);
  assert.equal(res.status, 'needs_clarification');
  mensaje(ws, { type: 'response.done', response: { output: [{ type: 'function_call', name: 'anotar_lista_espera', call_id: 'fc_h4',
    arguments: JSON.stringify({ arrival_date: '2027-01-01', nights: 9, guests: 2 }) }] } });
  await tick();
  res = JSON.parse(ws.enviados.filter((e) => e.type === 'conversation.item.create').pop().item.output);
  assert.equal(res.status, 'not_authorized');
  assert.match(res.data.instruccion_modelo, /chat de WhatsApp/);
  ws.close();
});

// ---------------------------------------------------------------- aliados
// PERFIL DE ALIADO (José Manuel, 2026-10-23; PMS migración 907): entrevista de
// descubrimiento por llamada, sin cotizar, con la guía como datos del PMS.
const GUIA_PRUEBA = { clave: 'tengocamello_contadora', version: 1, titulo: 'Reunión con una contadora', objetivo: 'Conocer su negocio.',
  apertura: 'Agradécele que llamó.', cierre: 'Acuerda un siguiente paso.', reglas: ['No prometas nada.'],
  secciones: [{ clave: 'negocio_hoy', titulo: 'Su negocio hoy', minutos: 10, preguntas: ['¿A qué tipo de clientes atiende?'] },
    { clave: 'tiempo', titulo: 'Dónde se le va el tiempo', minutos: 10, preguntas: ['¿Qué tareas repite?'] }] };
const ALIADO_VOZ = { perfil: 'aliado', no_cotizar: true, aliado_id: 2, nombre_saludo: 'Carmen', entrevista_id: 5, agendada_at: '2026-10-24T16:00:00.000Z',
  duracion_max_min: 40, guia: GUIA_PRUEBA };
const RESUMEN_ALIADO = { resumen_general: 'Contadora con 40 clientes.', secciones: [{ clave: 'negocio_hoy', titulo: 'Su negocio hoy', puntos: ['40 clientes'], cubierta: true }],
  siguiente_paso: 'José le escribe', fecha_siguiente_paso: null, pendientes: [], alerta: null, alerta_motivo: null };

test('aliado (2026-10-23): no cotiza, la saluda por su nombre, conduce la guía y la llamada dura lo de la política', async () => {
  // Su conversación de ventas está tomada por una persona: no impide la entrevista.
  const m = montar({ inicio: { lead_id: 249, nombre_saludo: 'Carmen', persona_al_mando: true, aliado_voz: ALIADO_VOZ }, resumenJson: RESUMEN_ALIADO });
  await m.manager.handleWebhook(firmado(eventoEntrante('rtc_ali_1'))).procesando;
  const accept = m.posts.find((p) => p.url.endsWith('/accept'));
  const nombres = accept.body.tools.map((t) => t.name);
  for (const n of ['check_availability', 'quote_stay', 'enviar_opciones_al_chat', 'anotar_lista_espera']) assert.equal(nombres.includes(n), false, n);
  assert.deepEqual(nombres.sort(), ['consultar_al_equipo', 'evaluar_uso_aceptable', 'ofrecer_paquete_magia', 'pedir_persona', 'terminar_llamada'], 'aliado: sin herramientas del PMS; consultar al equipo, filtro de uso aceptable y demo del Paquete Magia sí (2026-10-24)');
  const ins = accept.body.instructions;
  assert.match(ins, /persona ALIADA de Miu/);
  assert.match(ins, /se llama Carmen/);
  assert.match(ins, /NO cotices/);
  assert.match(ins, /1\. Su negocio hoy \(unos 10 min\)/);
  assert.match(ins, /¿A qué tipo de clientes atiende\?/);
  assert.match(ins, /como máximo 40 minutos/);
  assert.doesNotMatch(ins, /CÓMO ATENDER UNA BÚSQUEDA|INVENTARIO|persona del equipo está atendiendo/);
  // Límites: 40 min, aviso de cierre en el minuto 37 y al minuto final.
  const ms = m.pendientes.map((p) => p.ms);
  assert.ok(ms.includes(40 * 60_000) && ms.includes(37 * 60_000) && ms.includes(39 * 60_000));
  // Saludo propio con el nombre.
  FakeWs.ultima.emit('open');
  m.correr(1500);
  const saludo = FakeWs.ultima.enviados.find((e) => e.type === 'response.create');
  assert.match(saludo.response.instructions, /¡Hola, Carmen! Qué alegría que llamas/);
  assert.match(saludo.response.instructions, /se transcribe/);
  // Una herramienta comercial pedida igual no llega al PMS.
  mensaje(FakeWs.ultima, { type: 'response.done', response: { output: [{ type: 'function_call', name: 'quote_stay', call_id: 'fc_q', arguments: '{"arrival_date":"2026-11-01","nights":30}' }] } });
  await tick();
  assert.equal(m.herramientas.length, 0);
  mensaje(FakeWs.ultima, { type: 'conversation.item.input_audio_transcription.completed', transcript: 'Tengo 40 clientes' });
  mensaje(FakeWs.ultima, { type: 'response.output_audio_transcript.done', transcript: '¡Qué bien!' });
  await tick();
  m.avanzar(20 * 60_000);
  FakeWs.ultima.close();
  await tick();
  const fin = m.de('fin')[0];
  assert.equal(fin.enviar_seguimiento, false);
  assert.equal(fin.siguiente_paso, null);
  assert.equal(fin.resumen, 'Contadora con 40 clientes.');
  assert.deepEqual(fin.resumen_estructurado.secciones[0].puntos, ['40 clientes']);
  assert.equal('alerta' in fin.resumen_estructurado, false);
  assert.equal(fin.duracion_segundos, 1200);
  assert.deepEqual(m.textos, []);
  // El resumen usa las claves de la guía y admite una entrevista larga.
  const resumenPost = m.posts.find((p) => p.url.endsWith('/chat/completions'));
  assert.match(resumenPost.body.messages[0].content, /negocio_hoy: Su negocio hoy/);
  assert.equal(resumenPost.body.max_tokens, 4000);
  assert.match(resumenPost.body.messages[0].content, /Fecha de la llamada/);
});

test('aliado: llamada anterior cortada a mitad, Cami retoma sin repetir', async () => {
  const m = montar({ inicio: { aliado_voz: { ...ALIADO_VOZ, llamada_previa: { secciones_conversadas: ['Su negocio hoy'], resumen_general: 'Tiene 40 clientes.' } } } });
  await m.manager.handleWebhook(firmado(eventoEntrante('rtc_ali_prev'))).procesando;
  const ins = m.posts.find((p) => p.url.endsWith('/accept')).body.instructions;
  assert.match(ins, /LLAMADA ANTERIOR .*ya conversaron de: Su negocio hoy/);
  assert.match(ins, /Retoma desde donde quedaron/);
});

test('aliado: la transcripción admite hasta 1000 turnos (ventas sigue en 400)', async () => {
  const m = montar({ inicio: { aliado_voz: ALIADO_VOZ } });
  await m.manager.handleWebhook(firmado(eventoEntrante('rtc_ali_turnos'))).procesando;
  for (let i = 0; i < 1005; i += 1) mensaje(FakeWs.ultima, { type: 'conversation.item.input_audio_transcription.completed', transcript: `t${i}` });
  await tick();
  FakeWs.ultima.close();
  await tick();
  assert.equal(m.de('fin')[0].transcripcion.length, 1000);
});

test('aliado: la duración se acota al techo de 50 min y nunca baja de la de ventas', async () => {
  const m = montar({ inicio: { aliado_voz: { ...ALIADO_VOZ, duracion_max_min: 300 } } });
  await m.manager.handleWebhook(firmado(eventoEntrante('rtc_ali_2'))).procesando;
  assert.ok(m.pendientes.some((p) => p.ms === 50 * 60_000));
  assert.equal(m.pendientes.some((p) => p.ms > 50 * 60_000), false);
  const m2 = montar({ inicio: { aliado_voz: { ...ALIADO_VOZ, duracion_max_min: 3 } } });
  await m2.manager.handleWebhook(firmado(eventoEntrante('rtc_ali_3'))).procesando;
  assert.ok(m2.pendientes.some((p) => p.ms === 10 * 60_000));
});

test('aliado: el tope mensual se calcula con su duración (40 min x 0,06 = 2,4 USD)', async () => {
  const m = montar({ uso: 47.7, inicio: { aliado_voz: ALIADO_VOZ } });
  await m.manager.handleWebhook(firmado(eventoEntrante('rtc_ali_4'))).procesando;
  assert.equal(m.posts.some((p) => p.url.endsWith('/reject')), true, 'con 47,7 usados no caben 2,4');
  const m2 = montar({ uso: 47.5, inicio: { aliado_voz: ALIADO_VOZ } });
  await m2.manager.handleWebhook(firmado(eventoEntrante('rtc_ali_5'))).procesando;
  assert.equal(m2.posts.some((p) => p.url.endsWith('/accept')), true);
});

test('aliado_voz mal formado (sin secciones o sin no_cotizar) se ignora: perfil de siempre', async () => {
  const m = montar({ inicio: { aliado_voz: { ...ALIADO_VOZ, guia: { ...GUIA_PRUEBA, secciones: [] } } } });
  await m.manager.handleWebhook(firmado(eventoEntrante('rtc_ali_6'))).procesando;
  const accept = m.posts.find((p) => p.url.endsWith('/accept'));
  assert.ok(accept.body.tools.some((t) => t.name === 'check_availability'));
  assert.ok(m.pendientes.some((p) => p.ms === 10 * 60_000));
  const m2 = montar({ inicio: { aliado_voz: { ...ALIADO_VOZ, no_cotizar: false } } });
  await m2.manager.handleWebhook(firmado(eventoEntrante('rtc_ali_7'))).procesando;
  assert.ok(m2.posts.find((p) => p.url.endsWith('/accept')).body.tools.some((t) => t.name === 'check_availability'));
});

test('admisión: las llamadas en curso cuentan su propio máximo (enCursoUsd)', () => {
  const base = { topeUsdMes: 50, duracionMaxMin: 10, costoUsdMinuto: 0.06 };
  assert.equal(decidirAdmision({ ...base, usoMesUsd: 46, enCurso: 1, enCursoUsd: 2.4 }).admitir, true); // 46 + 2,4 + 0,6 = 49
  assert.equal(decidirAdmision({ ...base, usoMesUsd: 47.1, enCurso: 1, enCursoUsd: 2.4 }).admitir, false);
  assert.equal(decidirAdmision({ ...base, usoMesUsd: 48.8, enCurso: 0, enCursoUsd: 0 }).admitir, true);
});

test('huérfana de aliado: se cierra con su propia duración y costo', async () => {
  const m = montar({ huerfanas: [{ call_id: 'rtc_old_ali', estado: 'aceptada', duracion_max_min: 40 }] });
  assert.deepEqual(await m.manager.barrerHuerfanas(), { colgadas: 1 });
  const fin = m.de('fin')[0];
  assert.equal(fin.duracion_segundos, 2400);
  assert.equal(fin.costo_estimado_usd, 2.4);
});

// USO ACEPTABLE (José Manuel, 2026-10-24; PMS migración 930): un pedido
// prohibido o restringido en la llamada se registra en el PMS (aviso a Teo) y
// Cami recibe qué decir; nunca se ejecuta. Si el PMS no responde, igual se frena.
test('uso aceptable en la llamada: registra en el PMS, devuelve el texto y no ejecuta; respaldo si el PMS cae', async () => {
  const m = montar();
  await m.manager.handleWebhook(firmado(eventoEntrante('rtc_test_ua'))).procesando;
  const ws = FakeWs.ultima;
  mensaje(ws, { type: 'response.done', response: { output: [{ type: 'function_call', name: 'evaluar_uso_aceptable', call_id: 'fc_ua',
    arguments: JSON.stringify({ decision: 'prohibido', categoria: 'armas_explosivos', resumen: 'Pide conseguir un arma' }) }] } });
  await tick();
  assert.deepEqual(m.de('uso_aceptable'), [{ call_id: 'rtc_test_ua', decision: 'prohibido', categoria: 'armas_explosivos', resumen: 'Pide conseguir un arma' }]);
  const salida = ws.enviados.find((e) => e.type === 'conversation.item.create' && e.item?.call_id === 'fc_ua');
  const r = JSON.parse(salida.item.output);
  assert.equal(r.data.no_ejecutar, true);
  assert.equal(r.data.texto_para_decir, 'TEXTO PMS prohibido');
  assert.equal(m.herramientas.length, 0, 'no se llamó ninguna herramienta del PMS');
  m.fallarUsoAceptable();
  mensaje(ws, { type: 'response.done', response: { output: [{ type: 'function_call', name: 'evaluar_uso_aceptable', call_id: 'fc_ua2',
    arguments: JSON.stringify({ decision: 'restringido', categoria: 'empleo', resumen: 'Pide redactar un anuncio de empleo' }) }] } });
  await tick();
  const r2 = JSON.parse(ws.enviados.find((e) => e.item?.call_id === 'fc_ua2').item.output);
  assert.equal(r2.data.decision, 'restringido');
  assert.match(r2.data.texto_para_decir, /consultar primero con el equipo/);
  ws.close();
  await tick();
});

test('uso aceptable: la herramienta y la instrucción están en todos los perfiles de la llamada', () => {
  for (const opciones of [{}, { sinComerciales: true }, { aliado: true }]) {
    assert.ok(herramientasDeVoz(opciones).some((h) => h.name === 'evaluar_uso_aceptable'), JSON.stringify(opciones));
  }
  assert.match(instruccionesCamiVoz({ hoy: '2026-10-24' }), /USO ACEPTABLE/);
  assert.match(instruccionesCamiVoz({ hoy: '2026-10-24', propietariaOnboarding: true }), /USO ACEPTABLE/);
});

test('Paquete Magia (2026-10-24): Cami voz ofrece la demo, la arranca por el chat y, si el dueño de la demo llama, no cotiza', async () => {
  const m = montar();
  await m.manager.handleWebhook(firmado(eventoEntrante('rtc_magia_wh'))).procesando;
  const ws = FakeWs.ultima;
  const accept = m.posts.find((p) => p.url.endsWith('/accept'));
  assert.equal(accept.body.tools.some((t) => t.name === 'ofrecer_paquete_magia'), true);
  assert.match(accept.body.instructions, /NO ofrezcas por tu cuenta el Paquete Magia/);  // revisión P2-7: solo si la persona la pide
  mensaje(ws, { type: 'response.done', response: { output: [{ type: 'function_call', name: 'ofrecer_paquete_magia', call_id: 'fc_pm', arguments: '{}' }] } });
  await tick();
  assert.deepEqual(m.de('paquete_magia'), [{ call_id: 'rtc_magia_wh' }]);
  const out = JSON.parse(ws.enviados.find((e) => e.type === 'conversation.item.create' && e.item?.call_id === 'fc_pm').item.output);
  assert.equal(out.status, 'ok');
  assert.match(out.instruccion_modelo, /chat/);
  // PMS caído: pide escribir el texto disparador, sin prometer nada.
  m.estado.magiaFalla = true;
  mensaje(ws, { type: 'response.done', response: { output: [{ type: 'function_call', name: 'ofrecer_paquete_magia', call_id: 'fc_pm2', arguments: '{}' }] } });
  await tick();
  const out2 = JSON.parse(ws.enviados.find((e) => e.type === 'conversation.item.create' && e.item?.call_id === 'fc_pm2').item.output);
  assert.match(out2.instruccion_modelo, /Quiero probar el Paquete Magia/);
  ws.close();
  await tick();
  // El dueño de una demo abierta llama: sin herramientas comerciales ni de la demo, y sin seguimiento.
  const d = montar({ inicio: { lead_id: null, nombre_saludo: null, paquete_magia: { demo_id: 3, estado: 'activa', no_cotizar: true } }, viaFin: 'sin_caso' });
  await d.manager.handleWebhook(firmado(eventoEntrante('rtc_magia_dueno'))).procesando;
  const acc2 = d.posts.find((p) => p.url.endsWith('/accept'));
  const nombres = acc2.body.tools.map((t) => t.name);
  for (const n of ['check_availability', 'quote_stay', 'enviar_opciones_al_chat', 'anotar_lista_espera', 'ofrecer_paquete_magia']) assert.equal(nombres.includes(n), false, n);
  assert.match(acc2.body.instructions, /DEMO DEL PAQUETE MAGIA/);
  assert.doesNotMatch(acc2.body.instructions, /CÓMO ATENDER UNA BÚSQUEDA/);
  FakeWs.ultima.close();
  await tick();
  assert.equal(d.de('fin')[0].enviar_seguimiento, false);
});

test('LEAD 256 (paridad): search_commercial_knowledge recibe las noches que la llamada cotizo y el lead, no las del modelo', async () => {
  const m = montar();
  await m.manager.handleWebhook(firmado(eventoEntrante('rtc_test_256'))).procesando;
  const ws = FakeWs.ultima;
  ws.emit('open');
  // Antes de cotizar: sin noches (el PMS da la referencia aproximada o la del chat del lead).
  mensaje(ws, { type: 'response.done', response: { output: [{ type: 'function_call', name: 'search_commercial_knowledge', call_id: 'fc_a',
    arguments: JSON.stringify({ topics: ['address_disclosure'], apartment_code: null }) }] } });
  await tick();
  assert.deepEqual(m.herramientas[0].ctx, { as_of: m.herramientas[0].ctx.as_of, proposal_snapshot: null, nights: null, lead_id: 7 });
  mensaje(ws, { type: 'response.done', response: { output: [{ type: 'function_call', name: 'check_availability', call_id: 'fc_b',
    arguments: JSON.stringify({ nights: 30, arrival_date: '2026-11-30', guests: 1 }) }] } });
  await tick();
  // Las demas herramientas no cambian de contexto.
  assert.equal('nights' in m.herramientas[1].ctx, false);
  mensaje(ws, { type: 'response.done', response: { output: [{ type: 'function_call', name: 'search_commercial_knowledge', call_id: 'fc_c',
    arguments: JSON.stringify({ topics: ['address_disclosure'], apartment_code: null }) }] } });
  await tick();
  assert.equal(m.herramientas[2].ctx.nights, 30);
  assert.equal(m.herramientas[2].ctx.lead_id, 7);
  ws.close();
  await tick();
});
