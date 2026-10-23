'use strict';

// PARIDAD DE CANALES: Cami de voz = Cami de chat (José Manuel, 2026-10-23;
// MAPA_DOMINIOS dominio 25 "conversacion.paridad_canales", 2026-10-23).
// Todo lo que Cami de ventas puede hacer por chat también debe poder hacerlo
// por llamada. Esta prueba compara las herramientas comerciales que recibe el
// modelo del chat (lib/pilot/llm/tools.js -> toolsForModel) con las de la voz
// (lib/voz/cami-voz.js -> herramientasDeVoz) y falla si una existe en un canal
// y no en el otro, salvo las excepciones declaradas aquí, cada una con motivo.
//
// Para agregar una herramienta a un solo canal hay que declararla aquí: o es
// propia del canal (con motivo) o es TEMPORAL "pendiente de paridad" (y se
// reporta a José Manuel). Una excepción que ya no hace falta también falla,
// para que la lista no se pudra.
//
// Ojo: esta prueba solo ve HERRAMIENTAS. Gran parte de la venta por chat no es
// una herramienta del modelo sino el motor determinista del PMS (propuestas,
// pre-reserva, pago, pre-confirmación, fechas cercanas): esas brechas se
// inventarían aparte y no las detecta esta prueba.

const test = require('node:test');
const assert = require('node:assert/strict');
const { toolsForModel } = require('../lib/pilot/llm/tools');
const { herramientasDeVoz } = require('../lib/voz/cami-voz');

// Herramientas que solo existen en el chat.
const SOLO_CHAT = {
  resolve_apartment_reference: { tipo: 'propia_del_canal',
    motivo: 'En voz el código lo normaliza normalizarArgsVoz ("el 510" -> LF-510) y el PMS resuelve la identidad canónica en check_availability/quote_stay (conCodigoCanonico); la voz no necesita la herramienta aparte.' },
};

// Herramientas que solo existen en la voz.
const SOLO_VOZ = {
  terminar_llamada: { tipo: 'propia_del_canal', motivo: 'Colgar la llamada; no existe en el chat.' },
  enviar_opciones_al_chat: { tipo: 'propia_del_canal',
    motivo: 'Durante la llamada las opciones y fotos se mandan al WhatsApp; en el chat el motor del PMS las presenta en el propio mensaje.' },
  pedir_persona: { tipo: 'propia_del_canal',
    motivo: 'Aviso inmediato a José Manuel durante la llamada; en el chat lo hace el motor del PMS con la interpretación (requests_human / queja / emergencia).' },
  anotar_lista_espera: { tipo: 'propia_del_canal',
    motivo: 'En el chat la lista de espera la anota el motor del PMS al interpretar el "sí" del huésped; la voz llama al mismo mecanismo (anotarListaEsperaFueraHorizonte) por esta herramienta.' },
};

const TIPOS = new Set(['propia_del_canal', 'pendiente de paridad']);

test('paridad de herramientas comerciales entre chat y voz (dominio 25, 2026-10-23)', () => {
  const chat = new Set(toolsForModel().map((t) => t.name));
  const voz = new Set(herramientasDeVoz().map((t) => t.name));
  const soloChat = [...chat].filter((n) => !voz.has(n)).sort();
  const soloVoz = [...voz].filter((n) => !chat.has(n)).sort();
  assert.deepEqual(soloChat.filter((n) => !SOLO_CHAT[n]), [], 'herramienta del chat sin equivalente en la voz: agrégala a la voz o declárala en SOLO_CHAT con motivo');
  assert.deepEqual(soloVoz.filter((n) => !SOLO_VOZ[n]), [], 'herramienta de la voz sin equivalente en el chat: agrégala al chat o declárala en SOLO_VOZ con motivo');
  // Excepciones vencidas: declaradas pero ya sin diferencia.
  assert.deepEqual(Object.keys(SOLO_CHAT).filter((n) => !soloChat.includes(n)), [], 'excepción SOLO_CHAT que ya no aplica: quítala');
  assert.deepEqual(Object.keys(SOLO_VOZ).filter((n) => !soloVoz.includes(n)), [], 'excepción SOLO_VOZ que ya no aplica: quítala');
  for (const [n, e] of Object.entries({ ...SOLO_CHAT, ...SOLO_VOZ })) {
    assert.ok(TIPOS.has(e.tipo), `${n}: tipo de excepción inválido`);
    assert.ok(String(e.motivo || '').length > 20, `${n}: falta el motivo`);
  }
});

// Paridad del filtro de nombre: la lista de marca de la voz es la misma que el
// PMS agrego a PALABRAS_NEGOCIO (src/shared/nombre-huesped.js, 2026-10-23).
test('la voz no llama a la persona por el nombre de la marca ("Con gusto, Mío", 2026-10-23)', () => {
  const { instruccionesCamiVoz, esNombreDeMarca, PALABRAS_MARCA } = require('../lib/voz/cami-voz');
  assert.deepEqual([...PALABRAS_MARCA].sort(), ['frontera', 'lofts', 'mio', 'miu', 'versadaa']);
  for (const n of ['Mío', 'Mío La Frontera', 'Miu', 'Versadaa']) assert.equal(esNombreDeMarca(n), true, n);
  for (const n of ['Ana', 'Mónica', 'Miguel']) assert.equal(esNombreDeMarca(n), false, n);
  assert.equal(/La persona se llama Mío/.test(instruccionesCamiVoz({ hoy: '2026-10-23', nombre: 'Mío' })), false);
  assert.match(instruccionesCamiVoz({ hoy: '2026-10-23', nombre: 'Ana' }), /La persona se llama Ana/);
});
