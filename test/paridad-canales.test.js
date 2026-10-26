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
  consultar_al_equipo: { tipo: 'propia_del_canal',
    motivo: 'Cami pregunta primero a Teo (2026-10-24): en el chat y las notas de voz la consulta la crea el motor del PMS al detectar el vacío de conocimiento (knowledge_unresolved); en la llamada no hay motor por turno y el modelo la registra con esta herramienta (mismo destino: consultas_teo del PMS).' },
  anotar_lista_espera: { tipo: 'propia_del_canal',
    motivo: 'En el chat la lista de espera la anota el motor del PMS al interpretar el "sí" del huésped; la voz llama al mismo mecanismo (anotarListaEsperaFueraHorizonte) por esta herramienta.' },
  ofrecer_paquete_magia: { tipo: 'propia_del_canal',
    motivo: 'Demo del Paquete Magia de TengoCamello (2026-10-24, PMS migración 950): en el chat y la nota de voz la arranca el texto disparador ("Quiero probar el Paquete Magia", enlace wa.me) en el despachador de la red del PMS; en la llamada, esta herramienta llama al mismo servicio (invitarDemo) y la demo sigue por el chat, porque vive en WhatsApp (avisos con opciones, enlaces y portal).' },
  solicitar_late_checkout: { tipo: 'propia_del_canal',
    motivo: 'SALIDA Y LATE CHECK-OUT (2026-10-26, PMS migración 998): en el chat y la nota de voz el flujo de huésped en estadía del PMS da la regla y crea el cobro (huesped-estadia/salida.service.js, solicitarLateCheckout); en la llamada, esta herramienta llama a la MISMA función y el cobro llega por el chat (no se cobra por teléfono).' },
  solicitar_early_checkin: { tipo: 'propia_del_canal',
    motivo: 'EARLY CHECK-IN (2026-10-26, PMS migración 998): en el chat y la nota de voz el flujo de huésped en estadía del PMS da la regla y registra la solicitud (solicitarHorario, sujeta a la limpieza del día anterior); en la llamada, esta herramienta llama a la MISMA función y el cobro llega por el chat.' },
  evaluar_uso_aceptable: { tipo: 'propia_del_canal',
    motivo: 'USO ACEPTABLE (2026-10-24): en el chat y la nota de voz la clasificación es el campo estructurado acceptable_use de la interpretación y el PMS decide (registra, avisa a Teo y responde); en la llamada es esta herramienta, que llama al mismo servicio del PMS (registrarUsoAceptable).' },
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
  for (const n of ['Ana', 'Mónica', 'Miguel', 'Ana Frontera', 'Carlos Mío']) assert.equal(esNombreDeMarca(n), false, n);
  assert.equal(esNombreDeMarca('La Frontera'), true);
  assert.equal(/La persona se llama Mío/.test(instruccionesCamiVoz({ hoy: '2026-10-23', nombre: 'Mío' })), false);
  assert.match(instruccionesCamiVoz({ hoy: '2026-10-23', nombre: 'Ana' }), /La persona se llama Ana/);
});

// CAMI LEE IMÁGENES (José Manuel, 2026-10-23; dominio 25). Capacidad que no es
// una herramienta del modelo, así que se declara aquí:
//  - chat: la imagen de un lead en venta se lee (inbound-image-reader.js) y su
//    lectura entra al turno como texto del cliente.
//  - nota de voz: transcrita, es un turno de texto: recibe las lecturas de las
//    imágenes de la ráfaga que Cami aún no respondió (mismo prepararTurnoImagen).
//  - llamada: no hay imágenes en el canal de voz (excepción propia del canal);
//    si la persona manda una al chat mientras habla, Cami de voz recibe un
//    AVISO DEL CHAT con lo leído (avisarImagenEnChat), con la misma guarda de
//    privacidad (documento de identidad o comprobante: ningún dato).
test('paridad de imágenes: chat lee, nota de voz hereda la lectura, la llamada recibe el aviso (2026-10-23)', async () => {
  const lector = require('../lib/pilot/inbound-image-reader');
  const voz = require('../lib/voz/cami-voz');
  const { createVozCallManager } = require('../lib/voz/call-manager');
  assert.equal(typeof lector.prepararTurnoImagen, 'function');
  assert.equal(typeof voz.avisoImagenEnChat, 'function');
  const m = createVozCallManager({ config: { habilitada: false, duracionMaxMin: 10 }, http: {}, WebSocketImpl: function () {}, pms: {},
    executePmsTool: async () => null, sendText: async () => null, logger: { info() {}, warn() {}, error() {} } });
  assert.equal(typeof m.avisarImagenEnChat, 'function');
  // Nota de voz transcrita con una imagen de venta pendiente en la ráfaga.
  const burst = lector.createImageBurst();
  burst.registrarImagen('573000000001', Promise.resolve({ categoria: 'solicitud', lectura: 'Del 2 al 9 de diciembre' }));
  const entradaTexto = lector.registrarTextoEnRafaga({ burst, phone: '573000000001', raw: 'mira lo que te mandé', begin: {}, claimed: true });
  const t = await lector.prepararTurnoImagen({ burst, phone: '573000000001', raw: 'mira lo que te mandé', entradaTexto });
  assert.match(t.text, /Del 2 al 9 de diciembre/);
});

// ONBOARDING DE PROPIETARIAS (José Manuel, 2026-10-23; dominio 25). Capacidad
// que no es una herramienta: un número marcado por el PMS como propietaria en
// onboarding no recibe cotizaciones en NINGÚN canal.
//  - chat y nota de voz: el despachador de la red del PMS (ingreso-red, paso 0)
//    la atiende antes que el flujo de huésped; nunca llega al motor comercial.
//  - llamada: /voz/llamada/inicio trae propietaria_onboarding; Cami de voz no
//    recibe herramientas comerciales, la reconoce y la remite al chat.
// ALIADOS (José Manuel, 2026-10-23; PMS migración 907; dominio 25). Capacidad
// que no es una herramienta: un número registrado como aliado no recibe
// cotizaciones en ningún canal y tiene su entrevista de descubrimiento.
//  - chat y nota de voz: el despachador de la red del PMS (ingreso-red /
//    aliados-whatsapp) atiende al aliado antes que el flujo de huésped
//    (menú, entrevista de onboarding por foco).
//  - llamada: /voz/llamada/inicio trae aliado_voz con la guía (preguntas como
//    datos); Cami de voz no recibe herramientas comerciales y conduce la
//    entrevista. EXCEPCIÓN PROPIA DEL CANAL: la entrevista de descubrimiento
//    con guía (voz_guias_entrevista) por ahora es solo de la llamada; en el
//    chat la reunión la conduce Teo a mano con la misma guía (documento).
test('aliado: la llamada no cotiza y conduce la entrevista con la guía (dominio 25, 2026-10-23)', () => {
  const { instruccionesCamiVoz, aliadoDesdeInicio, HERRAMIENTAS_COMERCIALES } = require('../lib/voz/cami-voz');
  const aliado = aliadoDesdeInicio({ perfil: 'aliado', no_cotizar: true, nombre_saludo: 'Carmen', entrevista_id: 1, duracion_max_min: 40,
    guia: { clave: 'descubrimiento_aliado', version: 1, titulo: 'Descubrimiento', secciones: [{ clave: 'negocio_hoy', titulo: 'Su negocio hoy', preguntas: ['¿Qué clientes atiende?'] }] } });
  assert.ok(aliado);
  const voz = herramientasDeVoz({ sinComerciales: true }).map((t) => t.name);
  assert.deepEqual(voz.filter((n) => HERRAMIENTAS_COMERCIALES.has(n)), []);
  const t = instruccionesCamiVoz({ hoy: '2026-10-24', aliado, duracionMaxMin: 40 });
  assert.match(t, /NO cotices/);
  assert.match(t, /Su negocio hoy/);
  assert.doesNotMatch(t, /CÓMO ATENDER UNA BÚSQUEDA/);
});

test('propietaria en onboarding: la llamada no cotiza, igual que el chat (dominio 25)', () => {
  const { instruccionesCamiVoz, HERRAMIENTAS_COMERCIALES } = require('../lib/voz/cami-voz');
  const voz = herramientasDeVoz({ sinComerciales: true }).map((t) => t.name);
  assert.deepEqual(voz.filter((n) => HERRAMIENTAS_COMERCIALES.has(n)), []);
  const t = instruccionesCamiVoz({ hoy: '2026-10-23', propietariaOnboarding: true });
  assert.match(t, /NO cotices/);
  assert.doesNotMatch(t, /CÓMO ATENDER UNA BÚSQUEDA/);
});

// USO ACEPTABLE (José Manuel, 2026-10-24; PMS uso_aceptable_v1, migración 930;
// dominio 25). Mismo comportamiento en los tres canales: el modelo clasifica el
// pedido contra la política y, si es prohibido o restringido, Cami no ejecuta,
// se registra el evento y se avisa a Teo.
//  - chat: campo acceptable_use de la interpretación (ai.js y esquema V2).
//  - nota de voz: transcrita es un turno de chat; llega marcada canal nota_voz.
//  - llamada: herramienta evaluar_uso_aceptable en TODOS los perfiles (venta,
//    sin comerciales, aliado) + la instrucción en las dos instrucciones de voz.
test('paridad del filtro de uso aceptable: chat, nota de voz y llamada (2026-10-24)', () => {
  const Module = require('node:module');
  const original = Module._resolveFilename;
  Module._resolveFilename = function r(req, ...rest) { return req === '@anthropic-ai/sdk' ? req : original.call(this, req, ...rest); };
  require.cache['@anthropic-ai/sdk'] = require.cache['@anthropic-ai/sdk'] || { id: '@anthropic-ai/sdk', filename: '@anthropic-ai/sdk', loaded: true, exports: class {} };
  try {
    const { interpretationSchema } = require('../lib/pilot/ai');
    const { interpretationSchemaV2 } = require('../lib/pilot/llm/interpretation-schema-v2');
    assert.ok(interpretationSchema.required.includes('acceptable_use'));
    assert.ok(interpretationSchemaV2.required.includes('acceptable_use'));
  } finally { Module._resolveFilename = original; }
  const { instruccionesCamiVoz, aliadoDesdeInicio } = require('../lib/voz/cami-voz');
  for (const o of [{}, { sinComerciales: true }, { aliado: true }]) {
    assert.ok(herramientasDeVoz(o).some((h) => h.name === 'evaluar_uso_aceptable'), JSON.stringify(o));
  }
  const aliado = aliadoDesdeInicio({ perfil: 'aliado', no_cotizar: true, guia: { clave: 'g', secciones: [{ clave: 'negocio_hoy', titulo: 'Negocio', preguntas: ['¿Qué hace?'] }] } });
  assert.match(instruccionesCamiVoz({ hoy: '2026-10-24', aliado, duracionMaxMin: 40 }), /USO ACEPTABLE/);
  assert.match(instruccionesCamiVoz({ hoy: '2026-10-24' }), /USO ACEPTABLE/);
});

// DEMO DEL PAQUETE MAGIA (José Manuel, 2026-10-24; PMS migración 950; dominio
// 25). Mismo comportamiento en los tres canales: quien está en la demo no
// recibe cotizaciones de alojamiento.
//  - chat y nota de voz: el despachador de la red del PMS (ingreso-red, paso 0b)
//    atiende al dueño de la demo y a los clientes del negocio demo antes que el
//    flujo de huésped.
//  - llamada: /voz/llamada/inicio trae paquete_magia; Cami de voz no recibe
//    herramientas comerciales y lo remite al chat (EXCEPCIÓN PROPIA DEL CANAL:
//    la demo se vive por WhatsApp; la llamada solo la ofrece y la arranca).
test('dueño de la demo del Paquete Magia: la llamada no cotiza, igual que el chat (dominio 25)', () => {
  const { instruccionesCamiVoz, HERRAMIENTAS_COMERCIALES } = require('../lib/voz/cami-voz');
  const voz = herramientasDeVoz({ sinComerciales: true, paqueteMagia: true }).map((t) => t.name);
  assert.deepEqual(voz.filter((n) => HERRAMIENTAS_COMERCIALES.has(n)), []);
  assert.equal(voz.includes('ofrecer_paquete_magia'), false);
  assert.equal(herramientasDeVoz({ aliado: true }).some((t) => t.name === 'ofrecer_paquete_magia'), true);
  const t = instruccionesCamiVoz({ hoy: '2026-10-24', paqueteMagia: true });
  assert.match(t, /NO cotices/);
  assert.doesNotMatch(t, /CÓMO ATENDER UNA BÚSQUEDA/);
});
