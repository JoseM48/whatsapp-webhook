'use strict';

// Números de marca de TenGo Camello (Quedó Bien, 2026-11-11; PMS migración 1201).
// Teléfonos e ids FALSOS.
const test = require('node:test');
const assert = require('node:assert/strict');
const { separarPorNumero, clasificarFalloEnvio } = require('../lib/pilot/numero-entrante');
const { atenderMarca, separarMarca, crearCacheNumerosMarca, crearMemoriaRemitentesMarca, cuerpoSalidaMarca, despacharSalidasMarca, debeEsperarMarca,
  TEXTO_FALLA_PMS, RUTA_NUMEROS, RUTA_INBOUND, RUTA_RECLAMAR, rutaResultado } = require('../lib/pilot/numero-marca');
const { extractMetaMessages } = require('../lib/pilot/meta-inbound');

const FROM = '573000000951';
const QB = '777000111';
const silencio = { info() {}, warn() {}, error() {} };
const cambio = (id, value = {}) => ({ field: 'messages', value: { metadata: { phone_number_id: id, display_phone_number: '573000009999' }, ...value } });
const msg = (extra) => ({ contacts: [{ wa_id: FROM, profile: { name: 'Cliente' } }], messages: [{ from: FROM, id: 'wamid.qb1', timestamp: '1762800000', ...extra }] });

function montar({ respuesta = { responder: true, mensajes: [{ texto: 'Hola, bienvenido a Quedó Bien.' }] }, puede = { documentos: true, notas_voz: true }, falla = null } = {}) {
  const posts = [], enviados = [];
  return { posts, enviados, deps: { pmsBaseUrl: 'http://pms', extractMetaMessages, logger: silencio,
    enviar: async (id, to, s) => { enviados.push({ id, to, s }); },
    pms: { postUrl: async (url, body, opts) => { if (url.endsWith('/puede')) return puede; posts.push({ url, body, opts }); if (falla) throw falla; return respuesta; } } } };
}

test('ruteo: la marca sale primero; Miu, 7355, 7354 y Equipos quedan como estaban', () => {
  const soloMiu = { entry: [{ changes: [cambio('miu')] }] };
  assert.equal(separarMarca(soloMiu, { marcaIds: new Set([QB]) }).body, soloMiu);
  const cuerpo = { entry: [{ changes: [cambio('miu'), cambio(QB), cambio('eq1'), cambio('tengo')] }] };
  const m = separarMarca(cuerpo, { marcaIds: new Set([QB]), reservados: ['miu', 'tengo', 'demo'] });
  assert.equal(m.marcaChanges.length, 1);
  const r = separarPorNumero(m.body, { miuId: 'miu', tengoId: 'tengo', demoId: 'demo', equiposIds: new Set(['eq1']) });
  assert.equal(r.miuBody.entry[0].changes.length, 1);
  assert.equal(r.equiposChanges.length, 1);
  assert.equal(r.tengoChanges.length, 1);
  assert.equal(r.desconocidos, 0);
});

test('ruteo: un id de Miu o del 7355 mal cargado como marca nunca se le quita a su dueño', () => {
  const cuerpo = { entry: [{ changes: [cambio('miu'), cambio('tengo')] }] };
  const m = separarMarca(cuerpo, { marcaIds: new Set(['miu', 'tengo']), reservados: ['miu', 'tengo', 'demo'] });
  assert.equal(m.marcaChanges.length, 0);
  assert.equal(m.body, cuerpo);
});

test('ruteo: si todo era de marca no queda cuerpo para Miu (null, nunca vacío)', () => {
  const m = separarMarca({ entry: [{ changes: [cambio(QB)] }] }, { marcaIds: new Set([QB]) });
  assert.equal(m.body, null);
  assert.equal(m.marcaChanges.length, 1);
  assert.equal(debeEsperarMarca({ miuBody: null, tengoChanges: [], demoChanges: [], equiposChanges: [] }), true);
  assert.equal(debeEsperarMarca({ miuBody: {}, tengoChanges: [], demoChanges: [], equiposChanges: [] }), false);
});

test('caché: usa la ruta de marcas y conserva lo último si el PMS falla', async () => {
  let t = 0, falla = false;
  const urls = [];
  const pms = { postUrl: async (url) => { urls.push(url); if (falla) throw new Error('caído'); return { numeros: [QB] }; } };
  const c = crearCacheNumerosMarca({ pms, pmsBaseUrl: 'http://pms', logger: silencio, ahora: () => t });
  assert.deepEqual([...await c.refrescarSiVencio()], [QB]);
  assert.equal(urls[0], `http://pms${RUTA_NUMEROS}`);
  t = 61_000; falla = true;
  assert.deepEqual([...await c.refrescarSiVencio()], [QB]);
  assert.equal(c.cargada(), true);
});

test('atiende: firma al PMS por /api/marcas y responde desde el número que recibió', async () => {
  const m = montar({ respuesta: { responder: true, mensajes: [{ texto: '¿Qué pasó?', botones: [{ id: 'qb:urg:normal', title: 'Normal' }] }, { texto: '  ' }] } });
  const r = await atenderMarca([cambio(QB, msg({ type: 'text', text: { body: 'Se me dañó la llave' } }))], m.deps);
  assert.equal(m.posts[0].url, `http://pms${RUTA_INBOUND}`);
  assert.equal(m.posts[0].body.phone_number_id, QB);
  assert.equal(m.posts[0].body.text, 'Se me dañó la llave');
  assert.equal(r.enviados, 1);
  assert.equal(m.enviados[0].id, QB);
  assert.equal(m.enviados[0].s.botones[0].id, 'qb:urg:normal');
});

test('con la política apagada el número no responde a nadie, ni con el aviso de falla', async () => {
  const memoria = crearMemoriaRemitentesMarca();
  const m = montar({ respuesta: { responder: false, mensajes: [] } });
  await atenderMarca([cambio(QB, msg({ type: 'text', text: { body: 'hola' } }))], { ...m.deps, memoria });
  assert.deepEqual(m.enviados, []);
  const f = montar({ falla: Object.assign(new Error('x'), { code: 'ECONNRESET' }) });
  await atenderMarca([cambio(QB, msg({ type: 'text', text: { body: 'hola' } }))], { ...f.deps, memoria });
  assert.deepEqual(f.enviados, []);
});

test('si el PMS ya le respondió y luego falla, se avisa una sola vez de usted', async () => {
  const memoria = crearMemoriaRemitentesMarca();
  const ok = montar();
  await atenderMarca([cambio(QB, msg({ type: 'text', text: { body: 'hola' } }))], { ...ok.deps, memoria });
  const f = montar({ falla: new Error('caído') });
  await atenderMarca([cambio(QB, msg({ type: 'text', text: { body: 'otra' } }))], { ...f.deps, memoria });
  await atenderMarca([cambio(QB, msg({ type: 'text', text: { body: 'otra más' } }))], { ...f.deps, memoria });
  assert.deepEqual(f.enviados.map((e) => e.s.texto), [TEXTO_FALLA_PMS]);
  assert.match(TEXTO_FALLA_PMS, /envíelo/);
});

test('fotos: sin permiso del PMS no se descarga; con permiso, sí', async () => {
  const media = { type: 'image', image: { id: 'm1', mime_type: 'image/jpeg' } };
  const descargas = [];
  const descargarAdjunto = async (x) => { descargas.push(x); return { tipo: 'imagen', estado: 'ok' }; };
  const sin = montar({ puede: { documentos: false } });
  await atenderMarca([cambio(QB, msg(media))], { ...sin.deps, descargarAdjunto });
  assert.equal(descargas.length, 0);
  assert.equal(sin.posts[0].body.adjunto.estado, 'no_descargado');
  const con = montar();
  await atenderMarca([cambio(QB, msg(media))], { ...con.deps, descargarAdjunto });
  assert.equal(descargas.length, 1);
});

test('cuerpo de salida: texto, botones (máx. 3) e imagen https; plantilla e imagen rara fallan', () => {
  assert.deepEqual(cuerpoSalidaMarca('57300', { texto: 'hola' }), { messaging_product: 'whatsapp', to: '57300', text: { body: 'hola' } });
  const b = cuerpoSalidaMarca('57300', { texto: 'elija', botones: [1, 2, 3, 4].map((i) => ({ id: `b${i}`, title: `Opción ${i} con título largo` })) });
  assert.equal(b.interactive.action.buttons.length, 3);
  assert.ok(b.interactive.action.buttons.every((x) => x.reply.title.length <= 20));
  const img = cuerpoSalidaMarca('57300', { imagen: { url: 'https://pms.example/qb/f/1?firma=x', caption: 'Antes' } });
  assert.equal(img.type, 'image');
  assert.equal(img.image.caption, 'Antes');
  assert.throws(() => cuerpoSalidaMarca('57300', { imagen: { url: 'http://inseguro/x.jpg' } }), /imagen_invalida/);
  assert.throws(() => cuerpoSalidaMarca('57300', { plantilla: 'qb_cotizacion' }), /plantilla_no_soportada/);
});

test('cola qb_outbox: envía desde el número de cada salida y reporta; nunca desde uno que no es de marca', async () => {
  const posts = [], enviados = [];
  const pms = { postUrl: async (url, body) => { posts.push({ url, body });
    if (url.endsWith(RUTA_RECLAMAR)) return { salidas: [
      { id: 1, to: FROM, phone_number_id: QB, texto: 'Su cotización está lista.', botones: [{ id: 'qb:acepto:1', title: 'Acepto' }] },
      { id: 2, to: FROM, phone_number_id: 'miu', texto: 'esto no sale' },
      { id: 3, to: FROM, phone_number_id: QB, plantilla: 'qb_x' }] };
    return {}; } };
  const r = await despacharSalidasMarca({ pms, pmsBaseUrl: 'http://pms', logger: silencio, clasificarFallo: clasificarFalloEnvio,
    numerosMarca: { ids: () => new Set([QB]), cargada: () => true },
    enviar: async (id, to, s) => { if (s.plantilla) throw Object.assign(new Error('p'), { code: 'plantilla_no_soportada' }); enviados.push({ id, to, s }); return 'wamid.out'; } });
  assert.deepEqual(r, { enviados: 1, fallidos: 2, inciertos: 0 });
  assert.equal(enviados.length, 1);
  assert.equal(enviados[0].id, QB);
  const res = (id) => posts.find((p) => p.url === `http://pms${rutaResultado(id)}`).body;
  assert.equal(res(1).resultado, 'enviado');
  assert.equal(res(2).error, 'numero_no_es_de_marca');
  assert.equal(res(3).error, 'plantilla_no_soportada');
});

test('cola qb_outbox: sin la lista leída o sin números de marca no se reclama nada', async () => {
  const urls = [];
  const pms = { postUrl: async (url) => { urls.push(url); return { salidas: [] }; } };
  const base = { pms, pmsBaseUrl: 'http://pms', logger: silencio, clasificarFallo: clasificarFalloEnvio, enviar: async () => 'x' };
  await despacharSalidasMarca({ ...base, numerosMarca: { ids: () => new Set(), cargada: () => false } });
  await despacharSalidasMarca({ ...base, numerosMarca: { ids: () => new Set(), cargada: () => true } });
  assert.deepEqual(urls, []);
});

test('caché: si la ruta de marcas aún no existe en el PMS (404), queda leída y vacía, sin ruido', async () => {
  const errores = [];
  const pms = { postUrl: async () => { throw Object.assign(new Error('nf'), { response: { status: 404 } }); } };
  const c = crearCacheNumerosMarca({ pms, pmsBaseUrl: 'http://pms', logger: { ...silencio, error: (...a) => errores.push(a) } });
  assert.equal((await c.refrescarSiVencio()).size, 0);
  assert.equal(c.cargada(), true);
  assert.deepEqual(errores, []);
});

test('memoria de falla: es por número de marca y teléfono', async () => {
  const memoria = crearMemoriaRemitentesMarca();
  const ok = montar();
  await atenderMarca([cambio(QB, msg({ type: 'text', text: { body: 'hola' } }))], { ...ok.deps, memoria });
  const f = montar({ falla: new Error('caído') });
  await atenderMarca([cambio('888000222', msg({ type: 'text', text: { body: 'otra marca' } }))], { ...f.deps, memoria });
  assert.deepEqual(f.enviados, []);
});
