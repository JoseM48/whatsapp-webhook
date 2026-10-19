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
const { herramientasDeVoz, instruccionesCamiVoz } = require('../lib/voz/cami-voz');
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
  assert.deepEqual(nombres.filter((n) => !['terminar_llamada', 'pedir_persona'].includes(n)).sort(),
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
  resumenJson = { resumen: 'Busca 30 noches.', alerta: null, alerta_motivo: null }, huerfanas = [] } = {}) {
  const posts = [], textos = [], pmsLlamadas = [], herramientas = [];
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
    vozMetaEvento: async (b) => { pmsLlamadas.push(['meta', b]); return {}; },
  };
  const timers = { setTimeout: () => 0, clearTimeout: () => {} };
  let t = Date.now();
  const manager = createVozCallManager({ config, http, WebSocketImpl: FakeWs, pms, timers, now: () => t,
    executePmsTool: async (name, args, ctx) => { herramientas.push({ name, args, ctx }); return { status: 'ok', data: { total: 1 } }; },
    sendText: async (to, body) => { textos.push({ to, body }); },
    logger: { info() {}, warn() {}, error() {} } });
  const de = (paso) => pmsLlamadas.filter((c) => c[0] === paso).map((c) => c[1]);
  return { manager, posts, textos, pmsLlamadas, herramientas, de, avanzar: (ms) => { t += ms; },
    fallarAlerta: () => { estado.alertaFalla = true; } };
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
  assert.equal(ws.enviados[0].type, 'response.create');
  mensaje(ws, { type: 'conversation.item.input_audio_transcription.completed', transcript: 'Quiero un mes desde noviembre' });
  mensaje(ws, { type: 'response.done', response: { output: [{ type: 'function_call', name: 'quote_stay', call_id: 'fc_1',
    arguments: JSON.stringify({ nights: 30, arrival_date: '2026-11-01', apartment_code: null }) }] } });
  await tick();
  assert.equal(m.herramientas[0].name, 'quote_stay');
  assert.equal(m.herramientas[0].ctx.proposal_snapshot, null);
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
  assert.deepEqual(fin.herramientas_usadas, ['quote_stay']);
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
