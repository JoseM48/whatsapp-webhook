'use strict';

// CAMI MULTIPROPIEDAD, paquete P6 (diseño docs/02_NEGOCIO_OPERACION/A22/DISENO_CAMI_MULTIPROPIEDAD.md
// §1.3, §2.1 punto 9, §4 R3 y R9): prompts y códigos por propiedad.
//   1. Miu idéntico: los prompts y esquemas de Miu son byte a byte los de antes de P6
//      (huellas tomadas de la base 1eb0a0c).
//   2. A22 sin ninguna palabra prohibida (Miu, Frontera, Poblado, Medellín, 2.000 reseñas, LF-).
//   3. Validadores de código por propiedad.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const mp = require('../lib/pilot/marca-propiedad');
const writer = require('../lib/pilot/llm/writer');
const engine = require('../lib/pilot/llm/conversational-engine');
const schemaV2 = require('../lib/pilot/llm/interpretation-schema-v2');
const ai = require('../lib/pilot/ai');
const uso = require('../lib/pilot/uso-aceptable');
const rutas = require('../lib/pilot/rutas-intencion');
const { createM0CommercialResponder } = require('../lib/pilot/m0-commercial-responder');
const { crearSalidaPorNumero } = require('../lib/pilot/numero-propiedad');

const sha = (t) => crypto.createHash('sha256').update(typeof t === 'string' ? t : JSON.stringify(t)).digest('hex');

// Huellas de la base 1eb0a0c (antes de P6). Si cambia un prompt de Miu a propósito, se
// actualiza aquí en el mismo commit (y se revisa que A22 siga limpio).
const HUELLAS_MIU = {
  writer: '14adf9105de20b39ae31b57bba5e10e4f08ed71bf0dc3ca3ec66028662e1facb',
  comprension: 'fa67e4009bc42a5aa2cec50a5724179c13a4f7d6079e39801343e065ff66da06',
  interpretacion: '0281a52deb05c59ac616eaa281dc1e20adbb80315dfbfdcbce9557d1497320e7',
  redaccion: '7866fa7da6b519b5a98a968d91967c8f6d7158deb4fa9e782a60e3a467b0e1e2',
  reescritura_es: '3843a22dd179b749fae15097c8b0904482031766163d5843fced9c92eb998007',
  esquema_v2: '014e800d55b1da29682d1feda1a2306fee863edeeb9c545fa01c9559f33d6c23',
  esquema_v1: '90e7cd28eee6b4f2ca1f5c4053797949670c5d94ea212b8d3b78968bde5aa00e'
};

// Palabras prohibidas para otra propiedad (R3). Independiente del módulo a propósito.
const PROHIBIDAS = [/\bmi[uú]/i, /frontera/i, /poblado/i, /medell[ií]n/i, /2\.000\s*rese[ñn]as/i, /LF-/i];
function prohibidasEn(texto) { return PROHIBIDAS.filter((re) => re.test(String(texto))).map(String); }

const DATOS_A22 = { property_key: 'a22', nombre_marca: 'Studio A22 Coliving', ciudad: 'Cali', zona: 'Pance' };
const MARCAS_NO_MIU = [
  ['a22 con datos del PMS', mp.marcaDePropiedad('a22', DATOS_A22)],
  ['a22 sin datos (genérico)', mp.marcaDePropiedad('a22')],
  ['propiedad desconocida', mp.marcaDePropiedad('propiedad_desconocida')]
];

// Todos los prompts del chat y la nota de voz para una marca.
function promptsPara(marca) {
  return {
    writer: writer.writerSystemPrompt(marca),
    reescritura: writer.reescrituraSystem(marca),
    comprension: engine.comprehensionSystemPrompt(marca),
    interpretacion: ai.sistemaInterpretacion(marca),
    redaccion: ai.sistemaRedaccion(marca)
  };
}

test('P6 Miu idéntico: sin propiedad o con "miu", cada prompt es el de siempre (byte a byte)', () => {
  for (const marca of [mp.marcaDePropiedad(undefined), mp.marcaDePropiedad(null), mp.marcaDePropiedad('miu'),
    mp.marcaDePropiedad(' MIU '), mp.marcaDePropiedad('miu', DATOS_A22), null]) {
    const p = promptsPara(marca);
    assert.equal(p.writer, writer.WRITER_SYSTEM_PROMPT);
    assert.equal(sha(p.writer), HUELLAS_MIU.writer);
    assert.equal(p.comprension, engine.SYSTEM_PROMPT);
    assert.equal(sha(p.comprension), HUELLAS_MIU.comprension);
    assert.equal(p.interpretacion, ai.INTERPRET_SYSTEM_PROMPT);
    assert.equal(sha(p.interpretacion), HUELLAS_MIU.interpretacion);
    assert.equal(p.redaccion, ai.REDACTION_SYSTEM_PROMPT);
    assert.equal(sha(p.redaccion), HUELLAS_MIU.redaccion);
    assert.equal(p.reescritura, writer.REESCRITURA_SYSTEM);
    assert.equal(sha(p.reescritura.replace('LANGUAGE', 'es')), HUELLAS_MIU.reescritura_es);
  }
  // Los textos de Miu siguen diciendo lo de siempre.
  assert.match(writer.WRITER_SYSTEM_PROMPT, /Miu La Frontera \(furnished apartments for monthly stays in El Poblado, Medellín\)/);
  assert.match(writer.WRITER_SYSTEM_PROMPT, /más de 2\.000 reseñas/);
  assert.equal(uso.INSTRUCCION_CHAT.includes("NOT Miu's own lodging"), true);
});

test('P6 Miu idéntico: esquemas y lectura de códigos de Miu sin cambio', () => {
  assert.equal(schemaV2.esquemaInterpretacionV2Para('miu'), schemaV2.interpretationSchemaV2);
  assert.equal(schemaV2.esquemaInterpretacionV2Para(undefined), schemaV2.interpretationSchemaV2);
  assert.equal(sha(schemaV2.interpretationSchemaV2), HUELLAS_MIU.esquema_v2);
  assert.equal(ai.esquemaInterpretacion(mp.MARCA_MIU), ai.interpretationSchema);
  assert.equal(sha(ai.interpretationSchema), HUELLAS_MIU.esquema_v1);
  assert.equal(ai.extractApartmentCode('quiero el lf 210'), 'LF-210');
  assert.equal(ai.extractApartmentCode('el LF-1109 por favor'), 'LF-1109');
  assert.equal(ai.extractApartmentCode('el A22-01'), null);
  assert.equal(ai.deterministicInterpret('me interesa el LF-904', { today: '2026-11-23' }).requested_apartment_code, 'LF-904');
});

test('P6 A22: ningún prompt dice Miu, Frontera, Poblado, Medellín, 2.000 reseñas ni LF-', () => {
  for (const [nombre, marca] of MARCAS_NO_MIU) {
    for (const [cual, texto] of Object.entries(promptsPara(marca))) {
      assert.deepEqual(prohibidasEn(texto), [], `${nombre} / ${cual}`);
      assert.ok(texto.length > 200, `${nombre} / ${cual}: no puede quedar vacío`);
    }
  }
  const p = promptsPara(mp.marcaDePropiedad('a22', DATOS_A22));
  assert.match(p.writer, /^You are Cami, the WhatsApp assistant of Studio A22 Coliving \(furnished lodging for monthly stays in Pance, Cali\)\./);
  assert.match(p.writer, /<INTRO> is "Soy Cami, la asistente virtual de Studio A22 Coliving\."/);
  assert.match(p.writer, /"A22-01"/);
  assert.match(p.comprension, /assistant for Studio A22 Coliving \(furnished lodging rentals in Pance, Cali\)/);
  assert.match(p.comprension, /anywhere outside Cali and its metropolitan area\./);
  assert.match(p.redaccion, /assistant for Studio A22 Coliving \(short-term rentals in Pance, Cali\)/);
  // Lo demás del prompt es el mismo (mismas reglas que Miu): solo cambian los fragmentos de marca.
  assert.ok(p.writer.length > writer.WRITER_SYSTEM_PROMPT.length * 0.95);
  const generica = promptsPara(mp.marcaDePropiedad('a22'));
  assert.match(generica.writer, /assistant of this property \(furnished lodging for monthly stays\)/);
});

test('P6: cada texto a reemplazar existe hoy en el prompt de Miu (si alguien lo cambia, esta prueba avisa)', () => {
  assert.deepEqual(mp.reemplazosFaltantes(writer.WRITER_SYSTEM_PROMPT, writer.REEMPLAZOS_WRITER), []);
  assert.deepEqual(mp.reemplazosFaltantes(writer.REESCRITURA_SYSTEM, writer.REEMPLAZOS_REESCRITURA), []);
  assert.deepEqual(mp.reemplazosFaltantes(engine.SYSTEM_PROMPT, engine.REEMPLAZOS_COMPRENSION), []);
  assert.deepEqual(mp.reemplazosFaltantes(uso.INSTRUCCION_CHAT, uso.REEMPLAZOS_CHAT), []);
  assert.deepEqual(mp.reemplazosFaltantes(rutas.INSTRUCCION_CHAT, rutas.REEMPLAZOS_CHAT), []);
  assert.deepEqual(mp.reemplazosFaltantes(ai.REDACTION_SYSTEM_PROMPT, ai.REEMPLAZOS_REDACCION), []);
});

test('P6: un dato de marca del PMS que menciona a Miu, o que es de otra propiedad, no se usa', () => {
  const sucia = mp.marcaDePropiedad('a22', { property_key: 'a22', nombre_marca: 'Miu Pance', ciudad: 'Medellín', zona: 'El Poblado',
    presentacion: 'Soy Cami, de Miu La Frontera con más de 2.000 reseñas.' });
  assert.equal(sucia.nombre, null);
  assert.equal(sucia.ciudad, null);
  assert.equal(sucia.zona, null);
  assert.equal(sucia.presentacion, 'Soy Cami, la asistente virtual.');
  const ajena = mp.marcaDePropiedad('a22', { property_key: 'otra', nombre_marca: 'Otra Marca', ciudad: 'Bogotá' });
  assert.equal(ajena.nombre, null);
  assert.equal(ajena.ciudad, null);
  for (const texto of Object.values(promptsPara(sucia))) assert.deepEqual(prohibidasEn(texto), []);
  // Presentación y credenciales aprobadas por el PMS.
  const conResenas = mp.marcaDePropiedad('a22', { ...DATOS_A22, credenciales: { resenas: 35 } });
  assert.equal(conResenas.presentacion, 'Soy Cami, la asistente virtual de Studio A22 Coliving con 35 reseñas.');
  const conFrase = mp.marcaDePropiedad('a22', { ...DATOS_A22, presentacion: 'Soy Cami, de Studio A22 Coliving en Pance.' });
  assert.equal(conFrase.presentacion, 'Soy Cami, de Studio A22 Coliving en Pance.');
});

test('P6: adaptarTexto falla cerrado si queda una mención de Miu', () => {
  const marca = mp.marcaDePropiedad('a22', DATOS_A22);
  assert.throws(() => mp.adaptarTexto('Hola desde Miu La Frontera', [], marca), (e) => e.code === 'marca_con_mencion_miu');
  assert.equal(mp.adaptarTexto('Hola desde Miu La Frontera', [], mp.MARCA_MIU), 'Hola desde Miu La Frontera');
});

test('P6: la propiedad del turno — cualquier pista de otra propiedad gana; sin pistas, Miu', () => {
  assert.equal(mp.resolverPropiedadTurno(), 'miu');
  assert.equal(mp.resolverPropiedadTurno(null, 'miu', ''), 'miu');
  assert.equal(mp.resolverPropiedadTurno('miu', 'A22'), 'a22');
  assert.equal(mp.resolverPropiedadTurno(null, undefined, 'propiedad_desconocida'), 'propiedad_desconocida');
  assert.equal(writer.marcaDelTurno({ packet: { deterministic_text: 'x' } }), mp.MARCA_MIU);
  assert.equal(writer.marcaDelTurno({ packet: { property_key: 'a22', marca: DATOS_A22 } }).nombre, 'Studio A22 Coliving');
  assert.equal(writer.marcaDelTurno({ packet: {}, propiedad: 'a22', marca: DATOS_A22 }).nombre, 'Studio A22 Coliving');
  assert.equal(engine.marcaDeContexto({}), mp.MARCA_MIU);
  assert.equal(engine.marcaDeContexto({ property_key: 'a22', marca: DATOS_A22 }).lugar, 'Pance, Cali');
});

test('P6 validadores: códigos de A22 en A22, LF- solo en Miu, ninguno en una propiedad sin patrón', () => {
  assert.equal(mp.extraerCodigoApartamento('quiero la A22-01', 'a22'), 'A22-01');
  assert.equal(mp.extraerCodigoApartamento('la a22 12 está libre?', 'a22'), 'A22-12');
  assert.equal(mp.extraerCodigoApartamento('el A22-101', 'a22'), 'A22-101');
  assert.equal(mp.extraerCodigoApartamento('el LF-210', 'a22'), null);
  assert.equal(mp.extraerCodigoApartamento('el LF-210', 'otra'), null);
  assert.equal(mp.extraerCodigoApartamento('el A22-01', 'miu'), null);
  assert.equal(mp.codigoValido('A22-07', 'a22'), true);
  assert.equal(mp.codigoValido('LF-210', 'a22'), false);
  assert.equal(mp.codigoValido('LF-210', 'miu'), true);
  assert.equal(mp.codigoValido('A22-07', 'miu'), false);
  // Esquema v2 (chat y nota de voz): patrón de la propiedad, sin tocar el de Miu.
  const e22 = schemaV2.esquemaInterpretacionV2Para('a22');
  assert.notEqual(e22, schemaV2.interpretationSchemaV2);
  assert.equal(e22.properties.references.items.properties.resolved_code.pattern, '^A22-[0-9]{2,3}$');
  assert.equal(schemaV2.interpretationSchemaV2.properties.references.items.properties.resolved_code.pattern, '^LF-[0-9]{3,4}$');
  const eOtra = schemaV2.esquemaInterpretacionV2Para('otra');
  assert.equal(eOtra.properties.references.items.properties.resolved_code.type, 'null');
  assert.equal(eOtra.properties.references.items.properties.resolved_code.pattern, undefined);
  // Esquema e intérprete legacy.
  const l22 = ai.esquemaInterpretacion(mp.marcaDePropiedad('a22'));
  assert.equal(l22.properties.requested_apartment_code.pattern, '^A22-[0-9]{2,3}$');
  assert.equal(ai.interpretationSchema.properties.requested_apartment_code.pattern, '^LF-[0-9]{3,4}$');
  const ctx = { property_key: 'a22' };
  assert.equal(ai.deterministicInterpret('me interesa la A22-03', { today: '2026-11-23', context: ctx }).requested_apartment_code, 'A22-03');
  assert.equal(ai.deterministicInterpret('me interesa el LF-904', { today: '2026-11-23', context: ctx }).requested_apartment_code, null);
  assert.equal(ai.reconcileInterpretation('hola', { requested_apartment_code: 'LF-904' }, { today: '2026-11-23', context: ctx }).requested_apartment_code, null);
  assert.equal(ai.reconcileInterpretation('hola', { requested_apartment_code: 'A22-04' }, { today: '2026-11-23', context: ctx }).requested_apartment_code, 'A22-04');
});

// Proveedor falso: guarda lo que recibe el modelo.
function proveedorQueGuarda(respuesta = { output: { reply: 'Hola', presented_codes: [], send_photos: [] } }) {
  const llamadas = [];
  return { llamadas, model: 'falso', async structured(args) { llamadas.push(args); return respuesta; } };
}

test('P6 redactor: sin pista usa el prompt de Miu; con propiedad A22 (fila o paquete) usa el de A22', async () => {
  const pms = { async validateAuthorizedResponse() { return { valid: true }; } };
  const base = { pms, guestText: 'hola', transcript: [], interpretation: null, language: 'es', today: '2026-11-23', logger: { info() {}, error() {} } };
  const miu = proveedorQueGuarda();
  await writer.resolveWrittenReply({ ...base, packet: { deterministic_text: 'Hola.' }, provider: miu });
  assert.equal(miu.llamadas[0].system, writer.WRITER_SYSTEM_PROMPT);
  const porFila = proveedorQueGuarda();
  await writer.resolveWrittenReply({ ...base, packet: { deterministic_text: 'Hola.' }, provider: porFila, propiedad: 'a22' });
  assert.deepEqual(prohibidasEn(porFila.llamadas[0].system), []);
  const porPaquete = proveedorQueGuarda();
  await writer.resolveWrittenReply({ ...base, packet: { deterministic_text: 'Hola.', property_key: 'a22', marca: DATOS_A22 }, provider: porPaquete });
  assert.match(porPaquete.llamadas[0].system, /Studio A22 Coliving/);
  assert.deepEqual(prohibidasEn(porPaquete.llamadas[0].system), []);
});

test('P6 comprensión (chat y nota de voz): el contexto del PMS decide prompt y esquema', async () => {
  const respuesta = { output: null, stop_reason: 'end_turn' };
  const miu = proveedorQueGuarda(respuesta);
  await engine.interpretConversationally({ text: 'hola', today: '2026-11-23', transcript: [], commercialContext: {} },
    { provider: miu, executor: { async execute() { return {}; } }, logger: { info() {}, warn() {}, error() {} } });
  assert.equal(miu.llamadas[0].system, engine.SYSTEM_PROMPT);
  assert.equal(miu.llamadas[0].schema, schemaV2.interpretationSchemaV2);
  const a22 = proveedorQueGuarda(respuesta);
  await engine.interpretConversationally({ text: 'hola', today: '2026-11-23', transcript: [], commercialContext: { property_key: 'a22', marca: DATOS_A22 } },
    { provider: a22, executor: { async execute() { return {}; } }, logger: { info() {}, warn() {}, error() {} } });
  assert.deepEqual(prohibidasEn(a22.llamadas[0].system), []);
  assert.equal(a22.llamadas[0].schema.properties.references.items.properties.resolved_code.pattern, '^A22-[0-9]{2,3}$');
});

test('P6 intérprete legacy y redacción: Miu igual; A22 sin Miu', async () => {
  const sistemas = [];
  const client = { messages: { async create(a) { sistemas.push(a); throw new Error('falla_de_prueba'); } } };
  const pilot = new ai.PilotAi({ client, apiKey: 'k' });
  const errorOriginal = console.error; console.error = () => {};
  try {
    await pilot.interpret({ text: 'hola', today: '2026-11-23', context: {} });
    await pilot.interpret({ text: 'hola', today: '2026-11-23', context: { property_key: 'a22', marca: DATOS_A22 } });
    await pilot.redact({ packet: {} });
    await pilot.redact({ packet: { property_key: 'a22', marca: DATOS_A22 } });
  } finally { console.error = errorOriginal; }
  assert.equal(sistemas[0].system, ai.INTERPRET_SYSTEM_PROMPT);
  assert.deepEqual(prohibidasEn(sistemas[1].system), []);
  assert.equal(sistemas[2].system, ai.REDACTION_SYSTEM_PROMPT);
  assert.deepEqual(prohibidasEn(sistemas[3].system), []);
});

test('P6 entrada: un mensaje a un número de propiedad lleva la propiedad en el contexto; Miu sin cambio', async () => {
  const contextoPms = { pending_fields: ['check_in'] };
  const hacer = (propiedadDeNumero) => createM0CommercialResponder({
    async capture() { return { captured: true }; },
    ai: { async interpret() { throw new Error('no'); } },
    closedPilot: { async beginCommercial() { return { result: { processing_claimed: true, context: contextoPms, outboxes: [] } }; } },
    pms: { async processingFailure() {} }, propiedadDeNumero
  });
  const input = { from: '573001112233', text: 'hola', messageId: 'wamid.p6.1', timestamp: '2026-11-23T10:00:00-05:00' };
  const miu = await hacer(() => 'a22').captureAndAcknowledge(input);
  assert.equal(miu.context, contextoPms);
  const a22 = await hacer((id) => (id === '1234567555' ? 'a22' : null)).captureAndAcknowledge({ ...input, phoneNumberId: '1234567555' });
  assert.equal(a22.context.property_key, 'a22');
  const sinLista = await hacer(null).captureAndAcknowledge({ ...input, phoneNumberId: '1234567555' });
  assert.equal(sinLista.context.property_key, 'propiedad_desconocida');
});

test('P6 salida: la propiedad del número de salida en curso (null = Miu)', async () => {
  const numerosPropiedad = { todosIds: () => new Set(['1234567555']), propiedadDe: (id) => (id === '1234567555' ? 'a22' : null) };
  const salida = crearSalidaPorNumero({ miuId: '1111111111', numerosPropiedad });
  assert.equal(salida.propiedadActual(), null);
  assert.equal(await salida.run(null, async () => salida.propiedadActual()), null);
  assert.equal(await salida.run('1234567555', async () => salida.propiedadActual()), 'a22');
  assert.equal(await salida.run('9999999999', async () => salida.propiedadActual()), 'propiedad_desconocida');
});
