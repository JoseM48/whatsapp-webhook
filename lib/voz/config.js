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

// Limite que acepta el PMS para el costo maximo por llamada (zod en
// voz-llamadas.service.js: costo_max_llamada_usd <= 100).
const PMS_COSTO_MAX_LLAMADA_USD = 100;

function readVozConfig(env = process.env) {
  return Object.freeze({
    habilitada: String(env.VOZ_LLAMADAS_HABILITADAS || '').trim().toLowerCase() === 'true',
    // SEGUNDO NÚMERO (2026-10-28): números llamados que NO son de Miu (p. ej.
    // el de TenGo Camello, TENGOCAMELLO_DISPLAY_PHONE_NUMBER, solo dígitos,
    // separados por coma). Una llamada a ellos se rechaza sin pasar por Cami.
    destinosAjenos: Object.freeze(String(env.TENGOCAMELLO_DISPLAY_PHONE_NUMBER || '').split(',')
      .map((v) => v.replace(/\D/g, '')).filter((v) => v.length >= 8 && v.length <= 15)),
    // phone_number_id de TenGo (el mismo del chat). Si coincide con el de Miu,
    // queda vacío (fail-closed: nunca se desvía una llamada de Miu).
    tengoPhoneNumberId: (() => { const t = String(env.TENGOCAMELLO_PHONE_NUMBER_ID || '').trim();
      return /^\d{5,30}$/.test(t) && t !== String(env.PHONE_NUMBER_ID || '').trim() ? t : ''; })(),
    apiKey: String(env.VOZ_OPENAI_API_KEY || '').trim(),
    webhookSecret: String(env.VOZ_OPENAI_WEBHOOK_SECRET || '').trim(),
    modelo: texto(env.VOZ_OPENAI_MODELO, 'gpt-realtime-mini'),
    voz: texto(env.VOZ_OPENAI_VOZ, 'marin'),
    modeloTranscripcion: texto(env.VOZ_OPENAI_MODELO_TRANSCRIPCION, 'gpt-4o-mini-transcribe'),
    modeloResumen: texto(env.VOZ_OPENAI_MODELO_RESUMEN, 'gpt-4o-mini'),
    topeUsdMes: numero(env.VOZ_TOPE_USD_MES, 50, { min: 0, max: 10000 }),
    // Revision 2026-10-19 (P2-3): un costo 0 desactivaria el tope en silencio.
    costoUsdMinuto: numero(env.VOZ_COSTO_USD_MINUTO, 0.06, { min: 0.01, max: 10 }),
    duracionMaxMin: numero(env.VOZ_DURACION_MAX_MIN, 10, { min: 1, max: 60 }),
    // Espera antes del saludo, para que el audio SIP ya este fluyendo.
    saludoDemoraMs: numero(env.VOZ_SALUDO_DEMORA_MS, 1500, { min: 0, max: 5000 }),
    // Saludo de respaldo (2026-10-22): si un "¿aló?" o ruido cancelo el saludo
    // y en este tiempo nadie respondio ni se transcribio nada, se saluda igual.
    saludoRespaldoMs: numero(env.VOZ_SALUDO_RESPALDO_MS, 3000, { min: 500, max: 10000 }),
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
    costo_max_llamada_excede_pms: costoMaxExcedePms(config),
  };
}

function costoMaxExcedePms(config) {
  return config.duracionMaxMin * config.costoUsdMinuto > PMS_COSTO_MAX_LLAMADA_USD;
}

module.exports = { readVozConfig, vozConfigParaLog, costoMaxExcedePms, PMS_COSTO_MAX_LLAMADA_USD };
