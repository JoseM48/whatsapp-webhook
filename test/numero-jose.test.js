'use strict';

// PORTERÍA DESDE EL NÚMERO DE JOSÉ (José Manuel, 2026-11-26). Números y tokens FALSOS.
// Lo que se prueba: sin token nada cambia (no se declara numero_jose); con token, la fila que el PMS entrega con el
// phone_number_id de José sale por ese número Y con su token; Miu y A22 siguen igual; de ese número solo entran los
// acuses de entrega (al camino de Miu) y quién escribió (ventana de portería), nunca sus chats.
const test = require('node:test');
const assert = require('node:assert/strict');
const { separarPorNumero } = require('../lib/pilot/numero-entrante');
const { crearSalidaPorNumero } = require('../lib/pilot/numero-propiedad');
const { createM0ClosedPilotDispatcher } = require('../lib/pilot/m0-closed-pilot');
const { PmsPilotClient } = require('../lib/pilot/pms-client');
const { configNumeroJose, numerosPropios, capacidades, reportarEntradas, ID_POR_DEFECTO, RUTA_ENTRADA } = require('../lib/pilot/numero-jose');

const MIU = '111111111111111', TENGO = '222222222222222', JOSE = '333333333333333', A22 = '444444444444444';
const PORTERIA = '573157770000';
const silencio = { info() {}, warn() {}, error() {} };
const config = { enabled: true, guestPhone: '573146892662', internalPhone: '573006774425', metaSignatureRequired: true,
  pmsM0Enabled: true, controlledIngressEnabled: true, pmsConfigured: true, receiptsEnabled: true,
  internalTemplateName: 'm0_internal_escalation_v1', internalTemplateLanguage: 'es_CO' };

test('config: sin token apagado (no declara numero_jose); con token activo; id por defecto el del 4425', () => {
  const sin = configNumeroJose({ PHONE_NUMBER_ID: MIU });
  assert.equal(sin.activo, false);
  assert.equal(sin.motivo, 'sin_token');
  assert.deepEqual(capacidades(sin), []);
  assert.equal(numerosPropios(sin).size, 0);
  const con = configNumeroJose({ PHONE_NUMBER_ID: MIU, WHATSAPP_TOKEN_JOSE_COEXISTENCE: 'tok-jose' });
  assert.equal(con.activo, true);
  assert.equal(con.phoneNumberId, ID_POR_DEFECTO);
  assert.deepEqual(capacidades(con), ['numero_jose']);
  const igualMiu = configNumeroJose({ PHONE_NUMBER_ID: MIU, WHATSAPP_TOKEN_JOSE_COEXISTENCE: 't', JOSE_COEXISTENCE_PHONE_NUMBER_ID: MIU });
  assert.equal(igualMiu.activo, false);
  assert.equal(igualMiu.motivo, 'id_igual_a_otro_numero');
});

test('el claim declara numero_jose en X-M0-Accepts solo con el token', async () => {
  const pedir = async (extra) => {
    const calls = [];
    const client = new PmsPilotClient({ baseUrl: 'https://pms.test', secret: 's', capacidadesExtra: extra,
      http: { async post(url, body, options) { calls.push(options); return { data: { data: { claimable: false } } }; } } });
    await client.claimClosedPilotOutbound(5);
    return calls[0].headers['X-M0-Accepts'].split(',').map((s) => s.trim());
  };
  const sin = await pedir([]);
  assert.ok(sin.includes('equipo_image'));
  assert.ok(!sin.includes('numero_jose'));
  assert.ok((await pedir(['numero_jose'])).includes('numero_jose'));
});

function montar(salida, claims) {
  const enviados = [], completados = [];
  const cola = [...claims];
  const pms = { async claimClosedPilotOutbound() { return cola.shift() || { claimable: false }; },
    async completeClosedPilotOutbound(body) { completados.push(body); } };
  const d = createM0ClosedPilotDispatcher({ config, pms, logger: silencio, numeroSalida: salida,
    async sendText(phone, text) { enviados.push({ phone, text, url: salida.url(), token: salida.token() }); return `wamid.t${enviados.length}`; },
    async sendTemplate(phone, t) { enviados.push({ phone, t, url: salida.url(), token: salida.token() }); return `wamid.p${enviados.length}`; } });
  return { d, enviados, completados };
}
const fila = (extra = {}) => ({ outbox_id: 5, claimable: true, recipient_kind: 'guest', message_kind: 'text', recipient_phone: PORTERIA,
  message_text: 'Autorización de ingreso 904', equipo: true, ...extra });

test('salida: la fila con el id de José sale por su número y su token; la de Miu, igual que antes', async () => {
  const salida = crearSalidaPorNumero({ miuId: MIU, numerosPropios: new Map([[JOSE, 'tok-jose']]) });
  const { d, enviados } = montar(salida, [fila({ outbox_id: 1, phone_number_id: JOSE, numero_salida: 'jose' }), fila({ outbox_id: 2 })]);
  const r = await d.pollPendingInternalOutbox();
  assert.deepEqual(r.map((x) => x.status), ['submitted', 'submitted']);
  assert.equal(enviados[0].url, `https://graph.facebook.com/v20.0/${JOSE}/messages`);
  assert.equal(enviados[0].token, 'tok-jose');
  assert.equal(enviados[1].url, `https://graph.facebook.com/v20.0/${MIU}/messages`);
  assert.equal(enviados[1].token, null);
  assert.equal(salida.token(), null);
});

test('salida: sin el token configurado, una fila con el id de José NO sale por Miu (se cierra como fallida)', async () => {
  const salida = crearSalidaPorNumero({ miuId: MIU, numerosPropios: new Map() });
  const { d, enviados, completados } = montar(salida, [fila({ outbox_id: 9, phone_number_id: JOSE })]);
  const r = await d.pollPendingInternalOutbox();
  assert.equal(enviados.length, 0);
  assert.equal(r[0].error_code, 'm0_closed_property_number_missing');
  assert.deepEqual(completados, [{ outbox_id: 9, status: 'failed' }]);
});

test('plantilla jm_porteria_* desde José: misma ruta, su token', async () => {
  const salida = crearSalidaPorNumero({ miuId: MIU, numerosPropios: new Map([[JOSE, 'tok-jose']]) });
  const { d, enviados } = montar(salida, [fila({ outbox_id: 3, phone_number_id: JOSE, message_kind: 'template',
    template_name: 'jm_porteria_autorizacion_v1', template_parameters: ['904', 'Ana', '29 de noviembre', '2'], template_language: 'es_CO' })]);
  await d.pollPendingInternalOutbox();
  assert.equal(enviados.length, 1);
  assert.equal(enviados[0].token, 'tok-jose');
  assert.equal(enviados[0].url, `https://graph.facebook.com/v20.0/${JOSE}/messages`);
});

test('entrada: del número de José solo pasan los acuses (al camino de Miu) y quién escribió; nunca sus mensajes', () => {
  const body = { object: 'whatsapp_business_account', entry: [{ id: 'w', changes: [
    { field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: MIU }, messages: [{ from: '573000000001', id: 'm1', timestamp: '1', type: 'text', text: { body: 'hola' } }] } },
    { field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: JOSE },
      contacts: [{ wa_id: PORTERIA }], messages: [{ from: PORTERIA, id: 'm2', timestamp: '1795722620', type: 'text', text: { body: 'Recibido' } }],
      statuses: [{ id: 'wamid.X', status: 'delivered', timestamp: '1795722620', recipient_id: PORTERIA }] } },
    { field: 'smb_message_echoes', value: { metadata: { phone_number_id: JOSE }, message_echoes: [{ to: PORTERIA, text: { body: 'chat personal' } }] } }] }] };
  const r = separarPorNumero(body, { miuId: MIU, tengoId: TENGO, joseId: JOSE });
  const cambios = r.miuBody.entry[0].changes;
  assert.equal(cambios.length, 2);
  assert.equal(cambios[0].value.metadata.phone_number_id, MIU);
  assert.deepEqual(cambios[1].value.statuses, [{ id: 'wamid.X', status: 'delivered', timestamp: '1795722620', recipient_id: PORTERIA }]);
  assert.equal(cambios[1].value.messages, undefined);
  assert.ok(!JSON.stringify(r.miuBody).includes('Recibido'));
  assert.ok(!JSON.stringify(r.miuBody).includes('chat personal'));
  assert.deepEqual(r.joseEntradas, [{ from: PORTERIA, occurred_at: new Date(1795722620 * 1000).toISOString() }]);
  assert.equal(r.joseEstados, 1);
  assert.equal(r.joseDescartados, 1);
  assert.equal(r.desconocidos, 0);
});

test('entrada: sin joseId (token apagado) el número de José sigue siendo desconocido, como hoy', () => {
  const body = { entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: JOSE }, statuses: [{ id: 'w', status: 'delivered' }] } }] }] };
  const r = separarPorNumero(body, { miuId: MIU, tengoId: TENGO });
  assert.equal(r.miuBody, null);
  assert.equal(r.desconocidos, 1);
  assert.deepEqual(r.joseEntradas, []);
});

test('entrada: Miu sola sigue siendo el mismo cuerpo (misma referencia)', () => {
  const body = { entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: MIU }, messages: [] } }] }] };
  assert.equal(separarPorNumero(body, { miuId: MIU, joseId: JOSE }).miuBody, body);
});

test('reportarEntradas: una llamada por remitente, sin texto; un fallo no lanza', async () => {
  const llamadas = [];
  const pms = { async postUrl(url, body) { llamadas.push({ url, body }); if (body.from === '573999999999') throw Object.assign(new Error('x'), { code: 'e' }); return {}; } };
  const n = await reportarEntradas([{ from: PORTERIA, occurred_at: '2026-11-26T10:00:00.000Z' }, { from: PORTERIA }, { from: '573999999999' }],
    { pms, pmsBaseUrl: 'https://pms.test/', phoneNumberId: JOSE, logger: silencio });
  assert.equal(n, 1);
  assert.equal(llamadas.length, 2);
  assert.equal(llamadas[0].url, `https://pms.test${RUTA_ENTRADA}`);
  assert.deepEqual(llamadas[0].body, { phone_number_id: JOSE, from: PORTERIA, occurred_at: '2026-11-26T10:00:00.000Z' });
});
