'use strict';

// Números de TenGo Camello Equipos (2026-11-01). Teléfonos FALSOS.
const test = require('node:test');
const assert = require('node:assert/strict');
const { separarPorNumero, atenderTengoCamello, despacharSalidasTengoCamello } = require('../lib/pilot/numero-entrante');
const { atenderEquipos, crearCacheNumeros, cuerpoInteractivo, debeReintentar, RUTA_RECLAMAR, rutaResultado } = require('../lib/pilot/numero-equipos');
const { extractMetaMessages, m0CommercialText } = require('../lib/pilot/meta-inbound');

const FROM = '573000000901';
const silencio = { info() {}, warn() {}, error() {} };
const OPC = { miuId: 'miu', tengoId: 'tengo', demoId: 'demo' };
const cambio = (id, value = {}) => ({ field: 'messages', value: { metadata: { phone_number_id: id, display_phone_number: '573000007379' }, ...value } });
const msg = (extra) => ({ contacts: [{ wa_id: FROM, profile: { name: 'Prueba' } }], messages: [{ from: FROM, id: 'wamid.a1', timestamp: '1761600000', ...extra }] });

function montar({ respuesta = { responder: true, mensajes: [{ texto: 'hola' }] }, puede = { conocido: true, documentos: true, notas_voz: true } } = {}) {
  const posts = [], enviados = [];
  return { posts, enviados, deps: { pmsBaseUrl: 'http://pms', extractMetaMessages, logger: silencio,
    enviar: async (id, to, s) => { enviados.push({ id, to, s }); },
    pms: { postUrl: async (url, body, opts) => { if (url.endsWith('/puede')) { if (puede instanceof Error) throw puede; return puede; } posts.push({ url, body, opts }); return respuesta; } } } };
}

test('ruteo: los números de la lista van a Equipos; Miu conserva el mismo objeto', () => {
  const soloMiu = { entry: [{ changes: [cambio('miu')] }] };
  const r = separarPorNumero(soloMiu, { ...OPC, equiposIds: new Set(['eq1']) });
  assert.equal(r.miuBody, soloMiu);
  assert.deepEqual(r.equiposChanges, []);
  const mezcla = separarPorNumero({ entry: [{ changes: [cambio('miu'), cambio('eq1'), cambio('nadie')] }] }, { ...OPC, equiposIds: new Set(['eq1']) });
  assert.equal(mezcla.equiposChanges.length, 1);
  assert.equal(mezcla.miuBody.entry[0].changes.length, 1);
  assert.equal(mezcla.desconocidos, 1);
});

test('un dato mal cargado no le quita mensajes a Miu, 7355 ni 7354', () => {
  const lista = new Set(['miu', 'tengo', 'demo']);
  const r = separarPorNumero({ entry: [{ changes: [cambio('miu'), cambio('tengo'), cambio('demo')] }] }, { ...OPC, equiposIds: lista });
  assert.equal(r.equiposChanges.length, 0);
  assert.equal(r.tengoChanges.length, 1);
  assert.equal(r.demoChanges.length, 1);
  assert.equal(r.miuBody.entry[0].changes.length, 1);
});

test('sin lista (llamador viejo) todo queda como antes', () => {
  const r = separarPorNumero({ entry: [{ changes: [cambio('eq1')] }] }, OPC);
  assert.equal(r.desconocidos, 1);
  assert.equal(r.miuBody, null);
  assert.deepEqual(r.equiposChanges, []);
});

test('caché: lee, no repite antes de vencer y si falla conserva lo último', async () => {
  let t = 0, llamadas = 0, falla = false;
  const pms = { postUrl: async () => { llamadas += 1; if (falla) throw new Error('caído'); return { numeros: ['eq1'] }; } };
  const c = crearCacheNumeros({ pms, pmsBaseUrl: 'http://pms', ttlMs: 60_000, logger: silencio, ahora: () => t });
  assert.deepEqual([...await c.refrescarSiVencio()], ['eq1']);
  await c.refrescarSiVencio();
  assert.equal(llamadas, 1);
  t = 61_000; falla = true;
  assert.deepEqual([...await c.refrescarSiVencio()], ['eq1']);
  assert.equal(llamadas, 2);
  t = 62_000;
  await c.refrescarSiVencio();
  assert.equal(llamadas, 2, 'tras una falla espera 10 s antes de reintentar');
});

test('ids() no espera: Miu nunca se detiene por la lista', async () => {
  let soltar; const pendiente = new Promise((r) => { soltar = r; });
  const pms = { postUrl: async () => { await pendiente; return { numeros: ['eq1'] }; } };
  const c = crearCacheNumeros({ pms, pmsBaseUrl: 'http://pms', logger: silencio });
  assert.deepEqual([...c.ids()], []);
  soltar();
});

test('al PMS va firmado con el número, el texto, el botón y el contacto; responde desde ese número', async () => {
  const m = montar({ respuesta: { responder: true, mensajes: [{ texto: '¿Quién pagó?', botones: [{ id: 'eq:1:0', title: 'Yo' }] }] } });
  await atenderEquipos([cambio('eq1', msg({ type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: 'eq:9:1', title: 'La caja' } } }))], m.deps);
  assert.equal(m.posts[0].url, 'http://pms/api/equipos/whatsapp/inbound');
  assert.equal(m.posts[0].body.phone_number_id, 'eq1');
  assert.equal(m.posts[0].body.numero_mostrado, '573000007379');
  assert.equal(m.posts[0].body.boton_id, 'eq:9:1');
  assert.equal(m.enviados[0].id, 'eq1');
  assert.equal(m.enviados[0].s.botones[0].title, 'Yo');
});

test('tarjeta de contacto: llega a Equipos; en Miu sigue siendo el marcador de siempre', async () => {
  const contacto = { type: 'contacts', contacts: [{ name: { formatted_name: 'Pedro Pérez', first_name: 'Pedro' }, phones: [{ phone: '+57 300 000 0903', wa_id: '573000000903', type: 'CELL' }] }] };
  const m = montar();
  await atenderEquipos([cambio('eq1', msg(contacto))], m.deps);
  assert.deepEqual(m.posts[0].body.contactos, [{ nombre: 'Pedro Pérez', telefonos: [{ telefono: '+57 300 000 0903', wa_id: '573000000903' }] }]);
  const [miu] = extractMetaMessages({ entry: [{ changes: [cambio('miu', msg(contacto))] }] });
  assert.equal(m0CommercialText(miu), '[M0_UNSUPPORTED_INBOUND:contacts]');
  // El 7355 no reenvía ni el contacto ni el id del botón: su cuerpo no cambia.
  const t = montar({ respuesta: { responder: false } });
  await atenderTengoCamello([cambio('tengo', msg(contacto))], { ...t.deps, enviarTexto: async () => {} });
  assert.deepEqual(Object.keys(t.posts[0].body).sort(), ['contact_name', 'from', 'message_id', 'message_type', 'occurred_at', 'text']);
});

test('un botón en Miu sigue entregando su título', () => {
  const [m] = extractMetaMessages({ entry: [{ changes: [cambio('miu', msg({ type: 'interactive', interactive: { button_reply: { id: 'x', title: 'Sí' } } }))] }] });
  assert.equal(m.text, 'Sí');
});

test('nota de voz transcrita, adjunto y plazo largo; si la transcripción falla sigue con texto vacío', async () => {
  const m = montar();
  await atenderEquipos([cambio('eq1', msg({ type: 'audio', audio: { id: 'a1', mime_type: 'audio/ogg' } }))], { ...m.deps, transcribirAudio: async () => 'hoy 300 litros' });
  assert.equal(m.posts[0].body.text, 'hoy 300 litros');
  assert.equal(m.posts[0].opts.timeoutMs, 45000);
  const f = montar();
  await atenderEquipos([cambio('eq1', msg({ type: 'audio', audio: { id: 'a1' } }))], { ...f.deps, transcribirAudio: async () => { throw new Error('x'); } });
  assert.equal(f.posts[0].body.text, '');
  const d = montar();
  await atenderEquipos([cambio('eq1', msg({ type: 'document', document: { id: 'm1', mime_type: 'application/pdf', filename: 'f.pdf' } }))],
    { ...d.deps, descargarAdjunto: async (x) => ({ tipo: x.tipo, estado: 'guardado', contenido_base64: 'YWJj', sha256: 'a'.repeat(64) }) });
  assert.equal(d.posts[0].body.adjunto.tipo, 'document');
});

test('avisos de entrega van a su ruta y no tumban nada', async () => {
  const m = montar();
  await atenderEquipos([cambio('eq1', { statuses: [{ id: 's', status: 'read', timestamp: '1', recipient_id: FROM, pricing: {} }] })], m.deps);
  assert.equal(m.posts[0].url, 'http://pms/api/equipos/whatsapp/estados');
  assert.equal(m.posts[0].body.statuses[0].pricing, undefined);
});

test('botones de Meta: máximo 3, título de 20 caracteres', () => {
  const c = cuerpoInteractivo(FROM, { texto: 'x', botones: [1, 2, 3, 4].map((i) => ({ id: `b${i}`, title: 'y'.repeat(30) })) });
  assert.equal(c.interactive.action.buttons.length, 3);
  assert.equal(c.interactive.action.buttons[0].reply.title.length, 20);
});

test('la cola de Equipos reporta a su ruta y entrega el número que envía', async () => {
  const posts = [], envios = [];
  const pms = { postUrl: async (url, body) => { posts.push({ url, body }); return url.endsWith('reclamar') ? { salidas: [{ id: 7, to: FROM, texto: 'hola', phone_number_id: 'eq1' }] } : {}; } };
  const r = await despacharSalidasTengoCamello({ pms, pmsBaseUrl: 'http://pms', rutaReclamar: RUTA_RECLAMAR, rutaResultado, etiqueta: '[equipos]', logger: silencio,
    enviarTexto: async (to, body, s) => { envios.push({ to, body, id: s.phone_number_id }); return 'wamid.x'; } });
  assert.equal(r.enviados, 1);
  assert.equal(envios[0].id, 'eq1');
  assert.equal(posts[1].url, 'http://pms/api/equipos/whatsapp/outbox/7/resultado');
});

test('el log nunca lleva el teléfono', async () => {
  const lineas = [];
  const log = { info: (...a) => lineas.push(JSON.stringify(a)), warn: (...a) => lineas.push(JSON.stringify(a)), error: (...a) => lineas.push(JSON.stringify(a)) };
  const m = montar();
  await atenderEquipos([cambio('eq1', msg({ type: 'text', text: { body: 'hola' } }))], { ...m.deps, logger: log });
  assert.ok(lineas.length > 0);
  assert.ok(lineas.every((l) => !l.includes(FROM)));
});

test('desconocido o sin permiso: ni transcripción ni descarga, y el PMS igual recibe el mensaje', async () => {
  let gastos = 0;
  const transcribirAudio = async () => { gastos += 1; return 'x'; };
  const descargarAdjunto = async () => { gastos += 1; return {}; };
  const a = montar({ puede: { conocido: false, documentos: false, notas_voz: false } });
  await atenderEquipos([cambio('eq1', msg({ type: 'audio', audio: { id: 'a1' } }))], { ...a.deps, transcribirAudio, descargarAdjunto });
  assert.equal(a.posts[0].body.text, '');
  await atenderEquipos([cambio('eq1', msg({ type: 'document', document: { id: 'm1', mime_type: 'application/pdf' } }))], { ...a.deps, transcribirAudio, descargarAdjunto });
  assert.deepEqual(a.posts[1].body.adjunto, { tipo: 'document', estado: 'no_descargado', motivo: 'sin_permiso_o_desconocido' });
  // Sin permiso para documentos pero sí para audio: solo gasta lo permitido.
  const b = montar({ puede: { conocido: true, documentos: false, notas_voz: true } });
  await atenderEquipos([cambio('eq1', msg({ type: 'document', document: { id: 'm1' } }))], { ...b.deps, transcribirAudio, descargarAdjunto });
  assert.equal(gastos, 0);
  await atenderEquipos([cambio('eq1', msg({ type: 'audio', audio: { id: 'a1' } }))], { ...b.deps, transcribirAudio, descargarAdjunto });
  assert.equal(gastos, 1);
  // Un texto no pregunta: no hay nada que gastar. Con el PMS caído tampoco se gasta.
  const c = montar({ puede: new Error('caído') });
  await atenderEquipos([cambio('eq1', msg({ type: 'document', document: { id: 'm1' } }))], { ...c.deps, transcribirAudio, descargarAdjunto });
  assert.equal(gastos, 1);
});

test('PMS caído: traza clara por mensaje, sin teléfono', async () => {
  const lineas = [];
  const log = { info() {}, warn() {}, error: (msgLog, datos) => lineas.push([msgLog, datos]) };
  const pms = { postUrl: async () => { throw Object.assign(new Error('x'), { code: 'ECONNREFUSED' }); } };
  await atenderEquipos([cambio('eq1', msg({ type: 'text', text: { body: 'hola' } }))], { pmsBaseUrl: 'http://pms', extractMetaMessages, logger: log, enviar: async () => {}, pms });
  const t = lineas.find((l) => l[0] === '[equipos] mensaje_no_atendido');
  assert.equal(t[1].message_id, 'wamid.a1');
  assert.equal(t[1].code, 'ECONNREFUSED');
  assert.ok(!JSON.stringify(t).includes(FROM));
});

test('caché fría: conserva lo último tras una falla; sin lista y sin Miu pide reintento a Meta', async () => {
  let falla = true, t = 0;
  const pms = { postUrl: async () => { if (falla) throw new Error('caído'); return { numeros: ['eq1'] }; } };
  const c = crearCacheNumeros({ pms, pmsBaseUrl: 'http://pms', logger: silencio, ahora: () => t });
  await c.refrescarSiVencio();
  assert.equal(c.cargada(), false);
  const ruteo = separarPorNumero({ entry: [{ changes: [cambio('eq1')] }] }, { ...OPC, equiposIds: c.ids() });
  assert.equal(debeReintentar(ruteo, c), true);
  const conMiu = separarPorNumero({ entry: [{ changes: [cambio('miu'), cambio('eq1')] }] }, { ...OPC, equiposIds: c.ids() });
  assert.equal(debeReintentar(conMiu, c), false);
  falla = false; t = 11_000;
  await c.refrescarSiVencio();
  assert.equal(c.cargada(), true);
  falla = true; t = 80_000;
  assert.deepEqual([...await c.refrescarSiVencio()], ['eq1']);
  assert.equal(debeReintentar(separarPorNumero({ entry: [{ changes: [cambio('otro')] }] }, { ...OPC, equiposIds: c.ids() }), c), false);
  // Lista cargada y vacía (política apagada) no es una falla.
  const vacia = crearCacheNumeros({ pms: { postUrl: async () => ({ numeros: [] }) }, pmsBaseUrl: 'http://pms', logger: silencio });
  await vacia.refrescarSiVencio();
  assert.equal(vacia.cargada(), true);
});
