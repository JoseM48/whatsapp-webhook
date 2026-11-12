'use strict';

// Colas de salida de TenGo (2026-11-11, brecha 4 de la simulación Pipa / Quedó Bien):
// plantillas de Meta fuera de la ventana de 24 h (qb_outbox y equipos_outbox) y fotos
// de una salida de marca (pedidas al PMS, subidas a Meta, enviadas por media id).
// Teléfonos e ids FALSOS; fetch/axios simulados.
const test = require('node:test');
const assert = require('node:assert/strict');
const { clasificarFalloEnvio, despacharSalidasTengoCamello } = require('../lib/pilot/numero-entrante');
const { cuerpoSalidaMarca, despacharSalidasMarca, crearSubirMedia, rutaResultado, rutaDocumento, RUTA_RECLAMAR } = require('../lib/pilot/numero-marca');
const { cuerpoPlantilla, cuerpoSalidaEquipos, RUTA_RECLAMAR: RUTA_EQ_RECLAMAR, rutaResultado: rutaEqResultado } = require('../lib/pilot/numero-equipos');

const FROM = '573000000961';
const QB = '777000111';
const PLANTILLA = { nombre: 'qb_cotizacion_lista_v1', idioma: 'es', parametros: ['QB-0001', 'Quedó Bien'] };
const PNG = Buffer.from('89504e470d0a1a0a', 'hex');

function registro() {
  const lineas = [];
  const guardar = (nivel) => (...a) => lineas.push([nivel, JSON.stringify(a)]);
  return { lineas, logger: { info: guardar('info'), warn: guardar('warn'), error: guardar('error') } };
}

test('plantilla: name, language.code y components body con los parámetros en orden', () => {
  assert.deepEqual(cuerpoPlantilla('57300', PLANTILLA), { messaging_product: 'whatsapp', to: '57300', type: 'template', template: {
    name: 'qb_cotizacion_lista_v1', language: { code: 'es' },
    components: [{ type: 'body', parameters: [{ type: 'text', text: 'QB-0001' }, { type: 'text', text: 'Quedó Bien' }] }] } });
  // Sin parámetros no lleva components; un idioma raro cae a "es"; un parámetro vacío no rompe a Meta.
  assert.deepEqual(cuerpoPlantilla('57300', { nombre: 'hola_v1', idioma: 'xx-yy' }).template, { name: 'hola_v1', language: { code: 'es' } });
  assert.equal(cuerpoPlantilla('57300', { nombre: 'a', idioma: 'es_CO', parametros: ['  '] }).template.components[0].parameters[0].text, '-');
  assert.equal(cuerpoPlantilla('57300', { nombre: 'a', idioma: 'es_CO' }).template.language.code, 'es_CO');
  for (const mala of [null, 'qb_x', { nombre: 'Con Mayúsculas' }, { nombre: '' }]) {
    assert.throws(() => cuerpoPlantilla('57300', mala), (e) => e.code === 'plantilla_invalida' && e.permanente === true);
  }
  // La marca y Equipos usan el mismo cuerpo.
  assert.deepEqual(cuerpoSalidaMarca('57300', { texto: 'ignorado', plantilla: PLANTILLA }), cuerpoPlantilla('57300', PLANTILLA));
  assert.deepEqual(cuerpoSalidaEquipos('57300', { texto: 'x', plantilla: PLANTILLA }), cuerpoPlantilla('57300', PLANTILLA));
  assert.deepEqual(cuerpoSalidaEquipos('57300', { texto: 'hola' }), { messaging_product: 'whatsapp', to: '57300', text: { body: 'hola' } });
});

test('imagen por media id: solo dígitos; con pie corto', () => {
  assert.deepEqual(cuerpoSalidaMarca('57300', { imagen: { media_id: '123456', caption: 'Después' } }),
    { messaging_product: 'whatsapp', to: '57300', type: 'image', image: { id: '123456', caption: 'Después' } });
  assert.throws(() => cuerpoSalidaMarca('57300', { imagen: { media_id: '../x' } }), /imagen_invalida/);
});

function montarCola(salidas, { documentos = {}, subirFalla = new Set() } = {}) {
  const posts = [], enviados = [], subidas = [];
  const pms = { postUrl: async (url, body) => { posts.push({ url, body });
    if (url.endsWith(RUTA_RECLAMAR)) return { salidas };
    const m = /outbox\/(\d+)\/documento$/.exec(url);
    if (m) { const d = documentos[body.documento_id]; if (!d) throw Object.assign(new Error('nf'), { response: { status: 404 } }); return d; }
    return {}; } };
  const enviar = async (id, to, s) => { const cuerpo = cuerpoSalidaMarca(to, s); enviados.push({ id, to, cuerpo }); return `wamid.${enviados.length}`; };
  const subirMedia = async (id, { mimeType, buffer, nombre }) => { subidas.push({ id, mimeType, bytes: buffer.length, nombre });
    if (subirFalla.has(nombre)) throw Object.assign(new Error('meta'), { response: { status: 400 } }); return String(9000 + subidas.length); };
  return { posts, enviados, subidas, pms, enviar, subirMedia, res: (id) => posts.find((p) => p.url === `http://pms${rutaResultado(id)}`)?.body };
}

test('qb_outbox: una salida con plantilla sale solo como plantilla (sin botones ni fotos) y se reporta enviada', async () => {
  const c = montarCola([{ id: 7, to: FROM, phone_number_id: QB, texto: 'texto libre', plantilla: PLANTILLA, botones: [{ id: 'b', title: 'B' }], documentos: [1] }],
    { documentos: { 1: { mime_type: 'image/png', contenido_base64: PNG.toString('base64') } } });
  const { logger, lineas } = registro();
  const r = await despacharSalidasMarca({ pms: c.pms, pmsBaseUrl: 'http://pms', enviar: c.enviar, subirMedia: c.subirMedia, logger,
    numerosMarca: { ids: () => new Set([QB]), cargada: () => true }, clasificarFallo: clasificarFalloEnvio });
  assert.deepEqual(r, { enviados: 1, fallidos: 0, inciertos: 0 });
  assert.equal(c.enviados.length, 1);
  assert.equal(c.enviados[0].cuerpo.type, 'template');
  assert.equal(c.enviados[0].cuerpo.template.name, 'qb_cotizacion_lista_v1');
  assert.equal(c.subidas.length, 0);
  assert.deepEqual(c.res(7), { resultado: 'enviado', provider_reference: 'wamid.1' });
  assert.ok(lineas.every(([, t]) => !t.includes(FROM)), 'el teléfono nunca va a logs');
});

test('qb_outbox: plantilla mal formada es error permanente, no incierto', async () => {
  const c = montarCola([{ id: 8, to: FROM, phone_number_id: QB, plantilla: { nombre: 'NO VALE' } }]);
  const r = await despacharSalidasMarca({ pms: c.pms, pmsBaseUrl: 'http://pms', enviar: c.enviar, logger: registro().logger,
    numerosMarca: { ids: () => new Set([QB]), cargada: () => true }, clasificarFallo: clasificarFalloEnvio });
  assert.deepEqual(r, { enviados: 0, fallidos: 1, inciertos: 0 });
  assert.deepEqual(c.res(8), { resultado: 'error', error: 'plantilla_invalida' });
});

test('qb_outbox: fotos -> pide cada una al PMS, la sube desde el mismo número y la manda por media id, después del texto', async () => {
  const c = montarCola([{ id: 9, to: FROM, phone_number_id: QB, texto: 'Así quedó.', documentos: [11, 12] }], { documentos: {
    11: { mime_type: 'image/jpeg', contenido_base64: Buffer.from('jpeg-falso').toString('base64') },
    12: { mime_type: 'image/png', contenido_base64: PNG.toString('base64') } } });
  const r = await despacharSalidasMarca({ pms: c.pms, pmsBaseUrl: 'http://pms', enviar: c.enviar, subirMedia: c.subirMedia, logger: registro().logger,
    numerosMarca: { ids: () => new Set([QB]), cargada: () => true }, clasificarFallo: clasificarFalloEnvio });
  assert.deepEqual(r, { enviados: 1, fallidos: 0, inciertos: 0 });
  assert.deepEqual(c.posts.filter((p) => p.url.endsWith('/documento')).map((p) => [p.url, p.body.documento_id]),
    [[`http://pms${rutaDocumento(9)}`, 11], [`http://pms${rutaDocumento(9)}`, 12]]);
  assert.deepEqual(c.subidas.map((s) => [s.id, s.mimeType]), [[QB, 'image/jpeg'], [QB, 'image/png']]);
  assert.equal(c.enviados[0].cuerpo.text.body, 'Así quedó.');
  assert.deepEqual(c.enviados.slice(1).map((e) => [e.id, e.cuerpo.type, e.cuerpo.image.id]), [[QB, 'image', '9001'], [QB, 'image', '9002']]);
  assert.equal(c.res(9).resultado, 'enviado');
  assert.equal(c.res(9).provider_reference, 'wamid.1');
  assert.equal(c.res(9).error, undefined);
});

test('qb_outbox: si una foto falla, el texto igual sale y la falla se reporta', async () => {
  const c = montarCola([{ id: 10, to: FROM, phone_number_id: QB, texto: 'Así quedó.', documentos: [21, 22, 23] }], { documentos: {
    21: { mime_type: 'image/jpeg', contenido_base64: Buffer.from('a').toString('base64') },
    // 22 no existe en el PMS (404); 23 no es una foto.
    23: { mime_type: 'application/pdf', contenido_base64: Buffer.from('b').toString('base64') } } });
  const { logger, lineas } = registro();
  const r = await despacharSalidasMarca({ pms: c.pms, pmsBaseUrl: 'http://pms', enviar: c.enviar, subirMedia: c.subirMedia, logger,
    numerosMarca: { ids: () => new Set([QB]), cargada: () => true }, clasificarFallo: clasificarFalloEnvio });
  assert.deepEqual(r, { enviados: 1, fallidos: 0, inciertos: 0 });
  assert.equal(c.enviados.length, 2); // texto + la foto 21
  const res = c.res(10);
  assert.equal(res.resultado, 'enviado');
  assert.equal(res.error, 'fotos_no_enviadas:2/3');
  assert.deepEqual(res.documentos.map((d) => [d.documento_id, d.resultado]), [[21, 'enviado'], [22, 'error'], [23, 'error']]);
  assert.equal(res.documentos[2].error, 'documento_no_es_foto');
  assert.ok(lineas.some(([n, t]) => n === 'error' && t.includes('foto_no_enviada')));
  assert.ok(lineas.every(([, t]) => !t.includes(FROM)), 'el teléfono nunca va a logs');
});

test('qb_outbox: si el texto falla, no se mandan fotos', async () => {
  const c = montarCola([{ id: 11, to: FROM, phone_number_id: QB, texto: 'x', documentos: [31] }], { documentos: { 31: { mime_type: 'image/jpeg', contenido_base64: 'YQ==' } } });
  const enviar = async () => { throw Object.assign(new Error('meta'), { response: { status: 500 } }); };
  const r = await despacharSalidasMarca({ pms: c.pms, pmsBaseUrl: 'http://pms', enviar, subirMedia: c.subirMedia, logger: registro().logger,
    numerosMarca: { ids: () => new Set([QB]), cargada: () => true }, clasificarFallo: clasificarFalloEnvio });
  assert.deepEqual(r, { enviados: 0, fallidos: 1, inciertos: 0 });
  assert.equal(c.subidas.length, 0);
  assert.equal(c.posts.filter((p) => p.url.endsWith('/documento')).length, 0);
});

test('subida a Meta: POST multipart a /{phone_number_id}/media con el token; devuelve el id', async () => {
  const llamadas = [];
  const subir = crearSubirMedia({ token: 'tok-prueba', post: async (url, datos, opciones) => { llamadas.push({ url, datos, opciones }); return { data: { id: '5551' } }; } });
  assert.equal(await subir(QB, { mimeType: 'image/png', buffer: PNG, nombre: 'foto-1' }), '5551');
  assert.equal(llamadas[0].url, `https://graph.facebook.com/v20.0/${QB}/media`);
  assert.equal(llamadas[0].opciones.headers.Authorization, 'Bearer tok-prueba');
  const f = llamadas[0].datos;
  assert.ok(f instanceof FormData);
  assert.equal(f.get('messaging_product'), 'whatsapp');
  assert.equal(f.get('type'), 'image/png');
  const archivo = f.get('file');
  assert.equal(archivo.type, 'image/png');
  assert.equal(archivo.name, 'foto-1.png');
  assert.equal(Buffer.from(await archivo.arrayBuffer()).equals(PNG), true);
  await assert.rejects(subir('no-es-id', { mimeType: 'image/png', buffer: PNG }), /numero_invalido/);
  const sinId = crearSubirMedia({ token: 't', post: async () => ({ data: {} }) });
  await assert.rejects(sinId(QB, { mimeType: 'image/jpeg', buffer: PNG }), /media_sin_id/);
});

test('equipos_outbox: la salida con plantilla llega al enviador con la plantilla; un error permanente se reporta como error', async () => {
  const posts = [], cuerpos = [];
  const pms = { postUrl: async (url, body) => { posts.push({ url, body });
    if (url.endsWith(RUTA_EQ_RECLAMAR)) return { salidas: [
      { id: 1, to: FROM, phone_number_id: '880001', texto: 'Tienes un pendiente.', plantilla: { nombre: 'tg_aviso_responsable_v1', idioma: 'es_CO', parametros: ['Lechería', 'factura'] } },
      { id: 2, to: FROM, phone_number_id: '880001', texto: 'dentro de ventana' },
      { id: 3, to: FROM, phone_number_id: '880001', texto: 'x', plantilla: { nombre: 'MALA' } }] };
    return {}; } };
  // Igual que index.js: con plantilla, cuerpoSalidaEquipos; sin ella, texto.
  const enviarTexto = async (to, body, salida) => { cuerpos.push(salida?.plantilla ? cuerpoSalidaEquipos(to, salida) : { text: { body } }); return `wamid.${cuerpos.length}`; };
  const r = await despacharSalidasTengoCamello({ pms, pmsBaseUrl: 'http://pms', enviarTexto, logger: registro().logger,
    rutaReclamar: RUTA_EQ_RECLAMAR, rutaResultado: rutaEqResultado, etiqueta: '[equipos]' });
  assert.deepEqual(r, { enviados: 2, fallidos: 1, inciertos: 0 });
  assert.equal(cuerpos[0].type, 'template');
  assert.deepEqual(cuerpos[0].template.components[0].parameters.map((p) => p.text), ['Lechería', 'factura']);
  assert.equal(cuerpos[0].template.language.code, 'es_CO');
  assert.deepEqual(cuerpos[1], { text: { body: 'dentro de ventana' } });
  const res3 = posts.find((p) => p.url === `http://pms${rutaEqResultado(3)}`).body;
  assert.deepEqual(res3, { resultado: 'error', error: 'plantilla_invalida' });
});
