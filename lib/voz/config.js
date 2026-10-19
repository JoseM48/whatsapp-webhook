'use strict';

// LLAMADAS DE WHATSAPP ATENDIDAS POR CAMI CON VOZ (GO 2026-10-19).
// Toda la configuracion sale de variables de entorno; ningun valor secreto
// vive en el codigo. Apagado por defecto: el codigo se puede desplegar a
// oscuras y no hace nada hasta VOZ_LLAMADAS_HABILITADAS=true.

function numero(valor, porDefecto, { min = 0, max = Infinity } = {}) {
  const n = Number(valor);
  return Number.isFinite(n) && n >= min && n <= max ? n : porDefecto;
}

function texto(valor, porDefecto) {
  const t = String(valor ?? '').trim();
  return t || porDefecto;
}

function readVozConfig(env = process.env) {
  return Object.freeze({
    habilitada: String(env.VOZ_LLAMADAS_HABILITADAS || '').trim().toLowerCase() === 'true',
    apiKey: String(env.VOZ_OPENAI_API_KEY || '').trim(),
    webhookSecret: String(env.VOZ_OPENAI_WEBHOOK_SECRET || '').trim(),
    modelo: texto(env.VOZ_OPENAI_MODELO, 'gpt-realtime-mini'),
    voz: texto(env.VOZ_OPENAI_VOZ, 'marin'),
    modeloTranscripcion: texto(env.VOZ_OPENAI_MODELO_TRANSCRIPCION, 'gpt-4o-mini-transcribe'),
    modeloResumen: texto(env.VOZ_OPENAI_MODELO_RESUMEN, 'gpt-4o-mini'),
    topeUsdMes: numero(env.VOZ_TOPE_USD_MES, 50, { min: 0, max: 10000 }),
    costoUsdMinuto: numero(env.VOZ_COSTO_USD_MINUTO, 0.06, { min: 0, max: 10 }),
    duracionMaxMin: numero(env.VOZ_DURACION_MAX_MIN, 10, { min: 1, max: 60 }),
    apiBase: texto(env.VOZ_OPENAI_API_BASE, 'https://api.openai.com/v1').replace(/\/$/, ''),
    wsBase: texto(env.VOZ_OPENAI_WS_BASE, 'wss://api.openai.com/v1').replace(/\/$/, ''),
  });
}

// Lo que se puede imprimir en el arranque: nunca valores secretos.
function vozConfigParaLog(config) {
  return {
    habilitada: config.habilitada,
    api_key_present: Boolean(config.apiKey),
    webhook_secret_present: Boolean(config.webhookSecret),
    modelo: config.modelo,
    voz: config.voz,
    tope_usd_mes: config.topeUsdMes,
    costo_usd_minuto: config.costoUsdMinuto,
    duracion_max_min: config.duracionMaxMin,
  };
}

module.exports = { readVozConfig, vozConfigParaLog };
