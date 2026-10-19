'use strict';

const crypto = require('crypto');

// Verificacion de la firma de los webhooks de OpenAI (esquema "Standard
// Webhooks", el mismo que valida `client.webhooks.unwrap` del SDK):
//
//   cabeceras: webhook-id, webhook-timestamp (segundos), webhook-signature
//              ("v1,<base64>", puede traer varias separadas por espacio)
//   contenido firmado: `${id}.${timestamp}.${cuerpo crudo}`
//   clave: el secreto del webhook ("whsec_<base64>"), decodificado de base64
//
// Se implementa aqui porque la version del SDK instalada (openai 4.x) no trae
// `webhooks.unwrap`. Tolerancia de 5 minutos contra repeticiones.

const TOLERANCIA_SEGUNDOS = 300;

function claveDelSecreto(secret) {
  const s = String(secret || '').trim();
  if (!s) return null;
  const base = s.startsWith('whsec_') ? s.slice('whsec_'.length) : s;
  const clave = Buffer.from(base, 'base64');
  return clave.length ? clave : null;
}

function cabecera(headers, nombre) {
  if (!headers) return null;
  if (typeof headers.get === 'function') return headers.get(nombre) ?? null;
  const v = headers[nombre] ?? headers[nombre.toLowerCase()];
  return Array.isArray(v) ? v[0] : (v ?? null);
}

function verifyOpenAiWebhook({ rawBody, headers, secret, nowMs = Date.now(), toleranceSeconds = TOLERANCIA_SEGUNDOS }) {
  const clave = claveDelSecreto(secret);
  if (!clave) return { ok: false, status: 503, error: 'webhook_secret_not_configured' };
  const id = cabecera(headers, 'webhook-id');
  const timestamp = cabecera(headers, 'webhook-timestamp');
  const firma = cabecera(headers, 'webhook-signature');
  if (!id || !timestamp || !firma) return { ok: false, status: 400, error: 'missing_signature_headers' };
  const segundos = Number(timestamp);
  if (!Number.isInteger(segundos)) return { ok: false, status: 400, error: 'invalid_timestamp' };
  if (Math.abs(nowMs / 1000 - segundos) > toleranceSeconds) return { ok: false, status: 400, error: 'stale_timestamp' };
  const cuerpo = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody ?? ''), 'utf8');
  const esperada = crypto.createHmac('sha256', clave)
    .update(Buffer.concat([Buffer.from(`${id}.${timestamp}.`, 'utf8'), cuerpo]))
    .digest();
  const coincide = String(firma).split(' ').some((parte) => {
    const [version, valor] = parte.split(',');
    if (version !== 'v1' || !valor) return false;
    const recibida = Buffer.from(valor, 'base64');
    return recibida.length === esperada.length && crypto.timingSafeEqual(recibida, esperada);
  });
  return coincide ? { ok: true, webhookId: String(id) } : { ok: false, status: 400, error: 'invalid_signature' };
}

// Solo para pruebas: firma un cuerpo como lo haria OpenAI.
function signOpenAiWebhook({ id, timestamp, rawBody, secret }) {
  const clave = claveDelSecreto(secret);
  const sig = crypto.createHmac('sha256', clave).update(`${id}.${timestamp}.${rawBody}`).digest('base64');
  return `v1,${sig}`;
}

module.exports = { verifyOpenAiWebhook, signOpenAiWebhook };
