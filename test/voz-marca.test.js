'use strict';

// Llamadas al número de una MARCA (Quedó Bien, 2026-11-11; PMS voz.routes.js de
// reparaciones, migración 1207). Se reconoce por x-wa-meta-phone-number-id contra la
// lista de marcas del PMS. Sin Miu ni Equipos. Números FALSOS.
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { readVozConfig } = require('../lib/voz/config');
const { parseOpenAiCallIncoming } = require('../lib/voz/call-events');
const { createVozCallManager } = require('../lib/voz/call-manager');
const { herramientasMarcaVoz, instruccionesCamiMarcaVoz, marcaDesdeInicio, presentacionMarca } = require('../lib/voz/cami-voz');

const NUMERO_QB = '777000111', NUMERO_EQ = '1344955112042642', MIU = '11111111', TC = '22222222';
const QUIEN = '573000000952';
class FakeWs extends EventEmitter {
  constructor(url, opts) { super(); this.url = url; this.opts = opts; this.readyState = 1; this.enviados = []; FakeWs.ultima = this; }
  send(t) { this.enviados.push(JSON.parse(t)); }
  close() { this.readyState = 3; this.emit('close'); }
}
const entrada = (callId = 'rtc_qb_1', destino = NUMERO_QB) => parseOpenAiCallIncoming({ type: 'realtime.call.incoming', data: { call_id: callId, sip_headers: [
  { name: 'From', value: `<sip:+${QUIEN}@sip.example>` }, { name: 'To', value: '<sip:+573000009999@sip.example>' }, { name: 'X-WA-Meta-Wacid', value: 'wacid.QB' },
  ...(destino ? [{ name: 'x-wa-meta-phone-number-id', value: destino }] : [])] } });

const MARCA_OK = { atender: true, duracion_max_min: 10, marca_nombre: 'Quedó Bien', asistente: null, responsable: 'Oscar', voz: 'cedar', personalidad: 'Amable y práctica.',
  saludo: null, zonas: ['Laureles', 'Belén'], cliente_nombre: null, trabajos: [], texto_tope: 'Ahora no podemos contestar. Escríbanos por aquí.' };

function montar({ marca = MARCA_OK, uso = 0, listaMarca = [NUMERO_QB], marcaCargada = true, pmsFalla = false, herramienta = null, fin = { seguimiento_texto: 'Quedó registrado su trabajo QB-0001.' } } = {}) {
  const posts = [], textos = [], textosMiu = [], textosEq = [], pmsL = [];
  const config = readVozConfig({ VOZ_LLAMADAS_HABILITADAS: 'true', VOZ_OPENAI_API_KEY: 'sk-test-no-real', PHONE_NUMBER_ID: MIU, TENGOCAMELLO_PHONE_NUMBER_ID: TC });
  const http = { post: async (url, body) => { posts.push({ url, body });
    if (url.endsWith('/chat/completions')) return { data: { choices: [{ message: { content: JSON.stringify({ resumen: 'Goteo en Laureles; visita agendada.', alerta: null, alerta_motivo: null }) } }] } };
    return { data: {} }; } };
  const pms = {
    vozInicio: async (b) => { pmsL.push(['vozInicio', b]); return { llamada_id: 9, uso_mes_usd: 0 }; },
    vozEstado: async (b) => { pmsL.push(['vozEstado', b]); return {}; },
    vozFin: async (b) => { pmsL.push(['vozFin', b]); return {}; },
    vozAlerta: async (b) => { pmsL.push(['vozAlerta', b]); return {}; },
    post: async (ruta, b) => { pmsL.push([ruta, b]);
      if (pmsFalla) throw new Error('down');
      if (ruta === '/api/marcas/voz/inicio') return { llamada_id: 9, uso_mes_usd: uso, marca };
      if (ruta === '/api/marcas/voz/estado') return { estado: b.estado };
      if (ruta === '/api/marcas/voz/fin') return fin;
      if (ruta === '/api/marcas/voz/herramienta') return herramienta ? herramienta(b) : { status: 'ok', data: { numero: 'QB-0001' }, instruccion_modelo: 'Dígale que quedó como QB-0001.' };
      return {}; },
  };
  const pendientes = [];
  const timers = { setTimeout: (fn, ms) => { pendientes.push({ fn, ms }); return pendientes.length; }, clearTimeout: () => {} };
  const silencio = { info() {}, warn() {}, error() {} };
  const manager = createVozCallManager({ config, http, WebSocketImpl: FakeWs, pms, timers, logger: silencio, executePmsTool: async () => { throw new Error('nada del PMS de Miu'); },
    sendText: async (to, body) => { textosMiu.push({ to, body }); }, sendImage: async () => {},
    sendTextEquipos: async (id, to, body) => { textosEq.push({ id, to, body }); },
    numerosEquipos: { ids: () => new Set([NUMERO_EQ]), refrescarSiVencio: async () => new Set([NUMERO_EQ]) },
    sendTextMarca: async (id, to, body) => { textos.push({ id, to, body }); },
    numerosMarca: { ids: () => new Set(listaMarca), refrescarSiVencio: async () => new Set(listaMarca), cargada: () => marcaCargada } });
  const de = (ruta) => pmsL.filter((c) => c[0] === ruta).map((c) => c[1]);
  return { manager, posts, textos, textosMiu, textosEq, pmsL, de, pendientes };
}

test('marca: se reconoce por el phone_number_id, guion y voz propios, sus herramientas y nada de Miu', async () => {
  const m = montar();
  await m.manager._interno.atender(entrada());
  const ini = m.de('/api/marcas/voz/inicio')[0];
  assert.equal(ini.phone_number_id, NUMERO_QB);
  assert.equal(m.de('vozInicio').length, 0);
  const accept = m.posts.find((p) => p.url.endsWith('/accept'));
  assert.ok(accept);
  assert.equal(accept.body.audio.output.voice, 'cedar');
  assert.match(accept.body.instructions, /Quedó Bien/);
  assert.match(accept.body.instructions, /USTED/);
  assert.match(accept.body.instructions, /NUNCA diga un precio/);
  assert.match(accept.body.instructions, /Amable y práctica/);
  assert.doesNotMatch(accept.body.instructions, /Miu|alojamiento disponible|TenGo Camello/);
  assert.deepEqual(accept.body.tools.map((t) => t.name).sort(), ['agendar_visita', 'cancelar_visita', 'enviar_enlace_pago', 'pedir_persona', 'registrar_garantia_reclamo',
    'terminar_llamada', 'tomar_dano', 'ver_cotizacion', 'ver_horarios_visita']);
  assert.deepEqual(m.de('/api/marcas/voz/estado').map((e) => e.estado), ['aceptada']);
  assert.ok(m.pendientes.some((p) => p.ms === 10 * 60_000));
});

test('una voz que no existe en Realtime no se usa: queda la de siempre', async () => {
  const m = montar({ marca: { ...MARCA_OK, voz: 'inventada' } });
  await m.manager._interno.atender(entrada());
  const accept = m.posts.find((p) => p.url.endsWith('/accept'));
  assert.notEqual(accept.body.audio.output.voice, 'inventada');
});

test('voz apagada (por defecto): se rechaza con la línea del PMS desde el número de la marca, nunca por Miu', async () => {
  const m = montar({ marca: { atender: false, motivo: 'voz_apagada', texto: 'Por ahora no contestamos llamadas. Escríbanos por aquí.' } });
  await m.manager._interno.atender(entrada());
  assert.ok(m.posts.some((p) => p.url.endsWith('/reject')));
  assert.equal(m.posts.some((p) => p.url.endsWith('/accept')), false);
  assert.deepEqual(m.textos, [{ id: NUMERO_QB, to: QUIEN, body: 'Por ahora no contestamos llamadas. Escríbanos por aquí.' }]);
  assert.deepEqual(m.textosMiu, []);
  assert.deepEqual(m.textosEq, []);
  assert.equal(m.de('/api/marcas/voz/estado')[0].motivo, 'voz_apagada');
});

test('sin PMS se rechaza en silencio; con el tope mensual gastado también, con su línea', async () => {
  const m = montar({ pmsFalla: true });
  await m.manager._interno.atender(entrada());
  assert.ok(m.posts.some((p) => p.url.endsWith('/reject')));
  assert.deepEqual(m.textos, []);
  const t = montar({ uso: 1e6 });
  await t.manager._interno.atender(entrada());
  assert.ok(t.posts.some((p) => p.url.endsWith('/reject')));
  assert.equal(t.textos[0].body, MARCA_OK.texto_tope);
});

test('un número que no es de marca sigue a Equipos o a Miu como antes', async () => {
  const m = montar();
  await m.manager._interno.atender(entrada('rtc_eq', NUMERO_EQ));
  assert.equal(m.de('/api/marcas/voz/inicio').length, 0);
  assert.equal(m.de('vozInicio')[0].numero, 'equipos');
  const miu = montar();
  await miu.manager._interno.atender(entrada('rtc_miu', MIU));
  assert.equal(miu.de('/api/marcas/voz/inicio').length, 0);
});

test('herramientas: solo el call_id y claves conocidas; pedir_persona va a la marca, no a José', async () => {
  const llamadas = [];
  const m = montar({ herramienta: (b) => { llamadas.push(b); return { status: 'ok', data: { aviso: true }, instruccion_modelo: 'Dígale que Oscar le escribe.' }; } });
  await m.manager._interno.atender(entrada());
  const ws = FakeWs.ultima;
  ws.emit('open');
  const salida = (name, args) => ws.emit('message', Buffer.from(JSON.stringify({ type: 'response.done', response: { output: [{ type: 'function_call', call_id: `c_${name}`, name, arguments: JSON.stringify(args) }] } })));
  salida('tomar_dano', { descripcion: 'Gotea la llave', zona: 'Laureles', urgencia: 'normal', consentimiento_datos: true, negocio_id: 99, precio: 50000 });
  salida('pedir_persona', { tipo: 'queja', motivo: 'Llegaron tarde' });
  salida('quote_stay', { fechas: 'x' });
  salida('registrar_movimiento', { tipo: 'gasto' });
  await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r));
  const tomar = llamadas.find((x) => x.herramienta === 'tomar_dano');
  assert.equal(tomar.call_id, 'rtc_qb_1');
  assert.deepEqual(Object.keys(tomar.args).sort(), ['consentimiento_datos', 'descripcion', 'urgencia', 'zona']);
  assert.ok(llamadas.some((x) => x.herramienta === 'pedir_persona' && x.args.tipo === 'queja'));
  assert.equal(llamadas.some((x) => x.herramienta === 'quote_stay' || x.herramienta === 'registrar_movimiento'), false);
  assert.equal(m.de('vozAlerta').length, 0);
  const salidas = ws.enviados.filter((e) => e.type === 'conversation.item.create').map((e) => JSON.parse(e.item.output));
  assert.ok(salidas.some((o) => o.status === 'not_authorized' && o.reason === 'herramienta_no_disponible'));
});

test('herramienta sin respuesta del PMS: no inventa, remite al chat', async () => {
  const m = montar({ herramienta: () => null });
  await m.manager._interno.atender(entrada());
  const ws = FakeWs.ultima;
  ws.emit('open');
  ws.emit('message', Buffer.from(JSON.stringify({ type: 'response.done', response: { output: [{ type: 'function_call', call_id: 'c1', name: 'ver_cotizacion', arguments: '{}' }] } })));
  await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r));
  const out = JSON.parse(ws.enviados.find((e) => e.type === 'conversation.item.create').item.output);
  assert.equal(out.status, 'error');
  assert.match(out.instruccion_modelo, /No invente nada, ni precios/);
});

test('al colgar: cierre propio en el PMS, resumen y línea desde el número de la marca; nada de vozFin de Miu', async () => {
  const m = montar();
  await m.manager._interno.atender(entrada());
  const ws = FakeWs.ultima;
  ws.emit('open');
  ws.emit('message', Buffer.from(JSON.stringify({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'Se me dañó la llave' })));
  await m.manager._interno.finalizar(m.manager.activas.get('rtc_qb_1'));
  const fin = m.de('/api/marcas/voz/fin')[0];
  assert.equal(fin.call_id, 'rtc_qb_1');
  assert.equal(fin.resumen, 'Goteo en Laureles; visita agendada.');
  assert.equal(m.de('vozFin').length, 0);
  assert.deepEqual(m.textos, [{ id: NUMERO_QB, to: QUIEN, body: 'Quedó registrado su trabajo QB-0001.' }]);
  assert.deepEqual(m.textosMiu, []);
});

test('guion: parametrizado por config.marca; trato de usted; datos citados', () => {
  const marca = marcaDesdeInicio({ ...MARCA_OK, asistente: 'Lupe', saludo: '¡Buenas!', cliente_nombre: 'Ana María', trabajos: [{ numero: 'QB-0007', estado: 'agendado', oficio: 'plomería' }] });
  const t = instruccionesCamiMarcaVoz({ hoy: '2026-11-11', marca, duracionMaxMin: 10 });
  assert.match(t, /Lupe, la asistente virtual con inteligencia artificial de Quedó Bien/);
  assert.match(t, /"QB-0007"/);
  assert.match(t, /123/);
  assert.match(t, /consentimiento_datos/);
  assert.match(presentacionMarca(marca), /^¡Buenas! Le habla Lupe/);
  assert.equal(marcaDesdeInicio({ marca_nombre: '' }), null);
  assert.ok(herramientasMarcaVoz().every((h) => h.name !== 'evaluar_uso_aceptable' && h.name !== 'consultar_al_equipo'));
});

test('lista de marcas sin leer (PMS caído): una llamada a un número ajeno no cae en Cami de Miu', async () => {
  const m = montar({ listaMarca: [], marcaCargada: false });
  await m.manager._interno.atender(entrada('rtc_frio', NUMERO_QB));
  assert.ok(m.posts.some((p) => p.url.endsWith('/reject')));
  assert.equal(m.de('vozInicio').length, 0);
  assert.equal(m.posts.some((p) => p.url.endsWith('/accept')), false);
  // Miu y Equipos siguen igual.
  const miu = montar({ listaMarca: [], marcaCargada: false });
  await miu.manager._interno.atender(entrada('rtc_miu2', MIU));
  assert.equal(miu.de('vozInicio').length, 1);
  const eq = montar({ listaMarca: [], marcaCargada: false });
  await eq.manager._interno.atender(entrada('rtc_eq2', NUMERO_EQ));
  assert.equal(eq.de('vozInicio')[0].numero, 'equipos');
});

test('argumentos con valores raros del modelo: se descartan, la herramienta sigue', async () => {
  const llamadas = [];
  const m = montar({ herramienta: (b) => { llamadas.push(b); return { status: 'ok' }; } });
  await m.manager._interno.atender(entrada('rtc_enum'));
  const ws = FakeWs.ultima;
  ws.emit('open');
  ws.emit('message', Buffer.from(JSON.stringify({ type: 'response.done', response: { output: [{ type: 'function_call', call_id: 'c1', name: 'tomar_dano',
    arguments: JSON.stringify({ descripcion: 'Gotea', urgencia: 'alta', consentimiento_datos: true }) }] } })));
  await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r));
  assert.equal(llamadas[0].args.urgencia, undefined);
  assert.equal(llamadas[0].args.descripcion, 'Gotea');
});
