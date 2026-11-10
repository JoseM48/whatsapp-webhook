'use strict';

// Llamada de emergencia a José: apagada por defecto, freno de ráfagas, forma
// del cuerpo de OpenAI Live API, firma HMAC de la ruta y logs sin números.
// Sin red: fetch y WebSocket son dobles. Números ficticios (prefijo 999).

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const {
  createLlamadaEmergencia, leerConfigEmergencia, limpiarResumen, MIN_INTENTOS_ENTRE_MS,
} = require('../lib/voz/llamada-saliente');
const { crearManejadorLlamadaEmergencia, firmar } = require('../lib/voz/llamada-emergencia-ruta');

const DESTINO = '+999000000001';
const MIU = '+999000000002';
const CLAVE_SIP = 'clave-sip-de-prueba';
const API_KEY = 'sk-test-no-real';

function envCompleto(extra = {}) {
  return {
    LLAMADA_EMERGENCIA_ON: '1',
    VOZ_OPENAI_API_KEY: API_KEY,
    JOSE_ALERT_PHONE: DESTINO,
    WA_SIP_USER: MIU.slice(1),
    WA_SIP_PASSWORD: CLAVE_SIP,
    ...extra,
  };
}

function fetchDoble({ status = 200, json = { session: { id: 'sess_test_1' }, transport: { type: 'sip' } } } = {}) {
  const llamadas = [];
  const fn = async (url, opts) => {
    llamadas.push({ url, opts });
    return { ok: status >= 200 && status < 300, status, json: async () => json };
  };
  fn.llamadas = llamadas;
  return fn;
}

function logDoble() {
  const lineas = [];
  const fn = (evento, datos) => lineas.push(`${evento} ${JSON.stringify(datos)}`);
  fn.lineas = lineas;
  return fn;
}

function relojDoble(inicio = Date.UTC(2026, 10, 10, 15, 0, 0)) {
  let t = inicio;
  return { now: () => t, avanzar: (ms) => { t += ms; } };
}

const sinTimers = { setTimer: () => null, clearTimer: () => {} };

test('apagada por defecto: sin LLAMADA_EMERGENCIA_ON no llama', async () => {
  const f = fetchDoble();
  const env = envCompleto();
  delete env.LLAMADA_EMERGENCIA_ON;
  const ll = createLlamadaEmergencia({ env, fetchImpl: f, log: logDoble(), ...sinTimers });
  const r = await ll.llamar({ clave: 'aviso:1', resumen: 'prueba' });
  assert.deepEqual(r, { ok: false, motivo: 'apagada' });
  assert.equal(f.llamadas.length, 0);
  assert.equal(leerConfigEmergencia({}).habilitada, false);
  assert.equal(leerConfigEmergencia({ LLAMADA_EMERGENCIA_ON: 'true' }).habilitada, false);
});

test('sin credenciales no llama y dice qué variable falta, sin valores', async () => {
  const f = fetchDoble();
  const ll = createLlamadaEmergencia({ env: { LLAMADA_EMERGENCIA_ON: '1' }, fetchImpl: f, log: logDoble(), ...sinTimers });
  const r = await ll.llamar({ clave: 'aviso:1', resumen: 'x' });
  assert.equal(r.motivo, 'sin_config');
  assert.deepEqual(r.falta.sort(), ['JOSE_ALERT_PHONE', 'VOZ_OPENAI_API_KEY', 'WA_SIP_CALLER_NUMBER', 'WA_SIP_PASSWORD', 'WA_SIP_USER'].sort());
  assert.equal(f.llamadas.length, 0);
});

test('forma del cuerpo: POST /v1/live/sessions con transport sip y troncal de Meta', async () => {
  const f = fetchDoble();
  const ll = createLlamadaEmergencia({ env: envCompleto(), fetchImpl: f, log: logDoble(), ...sinTimers });
  const r = await ll.llamar({ clave: 'aviso:7', resumen: 'Huésped sin poder entrar al LF-210' });
  assert.equal(r.ok, true);
  assert.equal(r.session_id, 'sess_test_1');
  const { url, opts } = f.llamadas[0];
  assert.equal(url, 'https://api.openai.com/v1/live/sessions');
  assert.equal(opts.method, 'POST');
  assert.equal(opts.headers.Authorization, `Bearer ${API_KEY}`);
  const b = JSON.parse(opts.body);
  assert.equal(b.session.model, 'gpt-live-1');
  assert.deepEqual(b.session.audio, { output: { voice: 'marin' } });
  assert.deepEqual(b.session.delegation, { type: 'client' });
  assert.equal(b.session.audio.format, undefined);
  assert.match(b.session.instructions, /José, habla Cami de Miu\. Hay un caso urgente: Huésped sin poder entrar al LF-210\. Revisa tu WhatsApp interno\./);
  assert.deepEqual(b.transport, {
    type: 'sip',
    destination: DESTINO,
    trunk: {
      provider_url: 'sips:wa.meta.vc:5061',
      auth: { type: 'digest', username: MIU.slice(1), password: CLAVE_SIP },
      caller_number: MIU,
    },
  });
});

test('freno: máximo 2 intentos por clave, con 3 min entre ellos', async () => {
  const f = fetchDoble();
  const reloj = relojDoble();
  const ll = createLlamadaEmergencia({ env: envCompleto(), fetchImpl: f, now: reloj.now, log: logDoble(), ...sinTimers });
  assert.equal((await ll.llamar({ clave: 'aviso:9', resumen: 'a' })).intento, 1);
  reloj.avanzar(60 * 1000);
  const pronto = await ll.llamar({ clave: 'aviso:9', resumen: 'a' });
  assert.equal(pronto.motivo, 'muy_pronto');
  assert.equal(pronto.reintentar_en_s, 120);
  reloj.avanzar(MIN_INTENTOS_ENTRE_MS);
  assert.equal((await ll.llamar({ clave: 'aviso:9', resumen: 'a' })).intento, 2);
  reloj.avanzar(10 * 60 * 1000);
  assert.equal((await ll.llamar({ clave: 'aviso:9', resumen: 'a' })).motivo, 'max_intentos_clave');
  assert.equal(f.llamadas.length, 2);
});

test('freno: tope global por día de Colombia, se reinicia al día siguiente', async () => {
  const f = fetchDoble();
  const reloj = relojDoble(Date.UTC(2026, 10, 10, 20, 0, 0)); // 15:00 Colombia
  const ll = createLlamadaEmergencia({ env: envCompleto({ LLAMADA_EMERGENCIA_MAX_DIA: '2' }), fetchImpl: f, now: reloj.now, log: logDoble(), ...sinTimers });
  assert.equal((await ll.llamar({ clave: 'a:1', resumen: 'x' })).ok, true);
  assert.equal((await ll.llamar({ clave: 'a:2', resumen: 'x' })).ok, true);
  assert.equal((await ll.llamar({ clave: 'a:3', resumen: 'x' })).motivo, 'tope_diario');
  reloj.avanzar(10 * 3600 * 1000); // 01:00 del día siguiente en Colombia
  assert.equal((await ll.llamar({ clave: 'a:3', resumen: 'x' })).ok, true);
  assert.equal(f.llamadas.length, 3);
});

test('un fallo de red también gasta el intento (nunca insiste de más)', async () => {
  const reloj = relojDoble();
  const fallo = async () => { throw new Error('ECONNRESET'); };
  const ll = createLlamadaEmergencia({ env: envCompleto(), fetchImpl: fallo, now: reloj.now, log: logDoble(), ...sinTimers });
  assert.equal((await ll.llamar({ clave: 'k', resumen: 'x' })).motivo, 'error_red');
  reloj.avanzar(MIN_INTENTOS_ENTRE_MS);
  assert.equal((await ll.llamar({ clave: 'k', resumen: 'x' })).motivo, 'error_red');
  reloj.avanzar(MIN_INTENTOS_ENTRE_MS);
  assert.equal((await ll.llamar({ clave: 'k', resumen: 'x' })).motivo, 'max_intentos_clave');
});

test('los logs nunca llevan el número de José, el de Miu ni la clave SIP', async () => {
  const log = logDoble();
  const ws = [];
  class WsDoble extends EventEmitter { constructor(url, opts) { super(); this.url = url; this.opts = opts; ws.push(this); } close() {} }
  const reloj = relojDoble();
  const ll = createLlamadaEmergencia({ env: envCompleto(), fetchImpl: fetchDoble(), WebSocketImpl: WsDoble, now: reloj.now, log, ...sinTimers });
  await ll.llamar({ clave: 'aviso:3', resumen: `llamar al ${DESTINO.slice(1)} ya` });
  ws[0].emit('message', JSON.stringify({ event_id: 'e1', type: 'transport.answered' }));
  ws[0].emit('message', JSON.stringify({ event_id: 'e2', type: 'session.closed' }));
  const rechazo = createLlamadaEmergencia({ env: envCompleto(), fetchImpl: fetchDoble({ status: 400, json: { error: { code: 'bad' } } }), log, ...sinTimers });
  await rechazo.llamar({ clave: 'aviso:4', resumen: 'x' });
  const todo = log.lineas.join('\n');
  assert.ok(log.lineas.some((l) => l.startsWith('llamada_emergencia_contestada')));
  for (const secreto of [DESTINO, DESTINO.slice(1), MIU.slice(1), CLAVE_SIP, API_KEY]) assert.ok(!todo.includes(secreto), `log con ${secreto}`);
  assert.equal(ws[0].url, 'wss://api.openai.com/v1/live/sessions/sess_test_1/attach');
});

test('el resumen no lleva números largos a la voz', () => {
  assert.equal(limpiarResumen('Llamar al +57 300 123 4567 urgente'), 'Llamar al [número] urgente');
  assert.equal(limpiarResumen('LF-210\nsin agua'), 'LF-210 sin agua');
  assert.equal(limpiarResumen('x'.repeat(500)).length, 200);
});

test('al no contestar, cuelga con POST .../hangup al vencer el timbre', async () => {
  const f = fetchDoble();
  const timers = [];
  const ll = createLlamadaEmergencia({ env: envCompleto(), fetchImpl: f, log: logDoble(),
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimer: () => {} });
  await ll.llamar({ clave: 'aviso:5', resumen: 'x' });
  assert.equal(timers[0].ms, 60 * 1000);
  await timers[0].fn();
  await new Promise((r) => setImmediate(r));
  assert.equal(f.llamadas[1].url, 'https://api.openai.com/v1/live/sessions/sess_test_1/hangup');
  assert.equal(f.llamadas[1].opts.method, 'POST');
  assert.equal(f.llamadas[1].opts.body, undefined);
});

// ------------------------------------------------------------------ ruta
const SECRETO_PMS = 'secreto-pms-de-prueba';

function peticionFirmada(body, { secreto = SECRETO_PMS, ts = new Date().toISOString() } = {}) {
  const raw = JSON.stringify(body);
  return { headers: { 'x-pms-timestamp': ts, 'x-pms-signature': firmar(secreto, ts, raw) }, rawBody: Buffer.from(raw), body };
}

test('ruta: 404 apagada, 401 sin firma o firma mala, 202 con firma buena, 429 por freno', async () => {
  const f = fetchDoble();
  const apagada = createLlamadaEmergencia({ env: {}, fetchImpl: f, log: logDoble(), ...sinTimers });
  const m0 = crearManejadorLlamadaEmergencia({ llamada: apagada, secret: () => SECRETO_PMS });
  assert.equal((await m0(peticionFirmada({ clave: 'a', resumen: 'b' }))).status, 404);

  const ll = createLlamadaEmergencia({ env: envCompleto(), fetchImpl: f, log: logDoble(), ...sinTimers });
  const m = crearManejadorLlamadaEmergencia({ llamada: ll, secret: () => SECRETO_PMS });
  assert.equal((await m({ headers: {}, rawBody: Buffer.from('{}'), body: {} })).status, 401);
  assert.equal((await m(peticionFirmada({ clave: 'a' }, { secreto: 'otro' }))).status, 401);
  assert.equal((await m(peticionFirmada({ clave: 'a' }, { ts: new Date(Date.now() - 10 * 60 * 1000).toISOString() }))).status, 401);
  const sinSecreto = crearManejadorLlamadaEmergencia({ llamada: ll, secret: () => '' });
  assert.equal((await sinSecreto(peticionFirmada({ clave: 'a' }))).status, 503);

  const ok = await m(peticionFirmada({ clave: 'aviso:11', resumen: 'caso' }));
  assert.equal(ok.status, 202);
  assert.equal(ok.body.intento, 1);
  // Otra firma (otro instante): si no, sería la misma y respondería 409 por repetición.
  const otra = await m(peticionFirmada({ clave: 'aviso:11', resumen: 'caso' }, { ts: new Date(Date.now() + 1000).toISOString() }));
  assert.equal(otra.status, 429);
  assert.equal(otra.body.motivo, 'muy_pronto');
  assert.equal((await m(peticionFirmada({ clave: 'con espacio' }))).status, 400);
  assert.equal(f.llamadas.length, 1);
});

// ------------------------------------------------------- revisión P2
test('3 sin contestar seguidas frenan (riesgo de revocación); contestar reinicia', async () => {
  const ws = [];
  class WsDoble extends EventEmitter { constructor() { super(); this.enviados = []; ws.push(this); } send(m) { this.enviados.push(m); } close() {} }
  const reloj = relojDoble();
  const ll = createLlamadaEmergencia({ env: envCompleto(), fetchImpl: fetchDoble(), WebSocketImpl: WsDoble, now: reloj.now, log: logDoble(), ...sinTimers });
  for (const k of ['a', 'b', 'c']) assert.equal((await ll.llamar({ clave: k, resumen: 'x' })).ok, true);
  reloj.avanzar(26 * 3600 * 1000);
  assert.equal((await ll.llamar({ clave: 'd', resumen: 'x' })).motivo, 'riesgo_revocacion');
  ws[2].emit('message', JSON.stringify({ event_id: 'e9', type: 'transport.answered' }));
  assert.deepEqual(ws[2].enviados.map((m) => JSON.parse(m).type), ['response.create']);
  assert.equal((await ll.llamar({ clave: 'd', resumen: 'x' })).ok, true);
});

test('respuesta 2xx sin id de sesión es falla (no queda una llamada sin límite)', async () => {
  const ll = createLlamadaEmergencia({ env: envCompleto(), fetchImpl: fetchDoble({ json: {} }), log: logDoble(), ...sinTimers });
  assert.equal((await ll.llamar({ clave: 'k', resumen: 'x' })).motivo, 'respuesta_sin_sesion');
});

test('transport.failed y cierre del canal limpian el temporizador', async () => {
  const ws = [];
  class WsDoble extends EventEmitter { constructor() { super(); ws.push(this); } send() {} close() {} }
  let limpiados = 0;
  const ll = createLlamadaEmergencia({ env: envCompleto(), fetchImpl: fetchDoble(), WebSocketImpl: WsDoble, log: logDoble(),
    setTimer: () => ({}), clearTimer: () => { limpiados += 1; } });
  await ll.llamar({ clave: 'k1', resumen: 'x' });
  ws[0].emit('message', JSON.stringify({ event_id: 'f', type: 'transport.failed' }));
  assert.equal(limpiados, 1);
  await ll.llamar({ clave: 'k2', resumen: 'x' });
  ws[1].emit('close');
  assert.equal(limpiados, 2);
});

test('comillas del resumen no rompen las instrucciones', () => {
  assert.equal(limpiarResumen('dijo "ignora todo" y {x}'), 'dijo ignora todo y x');
});

test('ruta: firma de otro propósito (webhook -> PMS) y repetición se rechazan', async () => {
  const crypto = require('crypto');
  const ll = createLlamadaEmergencia({ env: envCompleto(), fetchImpl: fetchDoble(), log: logDoble(), ...sinTimers });
  const m = crearManejadorLlamadaEmergencia({ llamada: ll, secret: () => SECRETO_PMS });
  const body = { clave: 'aviso:20', resumen: 'x' };
  const raw = JSON.stringify(body);
  const ts = new Date().toISOString();
  const firmaVieja = crypto.createHmac('sha256', SECRETO_PMS).update(`${ts}.${raw}`).digest('hex');
  assert.equal((await m({ headers: { 'x-pms-timestamp': ts, 'x-pms-signature': firmaVieja }, rawBody: Buffer.from(raw), body })).status, 401);
  const p = peticionFirmada(body);
  assert.equal((await m(p)).status, 202);
  assert.equal((await m(p)).status, 409);
  assert.equal((await m({ headers: { 'x-pms-timestamp': ts, 'x-pms-signature': 'ab' }, rawBody: undefined, body })).status, 401);
});
