'use strict';

// REENVÍO DE NÚMEROS A OTRO SERVICIO (2026-11-07; "fincas demo" de TenGo Camello).
// Ids, teléfonos, URL y secreto FALSOS.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { leerConfigReenvio, configReenvioParaLog, separarReenvios, firmar, enviarReenvios, despacharReenvios, crearPostAxios } = require('../lib/pilot/reenvio-numeros');
const { separarPorNumero } = require('../lib/pilot/numero-entrante');
const { readVozConfig } = require('../lib/voz/config');
const { parseOpenAiCallIncoming } = require('../lib/voz/call-events');
const { createVozCallManager } = require('../lib/voz/call-manager');

const MIU = '100000000000001';
const TC = '200000000000002';
const DEMO = '400000000000004';
const FINCAS = '500000000000005';
const OTRO = '300000000000003';
const URL_FINCAS = 'https://fincas-demo.example.workers.dev/wa/inbound';
const SECRETO = 'secreto-de-prueba-0123456789';
const TEXTO = 'MENSAJE-PRIVADO-XYZ';
const TELEFONO = '573009998877';

const env = (extra = {}) => ({ PHONE_NUMBER_ID: MIU, TENGOCAMELLO_PHONE_NUMBER_ID: TC, REENVIO_SECRETO: SECRETO,
  REENVIO_NUMEROS_JSON: JSON.stringify({ [FINCAS]: { url: URL_FINCAS, nombre: 'fincas-demo' } }), ...extra });
const PROT = [MIU, TC, DEMO];

function cambio(phoneNumberId, { field = 'messages', statuses = null, calls = null } = {}) {
  const value = { messaging_product: 'whatsapp', metadata: { phone_number_id: phoneNumberId, display_phone_number: '570000000000' } };
  if (statuses) value.statuses = statuses;
  else if (calls) value.calls = calls;
  else {
    value.contacts = [{ wa_id: TELEFONO, profile: { name: 'Prueba' } }];
    value.messages = [{ from: TELEFONO, id: 'wamid.TEST1', timestamp: '1762500000', type: 'text', text: { body: TEXTO } }];
  }
  return { field, value };
}
const cuerpo = (...changes) => ({ object: 'whatsapp_business_account', entry: [{ id: 'waba-1', changes }] });

function logger() {
  const lineas = [];
  const f = (nivel) => (msg, datos) => lineas.push({ nivel, msg, datos });
  return { lineas, info: f('info'), warn: f('warn'), error: f('error'), texto: () => JSON.stringify(lineas) };
}

// ---------- configuración ----------

test('config válida: activa con su id, nombre y URL', () => {
  const cfg = leerConfigReenvio(env(), { protegidos: PROT });
  assert.equal(cfg.activo, true);
  assert.deepEqual([...cfg.destinos.keys()], [FINCAS]);
  assert.equal(cfg.destinos.get(FINCAS).nombre, 'fincas-demo');
  assert.equal(cfg.destinos.get(FINCAS).url, URL_FINCAS);
  const log = JSON.stringify(configReenvioParaLog(cfg));
  assert.ok(!log.includes(SECRETO) && !log.includes('workers.dev'));
});

test('config ausente o inválida: apagado con su motivo', () => {
  const casos = [
    [{ REENVIO_NUMEROS_JSON: '' }, 'sin_variable'],
    [{ REENVIO_SECRETO: '' }, 'sin_secreto'],
    [{ REENVIO_SECRETO: 'corto' }, 'sin_secreto'],
    [{ REENVIO_NUMEROS_JSON: '{no es json' }, 'json_invalido'],
    [{ REENVIO_NUMEROS_JSON: '[]' }, 'json_no_es_objeto'],
    [{ REENVIO_NUMEROS_JSON: '{}' }, 'lista_vacia'],
    [{ REENVIO_NUMEROS_JSON: JSON.stringify({ abc: { url: URL_FINCAS } }) }, 'id_invalido'],
    [{ REENVIO_NUMEROS_JSON: JSON.stringify({ [FINCAS]: { url: 'http://inseguro.example/x' } }) }, 'url_invalida'],
    [{ REENVIO_NUMEROS_JSON: JSON.stringify({ [FINCAS]: { url: 'no-url' } }) }, 'url_invalida'],
    [{ REENVIO_NUMEROS_JSON: JSON.stringify({ [FINCAS]: 'x' }) }, 'destino_invalido'],
  ];
  for (const [extra, motivo] of casos) {
    const cfg = leerConfigReenvio(env(extra), { protegidos: PROT });
    assert.equal(cfg.activo, false, motivo);
    assert.equal(cfg.motivo, motivo);
    assert.equal(cfg.destinos.size, 0);
  }
});

test('config: un id de Miu, TenGo o el demo apaga TODO (nunca se desvía uno de ellos)', () => {
  for (const id of PROT) {
    const cfg = leerConfigReenvio(env({ REENVIO_NUMEROS_JSON: JSON.stringify({ [FINCAS]: { url: URL_FINCAS }, [id]: { url: URL_FINCAS } }) }), { protegidos: PROT });
    assert.equal(cfg.activo, false);
    assert.equal(cfg.motivo, 'id_protegido');
  }
});

test('apagado: el cuerpo sigue IDÉNTICO (misma referencia) y nada se envía', async () => {
  const body = cuerpo(cambio(FINCAS), cambio(MIU));
  let llamadas = 0;
  const r = despacharReenvios(body, leerConfigReenvio(env({ REENVIO_SECRETO: '' }), { protegidos: PROT }), { post: async () => { llamadas += 1; } });
  assert.equal(r.body, body);
  assert.equal(r.reenviados, 0);
  await r.promesa;
  assert.equal(llamadas, 0);
  // Y el número sigue siendo desconocido para el ruteo de hoy (se ignora, como antes).
  assert.equal(separarPorNumero(r.body, { miuId: MIU, tengoId: TC }).desconocidos, 1);
});

// ---------- separación ----------

test('reenviado vs. no: Miu queda intacto (misma referencia); el número de la lista sale entero', () => {
  const destinos = leerConfigReenvio(env(), { protegidos: PROT }).destinos;
  const soloMiu = cuerpo(cambio(MIU));
  const a = separarReenvios(soloMiu, destinos);
  assert.equal(a.body, soloMiu);
  assert.equal(a.reenvios.length, 0);

  const ch = cambio(FINCAS);
  const b = separarReenvios(cuerpo(ch), destinos);
  assert.equal(b.body, null);
  assert.equal(b.reenvios.length, 1);
  assert.deepEqual(b.reenvios[0].payload, { object: 'whatsapp_business_account', entry: [{ id: 'waba-1', changes: [ch] }] });
  assert.equal(b.reenvios[0].url, URL_FINCAS);
});

test('cuerpo mixto: Miu, TenGo y desconocido siguen su camino; el reenviado no llega a ninguno', () => {
  const destinos = leerConfigReenvio(env(), { protegidos: PROT }).destinos;
  const miu = cambio(MIU), tc = cambio(TC), fincas = cambio(FINCAS), estado = cambio(FINCAS, { field: 'messages', statuses: [{ id: 'wamid.S', status: 'delivered', recipient_id: TELEFONO }] }), otro = cambio(OTRO);
  const body = { object: 'whatsapp_business_account', entry: [{ id: 'waba-1', changes: [miu, fincas, tc] }, { id: 'waba-2', changes: [estado, otro] }] };
  const r = separarReenvios(body, destinos);
  assert.equal(r.reenvios.length, 2, 'mensaje y estado del número reenviado');
  assert.deepEqual(r.reenvios.map((x) => x.payload.entry[0].id), ['waba-1', 'waba-2']);
  assert.deepEqual(r.body.entry.map((e) => e.changes), [[miu, tc], [otro]]);
  const ruteo = separarPorNumero(r.body, { miuId: MIU, tengoId: TC, equiposIds: new Set([FINCAS]) });
  assert.deepEqual(ruteo.miuBody.entry.map((e) => e.changes), [[miu]]);
  assert.deepEqual(ruteo.tengoChanges, [tc]);
  assert.equal(ruteo.equiposChanges.length, 0, 'aunque Equipos lo listara, el reenvío manda');
  assert.equal(ruteo.desconocidos, 1);
  // El cuerpo original no se modifica.
  assert.equal(body.entry[0].changes.length, 3);
});

test('llamadas (field calls) del número reenviado también se reenvían', () => {
  const destinos = leerConfigReenvio(env(), { protegidos: PROT }).destinos;
  const r = separarReenvios(cuerpo(cambio(FINCAS, { field: 'calls', calls: [{ id: 'wacid.X', event: 'connect' }] })), destinos);
  assert.equal(r.reenvios.length, 1);
  assert.equal(r.reenvios[0].campo, 'calls');
  assert.equal(r.body, null);
});

// ---------- envío ----------

test('HMAC: X-Forward-Signature = sha256=<hex HMAC-SHA256 del cuerpo crudo enviado>', async () => {
  const enviados = [];
  const r = despacharReenvios(cuerpo(cambio(FINCAS)), leerConfigReenvio(env(), { protegidos: PROT }),
    { post: async (url, raw, opts) => { enviados.push({ url, raw, opts }); return { status: 200 }; }, logger: logger() });
  await r.promesa;
  assert.equal(enviados.length, 1);
  const { url, raw, opts } = enviados[0];
  assert.equal(url, URL_FINCAS);
  assert.equal(typeof raw, 'string');
  const esperado = `sha256=${crypto.createHmac('sha256', SECRETO).update(raw).digest('hex')}`;
  assert.equal(opts.headers['X-Forward-Signature'], esperado);
  assert.equal(firmar(raw, SECRETO), esperado);
  assert.equal(opts.headers['Content-Type'], 'application/json');
  assert.equal(opts.timeout, 5000);
  assert.deepEqual(JSON.parse(raw).entry[0].changes[0].value.messages[0].text.body, TEXTO, 'el Worker recibe el mensaje completo');
});

test('crearPostAxios: el cuerpo viaja sin re-serializar y sin redirecciones', async () => {
  let visto;
  const post = crearPostAxios({ post: async (url, data, cfg) => { visto = { url, data, cfg }; return { status: 200 }; } });
  await post(URL_FINCAS, '{"a":1}', { headers: { x: 1 }, timeout: 5000 });
  assert.equal(visto.data, '{"a":1}');
  assert.equal(visto.cfg.transformRequest[0]('{"a":1}'), '{"a":1}');
  assert.equal(visto.cfg.maxRedirects, 0);
  assert.equal(visto.cfg.timeout, 5000);
  assert.equal(visto.cfg.validateStatus(302), false);
});

test('falla de red: 1 reintento; 4xx: sin reintento; nunca lanza', async () => {
  let n = 0;
  const red = await enviarReenvios(separarReenvios(cuerpo(cambio(FINCAS)), leerConfigReenvio(env(), { protegidos: PROT }).destinos).reenvios,
    { secreto: SECRETO, logger: logger(), post: async () => { n += 1; throw Object.assign(new Error('x'), { code: 'ECONNRESET' }); } });
  assert.equal(n, 2);
  assert.equal(red[0].ok, false);

  n = 0;
  const segundo = await enviarReenvios(separarReenvios(cuerpo(cambio(FINCAS)), leerConfigReenvio(env(), { protegidos: PROT }).destinos).reenvios,
    { secreto: SECRETO, logger: logger(), post: async () => { n += 1; if (n === 1) throw Object.assign(new Error('x'), { response: { status: 503 } }); return { status: 200 }; } });
  assert.equal(n, 2);
  assert.equal(segundo[0].ok, true);

  n = 0;
  const cuatro = await enviarReenvios(separarReenvios(cuerpo(cambio(FINCAS)), leerConfigReenvio(env(), { protegidos: PROT }).destinos).reenvios,
    { secreto: SECRETO, logger: logger(), post: async () => { n += 1; throw Object.assign(new Error('x'), { response: { status: 401 } }); } });
  assert.equal(n, 1);
  assert.equal(cuatro[0].http_status, 401);
});

test('timeout: despachar es síncrono (no espera) y un destino colgado termina en ~timeout x 2 sin lanzar', async () => {
  let llamadas = 0;
  const t0 = Date.now();
  const r = despacharReenvios(cuerpo(cambio(MIU), cambio(FINCAS)), leerConfigReenvio(env(), { protegidos: PROT }),
    { post: () => { llamadas += 1; return new Promise(() => {}); }, logger: logger(), timeoutMs: 40 });
  assert.ok(Date.now() - t0 < 30, 'devuelve de inmediato');
  assert.equal(r.reenviados, 1);
  assert.equal(r.body.entry[0].changes.length, 1, 'Miu sigue sin esperar');
  const res = await r.promesa;
  assert.equal(llamadas, 2);
  assert.equal(res[0].ok, false);
  assert.ok(Date.now() - t0 < 1000);
});

test('logs: sin texto del mensaje, sin teléfonos, sin URL ni secreto', async () => {
  for (const post of [async () => ({ status: 200 }), async () => { throw Object.assign(new Error(`fallo ${TEXTO} ${TELEFONO}`), { code: 'ECONNREFUSED' }); }]) {
    const log = logger();
    const r = despacharReenvios(cuerpo(cambio(FINCAS), cambio(FINCAS, { statuses: [{ id: 'wamid.S', status: 'read', recipient_id: TELEFONO }] })),
      leerConfigReenvio(env(), { protegidos: PROT }), { post, logger: log });
    await r.promesa;
    const t = log.texto();
    assert.ok(log.lineas.length >= 2);
    for (const prohibido of [TEXTO, TELEFONO, SECRETO, 'workers.dev', 'Prueba']) assert.ok(!t.includes(prohibido), prohibido);
    assert.ok(t.includes(FINCAS) && t.includes('fincas-demo'));
  }
});

// ---------- index.js ----------

test('index.js: la firma de Meta se valida antes del reenvío; el reenvío no se espera y va antes del ruteo', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  const firma = src.indexOf("signatureHeader: req.get('X-Hub-Signature-256')");
  const reenvio = src.indexOf('despacharReenvios(req.body, REENVIO');
  const ruteo = src.indexOf('separarPorNumero(cuerpoEntrante');
  assert.ok(firma > 0 && reenvio > firma && ruteo > reenvio);
  assert.ok(!/await\s+despacharReenvios/.test(src));
  assert.ok(!/await\s+reenvio\.promesa/.test(src));
  assert.equal((src.match(/separarPorNumero\(req\.body/g) || []).length, 0, 'el ruteo ya no ve el cuerpo original');
});

// ---------- llamadas ----------

test('llamada a un número reenviado: se rechaza sin PMS, sin Cami y sin WhatsApp (aunque Equipos tenga lista)', async () => {
  const posts = [], pmsL = [], textos = [];
  const config = readVozConfig({ VOZ_LLAMADAS_HABILITADAS: 'true', VOZ_OPENAI_API_KEY: 'sk-test-no-real', ...env() });
  assert.deepEqual(config.reenvioPhoneNumberIds, [FINCAS]);
  const silencio = { info() {}, warn() {}, error() {} };
  const manager = createVozCallManager({ config, http: { post: async (url, body) => { posts.push({ url, body }); return { data: {} }; } },
    WebSocketImpl: class {}, logger: silencio, timers: { setTimeout: () => 0, clearTimeout: () => {} },
    pms: new Proxy({}, { get: (_, k) => async (b) => { pmsL.push([k, b]); return { uso_mes_usd: 0 }; } }),
    executePmsTool: async () => { throw new Error('no'); },
    sendText: async (to, b) => { textos.push(b); }, sendImage: async () => {}, sendTextTengo: async (to, b) => { textos.push(b); },
    sendTextEquipos: async (id, to, b) => { textos.push(b); },
    numerosEquipos: { ids: () => new Set(['999999999999']), refrescarSiVencio: async () => new Set(['999999999999']) } });
  const entrada = parseOpenAiCallIncoming({ type: 'realtime.call.incoming', data: { call_id: 'rtc_fincas_1', sip_headers: [
    { name: 'From', value: `<sip:+${TELEFONO}@sip.example>` }, { name: 'To', value: '<sip:+570000000000@sip.example>' },
    { name: 'x-wa-meta-phone-number-id', value: FINCAS }] } });
  await manager._interno.atender(entrada);
  assert.ok(posts.some((p) => p.url.endsWith('/realtime/calls/rtc_fincas_1/reject')));
  assert.equal(posts.some((p) => p.url.endsWith('/accept')), false);
  assert.deepEqual(pmsL, []);
  assert.deepEqual(textos, []);
});

test('llamadas: sin configuración de reenvío la lista queda vacía', () => {
  assert.deepEqual(readVozConfig({ PHONE_NUMBER_ID: MIU }).reenvioPhoneNumberIds, []);
  assert.deepEqual(readVozConfig({ ...env(), REENVIO_SECRETO: '' }).reenvioPhoneNumberIds, []);
});
