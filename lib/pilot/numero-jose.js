'use strict';

// PORTERÍA DESDE EL NÚMERO DE JOSÉ (José Manuel, 2026-11-26).
//
// Recepción La Frontera dejó de recibir los mensajes del número de Miu (outbox 9540 y 9586: "sent", nunca
// "delivered"). José conectó su WhatsApp Business (4425, "José Manuel | Mio La Frontera") por Coexistence:
// WABA 2630453717223341, portafolio VERSADAA, app TengoCamello. El PMS decide qué fila sale por ese número
// (checkin_en_linea_v1.porteria.canal_salida, migración 1995) y la entrega con `phone_number_id` de José.
//
// Variables de entorno (las crea José en Render, servicio whatsapp-webhook):
//   WHATSAPP_TOKEN_JOSE_COEXISTENCE   token permanente del usuario del sistema "TengoCamello Coexistence".
//                                     Sin ella: el webhook NO declara `numero_jose` y el PMS sigue mandando por Miu.
//   JOSE_COEXISTENCE_PHONE_NUMBER_ID  opcional; por defecto el id del 4425 (no es secreto).
// Nunca se imprime el token.

const TOKEN_ENV = 'WHATSAPP_TOKEN_JOSE_COEXISTENCE';
const ID_ENV = 'JOSE_COEXISTENCE_PHONE_NUMBER_ID';
const ID_POR_DEFECTO = '3117139491678774';
const CAPACIDAD = 'numero_jose';
const RUTA_ENTRADA = '/api/supervised-pilot/closed-pilot/numero-jose/entrada';

function configNumeroJose(env = process.env, { miuId = env.PHONE_NUMBER_ID, tengoId = env.TENGOCAMELLO_PHONE_NUMBER_ID } = {}) {
  const token = String(env[TOKEN_ENV] || '').trim();
  const id = String(env[ID_ENV] || ID_POR_DEFECTO).trim();
  const idValido = /^\d{6,30}$/.test(id);
  const choca = id === String(miuId || '').trim() || id === String(tengoId || '').trim();
  const motivo = !token ? 'sin_token' : !idValido ? 'id_invalido' : choca ? 'id_igual_a_otro_numero' : null;
  return { activo: !motivo, motivo, phoneNumberId: idValido && !choca ? id : null, token: motivo ? null : token };
}

// Map phone_number_id -> token para crearSalidaPorNumero (vacío sin token).
function numerosPropios(cfg) {
  return cfg?.activo ? new Map([[cfg.phoneNumberId, cfg.token]]) : new Map();
}

// Capacidades extra de X-M0-Accepts: `numero_jose` solo si el token existe.
function capacidades(cfg) {
  return cfg?.activo ? [CAPACIDAD] : [];
}

// Reporta al PMS quién le escribió al número de José (abre la ventana de 24 h de portería con ese número). Sin
// texto. El PMS solo registra si el remitente es de portería; un fallo solo deja el log (nunca frena a Miu).
async function reportarEntradas(entradas, { pms, pmsBaseUrl, phoneNumberId, logger = console } = {}) {
  const vistos = new Set();
  let ok = 0;
  for (const e of Array.isArray(entradas) ? entradas : []) {
    if (!e?.from || vistos.has(e.from)) continue;
    vistos.add(e.from);
    try {
      await pms.postUrl(`${String(pmsBaseUrl).replace(/\/$/, '')}${RUTA_ENTRADA}`, { phone_number_id: phoneNumberId, from: e.from,
        ...(e.occurred_at ? { occurred_at: e.occurred_at } : {}) });
      ok += 1;
    } catch (error) {
      logger.warn('[numero-jose] entrada_no_reportada', { code: error?.code || error?.status || 'error' });
    }
  }
  return ok;
}

module.exports = { configNumeroJose, numerosPropios, capacidades, reportarEntradas, TOKEN_ENV, ID_ENV, CAPACIDAD, RUTA_ENTRADA, ID_POR_DEFECTO };
