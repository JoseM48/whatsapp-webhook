'use strict';

// PRESENTACION DE PRECIOS v2 (decision de Jose Manuel, 2026-10-09). El
// redactor escribe [[PRECIOS]] y el webhook pone el bloque exacto que armo el
// PMS para las unidades presentadas; el validador del PMS exige el bloque
// literal y rechaza el total de una estadia de 30+ al cotizar.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { resolveWrittenReply, writerViewOfPacket, insertarBloquePrecios, WRITER_SYSTEM_PROMPT } = require('../lib/pilot/llm/writer.js');

const NOTA = 'Valor fijo durante tu estadía; en estadías de más de 3 meses se revisa cada 3 meses.';
const ANTICIPO = 'Para separar pagas un anticipo de $600.000. Antes de tu llegada pagas el primer mes (puedes pagar el resto mes a mes) y el anticipo queda como depósito por posibles daños, que se te devuelve al finalizar tu estadía si todo está bien.';
const B_TODOS = `Estos dos apartamentos tienen el mismo valor: $3.100.000 al mes · 90 noches\n• LF-210\n• LF-404\nLF-1208: $3.224.000 al mes · 90 noches\n\n${NOTA}\n${ANTICIPO}`;
const B_210 = `LF-210: $3.100.000 al mes · 90 noches\n\n${NOTA}\n${ANTICIPO}`;
const B_210_404 = `Estos dos apartamentos tienen el mismo valor: $3.100.000 al mes · 90 noches\n• LF-210\n• LF-404\n\n${NOTA}\n${ANTICIPO}`;

const PAQUETE = {
  packet_version: 2, action: 'PROPUESTA PRESENTADA', deterministic_text: `Tengo estas opciones:\n${B_TODOS}`,
  numbers: ['$3.100.000', '$3.224.000', '$600.000'].map((formatted, i) => ({ id: `precio.bloque.${i + 1}`, label: 'cifra del bloque', formatted })),
  dates: [], apartments: ['LF-210', 'LF-404', 'LF-1208'], facts: [], notes: [], suggested_goals: [],
  required_facts: [{ id: 'no_real_money', statement: 'sin dinero real', patterns: ['sin dinero'] }],
  forbidden_claims: [], semantic_claims: [], ui: { message_kind: 'text', photo_target_codes: [] },
  presentation: { mode: 'candidates', min: 1, max: 3, cover_codes: ['LF-210', 'LF-404', 'LF-1208'],
    candidates: ['LF-210', 'LF-404', 'LF-1208'].map((code) => ({ code, bookable_now: true,
      options: [{ total: code === 'LF-1208' ? '$3.224.000' : '$3.100.000', deposit: '$600.000', requires_policy: false,
        price_text: `${code === 'LF-1208' ? '$3.224.000' : '$3.100.000'} al mes · 90 noches` }] })) },
  unit_context: [], allowed_moves: ['present_subset'],
  price_presentation: { version: 'presentacion_precios_v2', placeholder: '[[PRECIOS]]', block_text: B_TODOS,
    block_codes: ['LF-210', 'LF-404', 'LF-1208'],
    blocks: [{ codes: ['LF-210'], text: B_210 }, { codes: ['LF-210', 'LF-404'], text: B_210_404 }],
    amounts: ['$3.100.000', '$3.224.000', '$600.000'], hidden_totals: ['$9.300.000', '$9.672.000'] }
};
const silencio = { info() {}, warn() {}, error() {} };
function proveedor(respuestas) {
  const llamadas = [];
  return { model: 'fake', llamadas, async structured(req) {
    llamadas.push(req);
    const [reply, codes] = respuestas.shift();
    return { output: { reply, presented_codes: codes, send_photos: [] } };
  } };
}
async function validadorPms() {
  const raiz = process.env.M0_PMS_SOURCE_ROOT || 'D:/DESARROLLOS/_WORKTREES/bloque-precios';
  const ruta = path.join(raiz, 'src/modules/supervised-pilot/m0-response-validator.js');
  if (!fs.existsSync(ruta)) return null;
  const { validateAuthorizedResponse } = await import(pathToFileURL(ruta).href);
  return { async validateAuthorizedResponse({ packet, candidate_text, presented_codes }) {
    return validateAuthorizedResponse(packet, candidate_text, presented_codes ? { presentedCodes: presented_codes } : {});
  } };
}

test('la marca se cambia por el bloque del conjunto presentado (o el del determinista)', () => {
  assert.equal(insertarBloquePrecios(PAQUETE, 'Te muestro una:\n[[PRECIOS]]\n¿Te sirve?', ['LF-210']), `Te muestro una:\n${B_210}\n¿Te sirve?`);
  assert.equal(insertarBloquePrecios(PAQUETE, '[[PRECIOS]]', ['LF-404', 'LF-210']), B_210_404);
  assert.equal(insertarBloquePrecios(PAQUETE, '[[PRECIOS]]', ['LF-210', 'LF-404', 'LF-1208']), B_TODOS);
  // conjunto sin bloque: no se inventa nada (el validador lo rechaza)
  assert.equal(insertarBloquePrecios(PAQUETE, 'x [[PRECIOS]]', ['LF-1208']), 'x [[PRECIOS]]');
  // marca repetida: una sola insercion
  assert.equal(insertarBloquePrecios(PAQUETE, '[[PRECIOS]]\n[[PRECIOS]]', ['LF-210']), B_210);
  // sin presentacion v2 el texto no cambia
  assert.equal(insertarBloquePrecios({ ...PAQUETE, price_presentation: undefined }, 'a [[PRECIOS]]', ['LF-210']), 'a [[PRECIOS]]');
});

test('el redactor ve la marca y la vista previa, no las variantes; el prompt lo explica', () => {
  const vista = writerViewOfPacket(PAQUETE);
  assert.deepEqual(vista.price_block, { placeholder: '[[PRECIOS]]', preview: B_TODOS });
  assert.equal(vista.presentation.candidates[0].options[0].price_text, '$3.100.000 al mes · 90 noches');
  assert.equal(writerViewOfPacket({ ...PAQUETE, price_presentation: undefined }).price_block, null);
  assert.match(WRITER_SYSTEM_PROMPT, /PRICE BLOCK \(decision of José Manuel, 2026-10-09\)/);
  assert.match(WRITER_SYSTEM_PROMPT, /never give the total of a stay of 30 nights or more/);
});

test('con el validador real del PMS: la marca pasa; el total de 30+ escrito a mano se rechaza y sale el determinista', async (t) => {
  const pms = await validadorPms();
  if (!pms) return t.skip('sin checkout de pms-lite (M0_PMS_SOURCE_ROOT)');
  const ok = await resolveWrittenReply({ packet: PAQUETE, provider: proveedor([['Para dos personas te muestro estas:\n[[PRECIOS]]\nSin dinero de por medio todavía. ¿Cuál te gusta?', ['LF-210', 'LF-404']]]),
    pms, guestText: 'hola', transcript: [], logger: silencio });
  assert.equal(ok.presentation_source, 'llm_written', JSON.stringify(ok.failure_reasons));
  assert.ok(ok.text.includes(B_210_404));
  assert.ok(!ok.text.includes('[[PRECIOS]]'));
  // Lo que se observo en produccion: el total de 90 noches, escrito por el modelo.
  const mal = await resolveWrittenReply({ packet: PAQUETE, provider: proveedor([
    ['LF-210: COP 9.300.000 por 90 noches, anticipo COP 600.000. Sin dinero todavía.', ['LF-210']],
    ['LF-210: $9.300.000 en total. Sin dinero todavía.', ['LF-210']]]),
  pms, guestText: 'hola', transcript: [], logger: silencio });
  assert.equal(mal.presentation_source, 'deterministic_after_rejection');
  assert.equal(mal.text, PAQUETE.deterministic_text);
  assert.ok(mal.failure_reasons.includes('total_30_plus_in_quote:COP 9.300.000'), mal.failure_reasons.join(','));
  assert.ok(mal.failure_reasons.includes('price_block_missing'));
});
