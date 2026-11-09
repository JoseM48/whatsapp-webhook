'use strict';

// RUTAS POR INTENCIÓN (José Manuel, 2026-11-08; APROBACION.md puntos 5 a 7; paridad de
// canales, dominio 25). El modelo clasifica y el PMS decide: aquí se prueba el contrato
// y la instrucción. Las frases reales, con sus trampas, se prueban en el PMS
// (tests/cami-rutas-intencion.test.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const original = Module._resolveFilename;
Module._resolveFilename = function r(req, ...rest) { return req === '@anthropic-ai/sdk' ? req : original.call(this, req, ...rest); };
require.cache['@anthropic-ai/sdk'] = require.cache['@anthropic-ai/sdk'] || { id: '@anthropic-ai/sdk', filename: '@anthropic-ai/sdk', loaded: true, exports: class {} };
const { interpretationSchema, reconcileInterpretation } = require('../lib/pilot/ai');
const { interpretationSchemaV2, projectToLegacyInterpretation } = require('../lib/pilot/llm/interpretation-schema-v2');
const { publicInterpretation } = require('../lib/pilot/m0-commercial-responder');
Module._resolveFilename = original;
const { INSTRUCCION_CHAT, INSTRUCCION_VOZ, normalizarRutaContacto } = require('../lib/pilot/rutas-intencion');
const { INSTRUCCION_CHAT: USO_CHAT, INSTRUCCION_VOZ: USO_VOZ } = require('../lib/pilot/uso-aceptable');
const { herramientasDeVoz, instruccionesCamiVoz, HERRAMIENTAS_COMERCIALES, aliadoDesdeInicio } = require('../lib/voz/cami-voz');

const ruta = (route, o = {}) => ({ route, barrio: null, confidence: 0.9, summary: 'x', ...o });

test('el campo es obligatorio en los dos esquemas del chat', () => {
  for (const s of [interpretationSchema, interpretationSchemaV2]) {
    assert.ok(s.required.includes('contact_route'));
    assert.deepEqual(s.properties.contact_route.properties.route.enum, ['guest', 'owner_listing', 'property_sale', 'ally_interest']);
  }
});

test('huésped o inválido no viaja: un PMS anterior rechaza la clave', () => {
  assert.equal(normalizarRutaContacto(ruta('guest')), null);
  assert.equal(normalizarRutaContacto(null), null);
  assert.equal(normalizarRutaContacto({ route: 'otra' }), null);
  assert.deepEqual(normalizarRutaContacto(ruta('owner_listing', { barrio: '  Laureles ', confidence: 2 })),
    { route: 'owner_listing', barrio: 'Laureles', confidence: null, summary: 'x' });
  const g = reconcileInterpretation('Busco apartamento del 1 al 30 de noviembre', { contact_route: ruta('guest') });
  assert.equal(g.contact_route, null);
  assert.equal('contact_route' in publicInterpretation(g), false);
});

test('legacy y V2 llevan la ruta al PMS', () => {
  const r = reconcileInterpretation('tengo un apto en Laureles, ¿me lo administran?', { contact_route: ruta('owner_listing', { barrio: 'Laureles' }) });
  assert.equal(publicInterpretation(r).contact_route.route, 'owner_listing');
  const base = { intent: 'other', language: 'es', stay: { arrival: {}, duration: {}, guests: {} }, references: [], budget: {}, knowledge_topics: [], preferences: [], requirements: [], corrections: [], ambiguity: [] };
  assert.equal('contact_route' in projectToLegacyInterpretation({ ...base, contact_route: ruta('guest') }), false);
  assert.equal(projectToLegacyInterpretation({ ...base, contact_route: ruta('property_sale') }).contact_route.route, 'property_sale');
});

test('la instrucción trae las trampas de huésped y a las fincas', () => {
  for (const f of ['tengo un apartamento reservado', 'busco apartamento', 'quiero alquilar uno', 'Fincas count', 'casa-finca']) assert.ok(INSTRUCCION_CHAT.includes(f), f);
  assert.match(INSTRUCCION_CHAT, /whenever in doubt/);
  assert.match(INSTRUCCION_VOZ, /tengo un apartamento reservado/);
  assert.match(INSTRUCCION_VOZ, /no hables del POT/);
  assert.doesNotMatch(INSTRUCCION_VOZ, /mínimo 30/);
});

test('lead 334: el uso aceptable aclara que un propietario no es un anuncio de terceros', () => {
  assert.match(USO_CHAT, /NOT an owner asking Miu to rent, manage or take reservations for THEIR OWN/);
  assert.match(USO_VOZ, /no aplica a un propietario/);
});

test('paridad en la llamada: solo en la venta, comercial y en la instrucción de venta', () => {
  assert.ok(herramientasDeVoz().some((h) => h.name === 'registrar_ruta_contacto'));
  assert.ok(HERRAMIENTAS_COMERCIALES.has('registrar_ruta_contacto'));
  assert.equal(herramientasDeVoz({ sinComerciales: true }).some((h) => h.name === 'registrar_ruta_contacto'), false);
  assert.equal(herramientasDeVoz({ aliado: true }).some((h) => h.name === 'registrar_ruta_contacto'), false);
  assert.match(instruccionesCamiVoz({ hoy: '2026-11-08' }), /registrar_ruta_contacto/);
  const aliado = aliadoDesdeInicio({ perfil: 'aliado', no_cotizar: true, guia: { clave: 'g', secciones: [{ clave: 'negocio_hoy', titulo: 'Negocio', preguntas: ['¿Qué hace?'] }] } });
  assert.doesNotMatch(instruccionesCamiVoz({ hoy: '2026-11-08', aliado, duracionMaxMin: 40 }), /registrar_ruta_contacto/);
});
