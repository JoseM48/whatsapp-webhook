'use strict';

// Compuerta de la ruta conversacional nueva -- BLOQUE C, seccion H.
//
// POR QUE ESTE ARCHIVO EXISTE Y NO SE REUSA NADA.
//
// La tentacion era reusar M0_NATURAL_PRESENTATION_RESTRICT_TO_TEST_PHONES, que
// ya existe y ya tiene una lista de telefonos. Seria un error grave: esa
// variable esta en `false` en produccion, y la presentacion natural esta
// GLOBAL. Un interruptor que hoy no restringe a nadie no puede servir de
// control de seguridad de una ruta nueva. Usarlo habria expuesto la ruta a
// todos los huespedes creyendo lo contrario.
//
// Este gate es propio, independiente, y no comparte variable con ninguna otra
// funcionalidad.
//
// FAIL CLOSED. Toda duda cae a legacy:
//   - bandera ausente o distinta de 'true'  -> legacy
//   - lista de telefonos vacia              -> legacy
//   - telefono ausente, vacio o no normalizable -> legacy
//   - telefono que no esta en la lista      -> legacy
// No hay ningun camino en el que un valor raro habilite la ruta nueva.

// Se comparan solo digitos: Meta entrega el numero sin '+', y una comparacion
// textual fallaría contra '+573146892662'. Normalizar de un solo lado no
// sirve: se normalizan AMBOS.
function onlyDigits(value) {
  return String(value == null ? '' : value).replace(/\D/g, '');
}

function parseAllowlist(raw) {
  return String(raw || '')
    .split(',')
    .map((entry) => onlyDigits(entry))
    .filter((entry) => entry.length >= 8);
}

function readGateConfig(env = process.env) {
  return {
    enabled: String(env.NEW_LLM_CONVERSATIONAL_ROUTE_ENABLED || '').trim() === 'true',
    phones: parseAllowlist(env.NEW_LLM_CONVERSATIONAL_ROUTE_PHONES)
  };
}

// Devuelve { allowed, reason }. El `reason` no es decorativo: es lo que permite
// distinguir en el log "apagada" de "telefono fuera de lista", que son dos
// estados operativos muy distintos cuando algo no responde como se esperaba.
function evaluateConversationalRoute(phone, env = process.env) {
  const config = readGateConfig(env);
  if (!config.enabled) return { allowed: false, reason: 'route_disabled' };
  if (!config.phones.length) return { allowed: false, reason: 'allowlist_empty' };

  const normalized = onlyDigits(phone);
  if (!normalized) return { allowed: false, reason: 'phone_missing' };
  if (!config.phones.includes(normalized)) return { allowed: false, reason: 'phone_not_allowed' };

  return { allowed: true, reason: 'phone_allowed' };
}

function isConversationalRouteEnabledFor(phone, env = process.env) {
  return evaluateConversationalRoute(phone, env).allowed;
}

module.exports = { evaluateConversationalRoute, isConversationalRouteEnabledFor,
  readGateConfig, parseAllowlist, onlyDigits };
