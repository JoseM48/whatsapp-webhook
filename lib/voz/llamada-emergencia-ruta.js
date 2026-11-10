'use strict';

// POST /internal/voz/llamada-emergencia {clave, resumen}
// La llama el PMS. Firma HMAC igual que webhook -> PMS, en sentido inverso:
// X-PMS-Timestamp (ISO) + X-PMS-Signature = hex(HMAC-SHA256(PMS_LITE_WEBHOOK_SECRET,
// `llamada-emergencia.v1.${timestamp}.${cuerpo_crudo}`)), con 5 min de tolerancia.
// El prefijo impide reusar aquí una firma de webhook -> PMS (mismo secreto).
// Una firma ya vista no se acepta dos veces dentro de la ventana.
// Sin secreto configurado responde 503; con la llamada apagada, 404.

const crypto = require('crypto');

const MAX_DESFASE_MS = 5 * 60 * 1000;
const PROPOSITO = 'llamada-emergencia.v1.';

function firmar(secret, timestamp, rawBody) {
  return crypto.createHmac('sha256', secret).update(`${PROPOSITO}${timestamp}.${rawBody}`).digest('hex');
}

function iguales(a, b) {
  const x = Buffer.from(String(a || ''), 'hex');
  const y = Buffer.from(String(b || ''), 'hex');
  return x.length > 0 && x.length === y.length && crypto.timingSafeEqual(x, y);
}

function verificarFirmaPms({ secret, headers = {}, rawBody, nowMs = Date.now() }) {
  if (!secret) return { ok: false, status: 503, error: 'hmac_secret_not_configured' };
  const ts = headers['x-pms-timestamp'];
  const firma = headers['x-pms-signature'];
  if (!ts || !firma) return { ok: false, status: 401, error: 'missing_signature_headers' };
  const tsMs = Date.parse(ts);
  if (!Number.isFinite(tsMs)) return { ok: false, status: 401, error: 'invalid_timestamp' };
  if (Math.abs(nowMs - tsMs) > MAX_DESFASE_MS) return { ok: false, status: 401, error: 'stale_timestamp' };
  const cuerpo = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody || '');
  if (!iguales(firma, firmar(secret, ts, cuerpo))) return { ok: false, status: 401, error: 'invalid_signature' };
  return { ok: true };
}

const CODIGO_POR_MOTIVO = {
  apagada: 404,
  clave_invalida: 400,
  sin_config: 503,
  max_intentos_clave: 429,
  muy_pronto: 429,
  tope_diario: 429,
  error_red: 502,
  rechazada_openai: 502,
  respuesta_sin_sesion: 502,
  riesgo_revocacion: 429,
};

function crearManejadorLlamadaEmergencia({ llamada, secret = () => process.env.PMS_LITE_WEBHOOK_SECRET, now = () => Date.now() }) {
  const vistas = new Map(); // firma -> ms en que se vio
  return async function manejar({ headers = {}, rawBody, body }) {
    if (!llamada.estado().habilitada) return { status: 404, body: { error: 'not_found' } };
    const t = now();
    const v = verificarFirmaPms({ secret: String(secret() || '').trim(), headers, rawBody, nowMs: t });
    if (!v.ok) return { status: v.status, body: { ok: false, error: v.error } };
    for (const [f, ms] of vistas) if (t - ms > 2 * MAX_DESFASE_MS) vistas.delete(f);
    const firma = String(headers['x-pms-signature']).toLowerCase();
    if (vistas.has(firma)) return { status: 409, body: { ok: false, error: 'replayed_signature' } };
    vistas.set(firma, t);
    const r = await llamada.llamar({ clave: body?.clave, resumen: body?.resumen });
    if (r.ok) return { status: 202, body: { ok: true, intento: r.intento, session_id: r.session_id } };
    const { ok: _ok, ...resto } = r;
    return { status: CODIGO_POR_MOTIVO[r.motivo] || 500, body: { ok: false, ...resto } };
  };
}

module.exports = { crearManejadorLlamadaEmergencia, verificarFirmaPms, firmar };
