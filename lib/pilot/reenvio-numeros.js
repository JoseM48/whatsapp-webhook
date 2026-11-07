'use strict';

// REENVÍO DE NÚMEROS A OTRO SERVICIO (2026-11-07; prototipo "fincas demo" de TenGo Camello).
//
// El webhook de la app de Meta apunta a este servicio. Un número nuevo del mismo
// WABA que atiende OTRO servicio (un Worker de Cloudflare) no se procesa aquí: cada
// cambio cuyo value.metadata.phone_number_id esté en la lista se REENVÍA tal cual,
// con la misma forma de Meta, y desaparece de lo que ven Miu, TenGo y Equipos.
//
// Configuración (variables de entorno):
//   REENVIO_NUMEROS_JSON = {"<phone_number_id>":{"url":"https://.../wa/inbound","nombre":"fincas-demo"}}
//   REENVIO_SECRETO      = clave HMAC (mínimo 16 caracteres).
// Falta algo o es inválido -> apagado y todo sigue como antes (fail-closed).
// Un id igual al de Miu, TenGo o el demo invalida TODA la configuración: nunca se
// desvía un mensaje de esos números.
//
// Envío: POST con el JSON crudo, cabecera X-Forward-Signature: sha256=<hex HMAC-SHA256(cuerpo)>,
// tiempo máximo ~5 s, 1 reintento (no en 4xx). Nunca se espera: el 200 a Meta no depende de esto.
// Logs: solo nombre, phone_number_id, campo, intento y estado HTTP. Nunca texto ni teléfonos.

const crypto = require('crypto');

const ETIQUETA = '[reenvio]';
const TIMEOUT_MS = 5000;
const REINTENTOS = 1;
const SECRETO_MIN = 16;
const RE_ID = /^\d{5,30}$/;

const APAGADO = (motivo) => Object.freeze({ activo: false, motivo, destinos: new Map(), secreto: '' });

function nombreSeguro(v) {
  const n = String(v ?? '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 40);
  return n || 'reenvio';
}

function urlValida(v) {
  try {
    const u = new URL(String(v || ''));
    return u.protocol === 'https:' && !u.username && !u.password ? u.toString() : null;
  } catch { return null; }
}

/**
 * Lee la configuración. `protegidos`: ids que nunca se reenvían (Miu, TenGo, demo).
 * Devuelve { activo, motivo, destinos: Map<id, {url, nombre}>, secreto }.
 */
function leerConfigReenvio(env = process.env, { protegidos = [] } = {}) {
  const crudo = String(env.REENVIO_NUMEROS_JSON || '').trim();
  if (!crudo) return APAGADO('sin_variable');
  const secreto = String(env.REENVIO_SECRETO || '');
  if (secreto.trim().length < SECRETO_MIN) return APAGADO('sin_secreto');
  let datos;
  try { datos = JSON.parse(crudo); } catch { return APAGADO('json_invalido'); }
  if (!datos || typeof datos !== 'object' || Array.isArray(datos)) return APAGADO('json_no_es_objeto');
  const prot = new Set(protegidos.map((p) => String(p ?? '').trim()).filter(Boolean));
  const destinos = new Map();
  for (const [id, d] of Object.entries(datos)) {
    const clave = String(id).trim();
    if (!RE_ID.test(clave)) return APAGADO('id_invalido');
    if (prot.has(clave)) return APAGADO('id_protegido');
    if (!d || typeof d !== 'object') return APAGADO('destino_invalido');
    const url = urlValida(d.url);
    if (!url) return APAGADO('url_invalida');
    destinos.set(clave, Object.freeze({ url, nombre: nombreSeguro(d.nombre) }));
  }
  if (!destinos.size) return APAGADO('lista_vacia');
  return Object.freeze({ activo: true, motivo: null, destinos, secreto });
}

// Lo que se puede imprimir en el arranque: nunca la URL completa ni el secreto.
function configReenvioParaLog(cfg) {
  return { activo: cfg.activo, motivo: cfg.motivo, numeros: [...cfg.destinos.entries()].map(([id, d]) => ({ phone_number_id: id, nombre: d.nombre })) };
}

function idDe(change) {
  const v = change?.value?.metadata?.phone_number_id;
  return v == null || v === '' ? null : String(v);
}

/**
 * Separa los cambios a reenviar. Si no hay ninguno, `body` es el MISMO objeto.
 * Si todo se reenvía, `body` es null.
 */
function separarReenvios(body, destinos) {
  const reenvios = [];
  if (!destinos?.size || !Array.isArray(body?.entry)) return { body, reenvios };
  const entries = [];
  for (const entry of body.entry) {
    const changes = [];
    const originales = Array.isArray(entry?.changes) ? entry.changes : [];
    for (const change of originales) {
      const id = idDe(change);
      const destino = id != null ? destinos.get(id) : null;
      if (!destino) { changes.push(change); continue; }
      reenvios.push({ phoneNumberId: id, nombre: destino.nombre, url: destino.url, campo: String(change?.field || '').slice(0, 40),
        payload: { object: body.object, entry: [{ id: entry?.id, changes: [change] }] } });
    }
    if (changes.length) entries.push(changes.length === originales.length ? entry : { ...entry, changes });
  }
  if (!reenvios.length) return { body, reenvios };
  return { body: entries.length ? { ...body, entry: entries } : null, reenvios };
}

function firmar(raw, secreto) {
  return `sha256=${crypto.createHmac('sha256', secreto).update(raw).digest('hex')}`;
}

function conTope(promesa, ms) {
  let timer;
  const tope = new Promise((_, rechazar) => { timer = setTimeout(() => rechazar(Object.assign(new Error('reenvio_timeout'), { code: 'ETIMEDOUT' })), ms); });
  return Promise.race([promesa, tope]).finally(() => clearTimeout(timer));
}

/**
 * Envía cada reenvío. `post(url, raw, {headers, timeout})` devuelve la respuesta
 * ({status}) o lanza. Nunca lanza: devuelve un resumen por reenvío.
 */
async function enviarReenvios(reenvios, { secreto, post, logger = console, timeoutMs = TIMEOUT_MS, reintentos = REINTENTOS }) {
  return Promise.all(reenvios.map(async (r) => {
    const raw = JSON.stringify(r.payload);
    const headers = { 'Content-Type': 'application/json', 'X-Forward-Signature': firmar(raw, secreto) };
    const base = { nombre: r.nombre, phone_number_id: r.phoneNumberId, campo: r.campo };
    for (let intento = 1; intento <= reintentos + 1; intento += 1) {
      try {
        const resp = await conTope(Promise.resolve().then(() => post(r.url, raw, { headers, timeout: timeoutMs })), timeoutMs);
        logger.info(`${ETIQUETA} enviado`, { ...base, intento, http_status: resp?.status ?? null });
        return { ...base, ok: true, intento };
      } catch (error) {
        const status = Number(error?.response?.status) || null;
        const definitivo = status != null && status >= 400 && status < 500;
        const ultimo = definitivo || intento > reintentos;
        logger[ultimo ? 'error' : 'warn'](`${ETIQUETA} ${ultimo ? 'fallo' : 'reintento'}`, { ...base, intento, http_status: status,
          code: String(error?.code || 'unknown').slice(0, 40) });
        if (ultimo) return { ...base, ok: false, intento, http_status: status };
      }
    }
    return { ...base, ok: false };
  }));
}

/**
 * Punto de entrada desde index.js. Síncrono: separa y dispara el envío SIN esperarlo.
 * Devuelve { body (lo que sigue al resto del webhook; null si no queda nada), reenviados, promesa }.
 */
function despacharReenvios(body, cfg, { post, logger = console, timeoutMs, reintentos } = {}) {
  if (!cfg?.activo) return { body, reenviados: 0, promesa: Promise.resolve([]) };
  const sep = separarReenvios(body, cfg.destinos);
  if (!sep.reenvios.length) return { body, reenviados: 0, promesa: Promise.resolve([]) };
  const promesa = enviarReenvios(sep.reenvios, { secreto: cfg.secreto, post, logger, timeoutMs, reintentos })
    .catch((error) => { logger.error(`${ETIQUETA} fallo_inesperado`, { code: String(error?.code || 'unknown').slice(0, 40) }); return []; });
  return { body: sep.body, reenviados: sep.reenvios.length, promesa };
}

// POST real con axios: el cuerpo viaja tal cual se firmó (sin re-serializar) y sin redirecciones.
function crearPostAxios(axios) {
  return (url, raw, { headers, timeout }) => axios.post(url, raw, { headers, timeout, maxRedirects: 0,
    transformRequest: [(d) => d], validateStatus: (s) => s >= 200 && s < 300 });
}

module.exports = { leerConfigReenvio, configReenvioParaLog, separarReenvios, firmar, enviarReenvios, despacharReenvios, crearPostAxios,
  TIMEOUT_MS, REINTENTOS, SECRETO_MIN };
