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
  enviar_wifi_al_chat: { tipo: 'propia_del_canal',
    motivo: 'WI-FI (2026-11-21, caso lead 366): en el chat y la nota de voz el PMS responde la red y la clave sin el modelo (huesped-estadia: menú y responderWifiAlojado); en la llamada esta herramienta llama a la MISMA función (wifiDelHuesped) y el texto va al chat, nunca a la voz.' },
  enviar_video_al_chat: { tipo: 'propia_del_canal',
    motivo: 'Durante la llamada el video se manda al WhatsApp; en el chat y la nota de voz lo envía el motor del PMS con el tema "video" de la interpretación (2026-11-04).' },
  registrar_ruta_contacto: { tipo: 'propia_del_canal',
    motivo: 'RUTAS POR INTENCIÓN (2026-11-08): en el chat y la nota de voz la señal es el campo contact_route de la interpretación y el PMS decide en el turno; en la llamada no hay motor por turno y el modelo la registra con esta herramienta, que usa el mismo servicio del PMS (rutas-intencion.service.js). Diferencia declarada: el chat arranca el cuestionario del propietario y la llamada no; deja el prospecto y la consulta, y el equipo sigue por WhatsApp. Otra zona con publicaciones en la vitrina (2026-11-11): el mismo servicio (ofertaVitrinaOtraZona) da el mismo texto con enlace en el chat y, desde la llamada, al chat de WhatsApp. No aplica a TenGo Camello: sus Camis no tienen propietarios ni aliados de Miu.' },
  pedir_persona: { tipo: 'propia_del_canal',
    motivo: 'Aviso inmediato a José Manuel durante la llamada; en el chat lo hace el motor del PMS con la interpretación (requests_human / queja / emergencia).' },
  consultar_al_equipo: { tipo: 'propia_del_canal',
    motivo: 'Cami pregunta primero a Teo (2026-10-24): en el chat y las notas de voz la consulta la crea el motor del PMS al detectar el vacío de conocimiento (knowledge_unresolved); en la llamada no hay motor por turno y el modelo la registra con esta herramienta (mismo destino: consultas_teo del PMS).' },
  anotar_lista_espera: { tipo: 'propia_del_canal',
    motivo: 'En el chat la lista de espera la anota el motor del PMS al interpretar el "sí" del huésped; la voz llama al mismo mecanismo (anotarListaEsperaFueraHorizonte) por esta herramienta.' },
  ofrecer_paquete_magia: { tipo: 'propia_del_canal',
    motivo: 'Demo del Paquete Magia de TengoCamello (2026-10-24, PMS migración 950): en el chat y la nota de voz la arranca el texto disparador ("Quiero probar el Paquete Magia", enlace wa.me) en el despachador de la red del PMS; en la llamada, esta herramienta llama al mismo servicio (invitarDemo) y la demo sigue por el chat, porque vive en WhatsApp (avisos con opciones, enlaces y portal).' },
  reportar_problema_estadia: { tipo: 'propia_del_canal',
    motivo: 'RESEÑAS (2026-11-22, PMS migración 1750): en el chat y la nota de voz el flujo de huésped en estadía del PMS lee la respuesta a "¿Todo bien con tu estadía?" y abre el caso de estadía (crearCaso; salida-resenas.service.js); en la llamada no hay motor por turno y el modelo lo registra con esta herramienta, que usa el MISMO caso de estadía y la misma cola de Teo.' },
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

// EXCEPCIÓN DECLARADA (José Manuel, 2026-10-30): Cami de voz de TenGo. Las
// llamadas al número de TenGo Camello (el 7355) NO son Cami de ventas de Miu:
// son otro negocio, con otro número, otro guion y su propio contrato con el PMS
// (vozInicio con numero='tengocamello'). La paridad de arriba (dominio 25) NO
// le aplica: no cotiza alojamiento, no tiene herramientas del PMS, ni consulta
// a Teo, ni Paquete Magia, ni late check-out. Lo único compartido con el chat de
// TenGo es el filtro de uso aceptable (política uso_aceptable_v1, que es
// transversal) y, dentro de la llamada, colgar y pedir una persona.
test('Cami de voz de TenGo: excepción declarada, sus herramientas y nada de Miu (2026-10-30)', () => {
  const { herramientasTenGoVoz, instruccionesCamiTenGoVoz, HERRAMIENTAS_COMERCIALES } = require('../lib/voz/cami-voz');
  const tengo = herramientasTenGoVoz().map((t) => t.name);
  // Citas (2026-11-03): la misma reserva del chat y de la página, en el PMS (citas.service.js).
  assert.deepEqual(tengo.sort(), ['agendar_cita', 'cancelar_cita', 'evaluar_uso_aceptable', 'pedir_persona', 'terminar_llamada', 'ver_horarios_cita']);
  assert.deepEqual(tengo.filter((n) => HERRAMIENTAS_COMERCIALES.has(n)), []);
  for (const n of ['consultar_al_equipo', 'ofrecer_paquete_magia', 'solicitar_late_checkout', 'solicitar_early_checkin']) {
    assert.equal(tengo.includes(n), false, n);
  }
  // El filtro de uso aceptable sí es transversal (chat, nota de voz, llamada de
  // Miu y llamada de TenGo): misma instrucción y misma herramienta.
  const t = instruccionesCamiTenGoVoz({ hoy: '2026-10-30' });
  assert.match(t, /USO ACEPTABLE/);
  assert.match(t, /no cotizas alojamiento de Miu La Frontera/i);
});

// EQUIPOS (2026-11-01, PMS migración 1089): sus herramientas son de otro mundo, con su
// propia paridad: en la llamada y en el chat registran por el mismo servicio del PMS
// (registros.service.js, procesarLectura; lo prueba tests/equipos.test.js del PMS).
// Excepción declarada: el chat no tiene estas herramientas porque su lectura es el modelo
// de extracción del PMS, no herramientas. Nada de Equipos entra a Cami de Miu ni al revés.
test('Equipos no comparte herramientas comerciales con Miu', () => {
  const { herramientasEquiposVoz } = require('../lib/voz/cami-voz');
  const eq = herramientasEquiposVoz().map((t) => t.name).sort();
  assert.deepEqual(eq, ['consultar_cifras', 'pedir_al_equipo', 'registrar_movimiento', 'terminar_llamada']);
  const miu = new Set(herramientasDeVoz().map((t) => t.name));
  for (const n of eq.filter((x) => x !== 'terminar_llamada')) assert.equal(miu.has(n), false, n);
  const chat = new Set(toolsForModel().map((t) => t.name));
  for (const n of eq) assert.equal(chat.has(n), false, n);
});

// MARCA (Quedó Bien, GO José Manuel 2026-11-11; PMS migraciones 1201-1207). Paridad
// entre Camis (dominio 25): la asistente de una marca tiene las funciones de Cami (tomar
// el pedido, cotizar solo lo aprobado, agendar, cobrar por enlace, garantía, pedir una
// persona, colgar) con la voz, la personalidad y el nombre de config.marca. En el chat
// lo hace el PMS (reparaciones/cliente.service.js) con los MISMOS servicios del núcleo
// que llama la voz (reparaciones/voz.service.js). Perfil 'marca'.
// EXCEPCIÓN DECLARADA: las fotos del daño no se toman por voz; la llamada las pide por
// el chat del mismo número (en el chat sí llegan como adjunto). Tampoco comparte nada
// con Miu ni con Equipos, y pedir_persona avisa al responsable de la marca, no a José.
// Uso aceptable propio: fase 2 (PLAN_QUEDO_BIEN_V1, sección 8); hasta entonces la marca
// no usa evaluar_uso_aceptable (que avisa a Teo de Miu).
const PARIDAD_MARCA = Object.freeze({
  perfil: 'marca',
  herramientas: ['agendar_visita', 'cancelar_visita', 'enviar_enlace_pago', 'pedir_persona', 'registrar_garantia_reclamo', 'terminar_llamada', 'tomar_dano', 'ver_cotizacion', 'ver_horarios_visita'],
  excepciones: { fotos_por_voz: 'propia_del_canal' },
});
test('marca: perfil declarado, sus herramientas, excepción de fotos y nada de Miu ni de Equipos (2026-11-11)', () => {
  const { herramientasMarcaVoz, herramientasEquiposVoz, instruccionesCamiMarcaVoz, marcaDesdeInicio, HERRAMIENTAS_COMERCIALES } = require('../lib/voz/cami-voz');
  const marca = herramientasMarcaVoz().map((t) => t.name).sort();
  assert.deepEqual(marca, PARIDAD_MARCA.herramientas);
  assert.deepEqual(marca.filter((n) => HERRAMIENTAS_COMERCIALES.has(n)), []);
  for (const n of ['consultar_al_equipo', 'evaluar_uso_aceptable', 'ofrecer_paquete_magia', 'solicitar_late_checkout', 'registrar_movimiento', 'consultar_cifras']) {
    assert.equal(marca.includes(n), false, n);
  }
  const miu = new Set(herramientasDeVoz().map((t) => t.name));
  const equipos = new Set(herramientasEquiposVoz().map((t) => t.name));
  for (const n of marca.filter((x) => !['terminar_llamada', 'pedir_persona'].includes(x))) {
    assert.equal(miu.has(n), false, n);
    assert.equal(equipos.has(n), false, n);
  }
  assert.ok(TIPOS.has(PARIDAD_MARCA.excepciones.fotos_por_voz));
  const t = instruccionesCamiMarcaVoz({ hoy: '2026-11-11', marca: marcaDesdeInicio({ marca_nombre: 'Quedó Bien' }) });
  assert.match(t, /FOTOS: por teléfono no se toman fotos/);
  assert.match(t, /no ofrece alojamiento/);
});

// AMPLIAR UNA RESERVA (José Manuel, 2026-11-21; DECISIONES_LOG "Ampliar una reserva: se cobra de una vez la
// extensión; mínimo el anticipo"). El chat y las notas de voz la dicen desde el motor del PMS (m0, misma frase
// que quote_stay.regla_extension); la llamada la recibe en quote_stay y esta regla le dice que la use.
test('ampliar una reserva: la voz usa regla_extension de quote_stay (paridad, 2026-11-21)', () => {
  const { instruccionesCamiVoz } = require('../lib/voz/cami-voz');
  const t = instruccionesCamiVoz({ hoy: '2026-11-21' });
  const texto = Array.isArray(t) ? t.join('\n') : String(t);
  assert.match(texto, /AMPLIAR SU RESERVA \(2026-11-21\)/);
  assert.match(texto, /regla_extension/);
  assert.match(texto, /se paga completa al confirmarla/);
  assert.match(texto, /valor_ampliacion_cop \(NO price\.total_price/);
});

// CONFIANZA PRIMERO (José Manuel, 2026-11-22; DECISIONES_LOG "Confianza primero"). Chat y nota de voz: el
// PMS (aplicarConfianzaAlTurno, tema airbnb_listing, KB-16 para_todos). Llamada: el mismo contexto del PMS
// (/voz/llamada/inicio -> confianza) en las instrucciones y las mismas herramientas (search_commercial_knowledge
// con address_disclosure y airbnb_listing). EXCEPCIÓN DECLARADA (propia_del_canal): por voz no se envía la foto
// de José (no hay imágenes en la llamada); se dice su presentación y, si la piden, las reseñas.
const PARIDAD_CONFIANZA = { excepciones: {
  foto_de_jose_por_voz: { tipo: 'propia_del_canal', motivo: 'En la llamada no hay imágenes; se dice la presentación y, si las piden, las reseñas.' },
  // Revisión 2026-11-22 (punto 10): la variante B por voz sale SOLO ante duda; en el chat también al presentar la
  // primera propuesta. En la llamada no hay "presentar la propuesta" como mensaje (el precio se dice con quote_stay
  // y la cotización escrita llega al chat después) y la voz no puede dar el enlace del anuncio: la oferta con
  // enlace queda en el chat, donde la persona la recibe con la propuesta. Mismas condiciones: menos de 30 noches,
  // sin pre-reserva viva, con anuncio, una vez, nunca primera noche.
  variante_b_solo_ante_duda_por_voz: { tipo: 'propia_del_canal', motivo: 'Ver comentario: sin propuesta escrita ni enlace en la llamada.' } } };
test('confianza primero: la llamada recibe presentación, dirección, anuncio y variante B (paridad, 2026-11-22)', () => {
  const { instruccionesCamiVoz } = require('../lib/voz/cami-voz');
  const conf = { presentacion: { anfitrion: 'José Manuel', anos_anfitrion: 8, resenas_mas_de: 2000, resenas: [] },
    direccion_para_todos: true, airbnb_anuncio: true, variante_b: true };
  const t = String(instruccionesCamiVoz({ hoy: '2026-11-22', confianza: conf }));
  assert.match(t, /CONFIANZA \(2026-11-22\)/);
  assert.match(t, /DIRECCIÓN \(2026-11-22\)/);
  assert.match(t, /CÓMO LOS BUSCO EN AIRBNB/);
  assert.match(t, /PRIMERA VEZ \(prueba de José Manuel, 2026-11-22\)/);
  // Huésped de Airbnb o persona al mando: sin contexto comercial de confianza.
  assert.doesNotMatch(String(instruccionesCamiVoz({ hoy: '2026-11-22', confianza: conf, huespedAirbnb: true })), /PRIMERA VEZ \(prueba/);
  for (const e of Object.values(PARIDAD_CONFIANZA.excepciones)) { assert.ok(TIPOS.has(e.tipo)); assert.ok(e.motivo.length > 20); }
  assert.match(t, /SOLO en estadías de menos de 30 noches, si la persona duda o desconfía/);
  // La herramienta que usa la voz para dirección y anuncio existe en los dos canales.
  const chat = new Set(toolsForModel().map((x) => x.name));
  const voz = new Set(herramientasDeVoz({}).map((x) => x.name));
  assert.ok(chat.has('search_commercial_knowledge') && voz.has('search_commercial_knowledge'));
});

// CAMI MULTIPROPIEDAD (A22, Studio A22 Coliving; diseño DISENO_CAMI_MULTIPROPIEDAD.md §5 fase 1 y §8 I2).
// EXCEPCIÓN TEMPORAL DECLARADA (I2): en la fase 1, A22 atiende por chat y nota de voz (mismo camino, con su
// marca: lib/pilot/marca-propiedad.js, P6), pero sus LLAMADAS están apagadas: call-manager las rechaza
// (P5, log [voz] llamada_a22_rechazada) hasta medir en logs que llega la cabecera SIP del número llamado.
// El guion de voz sigue siendo solo de Miu. Al encender las llamadas de A22 (fase 2) hay que parametrizar
// cami-voz.js con la misma marca y QUITAR esta excepción.
const PARIDAD_A22 = { excepciones: {
  llamadas_a22_apagadas_fase1: { tipo: 'pendiente de paridad',
    motivo: 'Fase 1 de A22: chat y nota de voz con marca de A22; la llamada al número de A22 se rechaza (I2) y el guion de voz es solo de Miu.' } } };
test('A22: llamadas apagadas en fase 1, excepción temporal de paridad declarada (I2, P6)', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  for (const e of Object.values(PARIDAD_A22.excepciones)) { assert.ok(TIPOS.has(e.tipo)); assert.ok(e.motivo.length > 20); }
  // La llamada de A22 sigue rechazada (si alguien la enciende, esta excepción debe revisarse).
  const callManager = fs.readFileSync(path.join(__dirname, '..', 'lib', 'voz', 'call-manager.js'), 'utf8');
  assert.match(callManager, /llamada_a22_rechazada/);
  // El chat y la nota de voz sí tienen la marca de A22 (sin Miu).
  const { writerSystemPrompt } = require('../lib/pilot/llm/writer');
  const { marcaDePropiedad } = require('../lib/pilot/marca-propiedad');
  assert.doesNotMatch(writerSystemPrompt(marcaDePropiedad('a22', { nombre_marca: 'Studio A22 Coliving' })), /Miu|Frontera|Medell/);
  // El guion de voz sigue siendo de Miu: mientras lo sea, la excepción aplica.
  const { instruccionesCamiVoz } = require('../lib/voz/cami-voz');
  assert.match(String(instruccionesCamiVoz({ hoy: '2026-11-23' })), /Miu La Frontera/);
});
