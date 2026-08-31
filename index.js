// index.js (INTEGRADO CON MOTOR WEB)
// ===============================
// Dependencias y carga de ENV
// ===============================
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const { FEATURES, enabledList } = require('./config/features.js');
const { google } = require('googleapis');
const { OpenAI } = require('openai');
const { PmsPilotClient } = require('./lib/pilot/pms-client');
const { PilotAi } = require('./lib/pilot/ai');
const { PilotOrchestrator } = require('./lib/pilot/orchestrator');
const { runStartupPreflight } = require('./lib/pilot/startup-preflight');
const {
  parseAllowlist,
  isAllowlisted,
  validateMetaSignature,
  maskPhone: maskPilotPhone
} = require('./lib/pilot/security');
const { selectWebhookRoute } = require('./lib/pilot/webhook-routing');
const { createPhase2cPhoneTestCapture } = require('./lib/pilot/phase2c-phone-test');
const { createPmsWarmup } = require('./lib/pilot/pms-warmup');
const { createTypingIndicator } = require('./lib/pilot/typing-indicator');
const { createWaitAck } = require('./lib/pilot/wait-ack');
const { resolvePmsIngress } = require('./lib/pilot/controlled-ingress');
const { CONSENT_NOTICE_HASH, CONSENT_NOTICE_VERSION, decideM0Response } = require('./lib/pilot/m0-ingress');
const { SupervisedOutboundAdapter } = require('./lib/pilot/supervised-outbound-adapter');
const { runSupervisedReservationConfirmationRelay } = require('./lib/pilot/supervised-outbound-relay');
const { observeM0 } = require('./lib/pilot/m0-observer');
const { sendGovernedM0 } = require('./lib/pilot/m0-governed-outbound');
const { startM0ObservationLoop } = require('./lib/pilot/m0-observation-loop');
const { resolveM0ControlCommand } = require('./lib/pilot/m0-kill-switch-command');
const { createM0ClosedPilotDispatcher } = require('./lib/pilot/m0-closed-pilot');
const { createM0CommercialResponder } = require('./lib/pilot/m0-commercial-responder');
const { createM0DeliveryReceiptHandler } = require('./lib/pilot/m0-delivery-receipts');
const { extractMetaMessages, extractMetaStatuses, m0CommercialText } = require('./lib/pilot/meta-inbound');
const { InboundAudioTranscriber } = require('./lib/pilot/inbound-audio');
const { parseFlowResponse, flowResponseToText } = require('./lib/pilot/flow-response');
const { toFile } = require('openai');

// Logs de variables críticas (sin exponer valores)
console.log('ENV CHECK →', {
  ACCESS_TOKEN: process.env.ACCESS_TOKEN ? '✔️' : '❌',
  VERIFY_TOKEN: process.env.VERIFY_TOKEN ? '✔️' : '❌',
  PHONE_NUMBER_ID: process.env.PHONE_NUMBER_ID ? '✔️' : '❌',
  OPENAI_API_KEY: process.env.OPENAI_API_KEY ? '✔️' : '❌',
  SPREADSHEET_ID: process.env.SPREADSHEET_ID ? '✔️' : '❌',
  ADMIN_WA_NUMBER: process.env.ADMIN_WA_NUMBER ? '✔️' : '❌',
  POLITICA_URL: process.env.POLITICA_URL ? '✔️' : '❌',
  GOOGLE_FORMS_ENCUESTA: process.env.GOOGLE_FORMS_ENCUESTA ? '✔️' : '❌',
  BOOKING_BASE_URL: process.env.BOOKING_BASE_URL ? '✔️' : '❌',
  GPS_LAT: process.env.GPS_LAT ? '✔️' : '❌',
  GPS_LNG: process.env.GPS_LNG ? '✔️' : '❌',
  GPS_NAME: process.env.GPS_NAME ? '✔️' : '❌',
});

// ===============================
// Carga robusta de credenciales Google
// ===============================
function loadGoogleCreds() {
  const fromEnvPath = (process.env.GOOGLE_APPLICATION_CREDENTIALS || '').trim();
  if (fromEnvPath && fs.existsSync(fromEnvPath)) {
    console.log('[google-creds] usando ruta GOOGLE_APPLICATION_CREDENTIALS:', fromEnvPath);
    try { return JSON.parse(fs.readFileSync(fromEnvPath, 'utf8')); }
    catch { throw new Error('google_creds_parse_error_from_env_path'); }
  }
  const fromEnvJson = (process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON || '').trim();
  if (fromEnvJson) {
    console.log('[google-creds] usando JSON inline GOOGLE_APPLICATION_CREDENTIALS_JSON');
    try { return JSON.parse(fromEnvJson); }
    catch { throw new Error('google_creds_parse_error_from_env_json'); }
  }
  const altPath = path.resolve(__dirname, 'secrets/google-creds.json');
  if (fs.existsSync(altPath)) {
    console.log('[google-creds] usando archivo local:', altPath);
    try { return JSON.parse(fs.readFileSync(altPath, 'utf8')); }
    catch { throw new Error('google_creds_parse_error_from_local_file'); }
  }
  const localPath = path.resolve(__dirname, 'google-creds.json');
  if (fs.existsSync(localPath)) {
    console.log('[google-creds] usando archivo local:', localPath);
    try { return JSON.parse(fs.readFileSync(localPath, 'utf8')); }
    catch { throw new Error('google_creds_parse_error_from_local_file'); }
  }
  throw new Error('google_creds_missing');
}
const GOOGLE_CREDS = loadGoogleCreds();

// ===============================
// OpenAI (fallback IA)
// ===============================
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// F-AUDIO-001: transcribe notas de voz entrantes antes de que entren al
// mismo camino que un mensaje de texto (ver m0CommercialText). Apagado por
// defecto - cada transcripcion es una llamada real y paga a OpenAI.
const M0_AUDIO_TRANSCRIPTION_ENABLED = String(process.env.M0_AUDIO_TRANSCRIPTION_ENABLED || 'false').toLowerCase() === 'true';
// Lista de prueba: mientras esta lista no este vacia, solo estos telefonos
// activan transcripcion, sin importar M0_AUDIO_TRANSCRIPTION_ENABLED - asi
// se puede probar con un numero real antes de abrirlo a todos los huespedes.
const M0_AUDIO_TRANSCRIPTION_ALLOWLIST_PHONES = parseAllowlist(process.env.M0_AUDIO_TRANSCRIPTION_ALLOWLIST_PHONES || '');
const inboundAudioTranscriber = new InboundAudioTranscriber({
  http: axios, openai, toFile, accessToken: process.env.ACCESS_TOKEN
});

// ===============================
// Motor de reservas (adapter Puppeteer) – carga tolerante
let checkAvailability, createReservation, selectAndCheckout;
try {
  ({ checkAvailability, createReservation, selectAndCheckout } =
    require('./services/bookingAdapter'));
  console.log('[booking] Adapter Puppeteer cargado ✔️');
} catch (e) {
  console.warn('[booking] Adapter no encontrado:', e?.message || e);
}


// ===============================
// Config general
// ===============================
const app = express();
app.use(express.json({
  limit: '1mb',
  verify: (req, _res, buffer) => { req.rawBody = Buffer.from(buffer); }
}));

// ===============================
// Helpers comunes
// ===============================
function onlyDigits(s = '') { return (s || '').replace(/[^\d]/g, ''); }
function normalizePhone(raw, defaultCc = '57') {
  const digits = onlyDigits(raw);
  if (!digits) return null;
  if (digits.length >= 11 && digits.length <= 15) return digits;
  if (digits.length === 10) return defaultCc + digits;
  return digits;
}
function buildSearchUrl({ checkin, checkout, people = 2 }) {
  const base = process.env.BOOKING_BASE_URL || 'https://www.miolafrontera.com/bv3/search';
  const url = new URL(base);
  const payload = {
    checkin_date: checkin,
    checkout_date: checkout,
    day_count: Math.max(1, Math.round((new Date(checkout) - new Date(checkin)) / 86400000)),
    room_count: 1,
    total_adult: people,
    total_child: 0,
    rooms: [{ adult_count: people, guest_count: people, child_count: 0, child_ages: [] }],
    guest_rooms: { "0": { adult_count: people, guest_count: people, child_count: 0, child_ages: [] } }
  };
  url.searchParams.set('search', JSON.stringify(payload));
  return url.toString();
}
const fmtCOP = new Intl.NumberFormat('es-CO');
function formatCOP(n) { return (n == null) ? '' : fmtCOP.format(n); }
function parseAptoFromText(t) {
  const m = String(t || '').match(/\b(\d{3,4})\b/);
  return m ? m[1] : null;
}

// ===============================
// WhatsApp helpers
// ===============================
const WHATSAPP_API_URL = `https://graph.facebook.com/v20.0/${process.env.PHONE_NUMBER_ID}/messages`;
const BRAIN_URL = process.env.BRAIN_URL || 'http://localhost:3010';
const PMS_LITE_ENABLED = String(process.env.PMS_LITE_ENABLED || 'false').toLowerCase() === 'true';
const PMS_LITE_INBOUND_URL = (process.env.PMS_LITE_INBOUND_URL || '').trim();
const PMS_LITE_WEBHOOK_SECRET = (process.env.PMS_LITE_WEBHOOK_SECRET || '').trim();
const PMS_LITE_TIMEOUT_MS = Number(process.env.PMS_LITE_TIMEOUT_MS || 1500);
const PMS_LITE_ALLOWLIST_PHONES = (process.env.PMS_LITE_ALLOWLIST_PHONES || '')
  .split(',')
  .map((phone) => normalizePhone(phone.trim()))
  .filter(Boolean);
const PMS_LITE_CONTROLLED_INGRESS_ENABLED = String(
  process.env.PMS_LITE_CONTROLLED_INGRESS_ENABLED || 'false'
).toLowerCase() === 'true';
const PMS_LITE_M0_ENABLED = String(process.env.PMS_LITE_M0_ENABLED || 'false').toLowerCase() === 'true';
if (PMS_LITE_M0_ENABLED && (!PMS_LITE_ENABLED || !PMS_LITE_CONTROLLED_INGRESS_ENABLED)) {
  throw new Error('PMS_LITE_M0_ENABLED requires PMS_LITE_ENABLED and PMS_LITE_CONTROLLED_INGRESS_ENABLED');
}
const MVP_LA_FRONTERA_ENABLED = String(process.env.MVP_LA_FRONTERA_ENABLED || 'false').toLowerCase() === 'true';
const MVP_LA_FRONTERA_MEDIA_ENABLED = String(process.env.MVP_LA_FRONTERA_MEDIA_ENABLED || 'true').toLowerCase() === 'true';
const MVP_LA_FRONTERA_ALLOWLIST_PHONES = parseAllowlist(
  process.env.MVP_LA_FRONTERA_ALLOWLIST_PHONES || process.env.PMS_LITE_ALLOWLIST_PHONES || ''
);
const META_SIGNATURE_REQUIRED = String(process.env.META_SIGNATURE_REQUIRED || 'false').toLowerCase() === 'true';
if (PMS_LITE_M0_ENABLED && (!META_SIGNATURE_REQUIRED || !(process.env.META_APP_SECRET || '').trim())) {
  throw new Error('PMS_LITE_M0_ENABLED requires META_SIGNATURE_REQUIRED=true and META_APP_SECRET');
}
const M0_CLOSED_PILOT_ENABLED = String(process.env.M0_CLOSED_PILOT_ENABLED || 'false').toLowerCase() === 'true';
const M0_CLOSED_PILOT_GUEST_PHONE = normalizePhone(process.env.M0_CLOSED_PILOT_GUEST_PHONE || '');
const M0_CLOSED_PILOT_INTERNAL_PHONE = normalizePhone(process.env.M0_CLOSED_PILOT_INTERNAL_PHONE || '');
const M0_CLOSED_PILOT_RECEIPTS_ENABLED = String(process.env.M0_CLOSED_PILOT_RECEIPTS_ENABLED || 'false').toLowerCase() === 'true';
const M0_CLOSED_PILOT_INTERNAL_TEMPLATE_NAME = String(process.env.M0_CLOSED_PILOT_INTERNAL_TEMPLATE_NAME || '').trim();
const M0_CLOSED_PILOT_INTERNAL_TEMPLATE_LANGUAGE = String(process.env.M0_CLOSED_PILOT_INTERNAL_TEMPLATE_LANGUAGE || 'es_CO').trim();
// Calendar + duration WhatsApp Flow (check-in date + 1/3/6/12 month tier),
// sent instead of a plain-text question when M0 needs those specific fields.
// Empty by default: until Meta assigns a real Flow id after publishing,
// M0_CLOSED_PILOT_FLOW_ENABLED must stay false and the pipeline falls back
// to the pre-existing plain-text question.
const M0_CLOSED_PILOT_FLOW_ENABLED = String(process.env.M0_CLOSED_PILOT_FLOW_ENABLED || 'false').toLowerCase() === 'true';
const M0_CLOSED_PILOT_FLOW_ID = String(process.env.M0_CLOSED_PILOT_FLOW_ID || '').trim();
const M0_CLOSED_PILOT_FLOW_FIRST_SCREEN = String(process.env.M0_CLOSED_PILOT_FLOW_FIRST_SCREEN || 'CHECKIN_SCREEN').trim();
// 'draft' while testing an unpublished Flow with the authorized test phones
// only; empty/unset once the Flow is published, so it resolves for any guest.
const M0_CLOSED_PILOT_FLOW_MODE = String(process.env.M0_CLOSED_PILOT_FLOW_MODE || '').trim().toLowerCase();
const M0_CLOSED_PILOT_FLOW_TEST_ALLOWLIST_PHONES = parseAllowlist(process.env.M0_CLOSED_PILOT_FLOW_TEST_ALLOWLIST_PHONES || '');
const DEBUG_ENDPOINTS_ENABLED = String(process.env.DEBUG_ENDPOINTS_ENABLED || 'false').toLowerCase() === 'true';
const BOOKING_ENDPOINTS_ENABLED = String(process.env.BOOKING_ENDPOINTS_ENABLED || 'false').toLowerCase() === 'true';
const PHASE2C_PHONE_TEST_ENABLED = String(process.env.PHASE2C_PHONE_TEST_ENABLED || 'false').toLowerCase() === 'true';
const PMS_LITE_STARTUP_PREFLIGHT_ENABLED = String(
  process.env.PMS_LITE_STARTUP_PREFLIGHT_ENABLED || 'false'
).toLowerCase() === 'true';
const PILOT_OPENAI_MODEL = (process.env.PILOT_OPENAI_MODEL || 'gpt-5.6-luna').trim();
const PILOT_ORGANIZATION_KEY = (process.env.PILOT_ORGANIZATION_KEY || 'versadaa').trim();
const PILOT_VERTICAL_KEY = (process.env.PILOT_VERTICAL_KEY || 'alojamientos_la_frontera').trim();
const PILOT_CHANNEL_ACCOUNT_KEY = (process.env.PILOT_CHANNEL_ACCOUNT_KEY || process.env.PHONE_NUMBER_ID || '').trim();
const PMS_LITE_BASE_URL = (process.env.PMS_LITE_BASE_URL || (() => {
  try { return new URL(PMS_LITE_INBOUND_URL).origin; } catch { return ''; }
})()).replace(/\/$/, '');
const PMS_LITE_PUBLIC_BASE_URL = (process.env.PMS_LITE_PUBLIC_BASE_URL || PMS_LITE_BASE_URL).replace(/\/$/, '');
const M0_OPERATOR_PROPOSAL_RELAY_VERSION = (process.env.M0_OPERATOR_PROPOSAL_RELAY_VERSION || '').trim();
const M0_OPERATOR_AVAILABILITY_CERTIFICATION_VERSION = (process.env.M0_OPERATOR_AVAILABILITY_CERTIFICATION_VERSION || '').trim();
const M0_OPERATOR_PRERESERVATION_RELAY_VERSION = (process.env.M0_OPERATOR_PRERESERVATION_RELAY_VERSION || '').trim();
const M0_OPERATOR_SUPERVISED_OUTBOUND_RELAY_VERSION = (process.env.M0_OPERATOR_SUPERVISED_OUTBOUND_RELAY_VERSION || '').trim();
const M0_OPERATOR_RUNTIME_REACTIVATION_VERSION = (process.env.M0_OPERATOR_RUNTIME_REACTIVATION_VERSION || '').trim();
const phase2cPhoneTestCapture = createPhase2cPhoneTestCapture({
  enabled: PHASE2C_PHONE_TEST_ENABLED,
  runtimeSafe: !PMS_LITE_ENABLED && !MVP_LA_FRONTERA_ENABLED,
  allowlist: PMS_LITE_ALLOWLIST_PHONES,
  managerPhone: process.env.ADMIN_WA_NUMBER
});

function maskPhone(raw) {
  const phone = normalizePhone(raw);
  if (!phone) return null;
  return `***${phone.slice(-4)}`;
}

function getPmsLiteUrlPath() {
  if (!PMS_LITE_INBOUND_URL) return null;
  try {
    return new URL(PMS_LITE_INBOUND_URL).pathname;
  } catch {
    return 'invalid_url';
  }
}

console.log('[pms-lite] config', {
  enabled: PMS_LITE_ENABLED,
  inbound_url_present: Boolean(PMS_LITE_INBOUND_URL),
  inbound_url_path: getPmsLiteUrlPath(),
  webhook_secret_present: Boolean(PMS_LITE_WEBHOOK_SECRET),
  allowlist_count: PMS_LITE_ALLOWLIST_PHONES.length,
  controlled_ingress_enabled: PMS_LITE_CONTROLLED_INGRESS_ENABLED,
  m0_enabled: PMS_LITE_M0_ENABLED,
  timeout_ms: PMS_LITE_TIMEOUT_MS
});

console.log('[pilot-la-frontera] config', {
  enabled: MVP_LA_FRONTERA_ENABLED,
  ready: Boolean(PMS_LITE_ENABLED && PMS_LITE_BASE_URL && PMS_LITE_INBOUND_URL && PMS_LITE_WEBHOOK_SECRET && MVP_LA_FRONTERA_ALLOWLIST_PHONES.length),
  allowlist_count: MVP_LA_FRONTERA_ALLOWLIST_PHONES.length,
  media_enabled: MVP_LA_FRONTERA_MEDIA_ENABLED,
  meta_signature_required: META_SIGNATURE_REQUIRED,
  model: PILOT_OPENAI_MODEL,
  debug_endpoints_enabled: DEBUG_ENDPOINTS_ENABLED,
  booking_endpoints_enabled: BOOKING_ENDPOINTS_ENABLED
});

console.log('[phase2c-phone-test] config', phase2cPhoneTestCapture.status());

const pmsPilotClient = new PmsPilotClient({
  http: axios,
  baseUrl: PMS_LITE_BASE_URL,
  inboundUrl: PMS_LITE_INBOUND_URL,
  secret: PMS_LITE_WEBHOOK_SECRET,
  timeoutMs: Number(process.env.MVP_LA_FRONTERA_TIMEOUT_MS || 8000),
  publicBaseUrl: PMS_LITE_PUBLIC_BASE_URL,
  mediaSigningSecret: process.env.PILOT_MEDIA_SIGNING_SECRET || PMS_LITE_WEBHOOK_SECRET
});

const pmsWarmup = createPmsWarmup({
  enabled: M0_CLOSED_PILOT_ENABLED ||
    String(process.env.PMS_LITE_WARMUP_ENABLED || 'false').toLowerCase() === 'true',
  cooldownMs: Number(process.env.PMS_LITE_WARMUP_COOLDOWN_MS || 60_000),
  readyTtlMs: Number(process.env.PMS_LITE_WARMUP_READY_TTL_MS || 600_000),
  maxWaitMs: Number(process.env.PMS_LITE_WARMUP_MAX_WAIT_MS || 85_000),
  retryDelayMs: Number(process.env.PMS_LITE_WARMUP_RETRY_DELAY_MS || 5_000),
  requestTimeoutMs: Number(process.env.PMS_LITE_WARMUP_REQUEST_TIMEOUT_MS || 15_000),
  warm: (timeoutMs) => pmsPilotClient.warmup(timeoutMs),
});

const pilotTypingIndicator = createTypingIndicator({
  enabled: String(process.env.PILOT_TYPING_INDICATOR_ENABLED || 'false').toLowerCase() === 'true',
  send: (payload) => axios.post(WHATSAPP_API_URL, payload, {
    headers: { Authorization: `Bearer ${process.env.ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    timeout: 15_000,
  }),
});

const pilotWaitAck = createWaitAck({
  enabled: String(process.env.PILOT_WAIT_ACK_ENABLED || 'false').toLowerCase() === 'true',
  send: async (recipient, text) => {
    const phone = normalizePhone(recipient);
    if (!phone) throw Object.assign(new Error('invalid_recipient'), { code: 'invalid_recipient' });
    await axios.post(WHATSAPP_API_URL, {
      messaging_product: 'whatsapp', to: phone, text: { body: text },
    }, {
      headers: { Authorization: `Bearer ${process.env.ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
      timeout: 5_000,
    });
  },
});

const pilotAi = new PilotAi({
  http: axios,
  apiKey: process.env.OPENAI_API_KEY,
  model: PILOT_OPENAI_MODEL,
  safetySalt: process.env.PILOT_SAFETY_SALT || PMS_LITE_WEBHOOK_SECRET
});

async function sendPilotWhatsAppText(to, body) {
  const phone = normalizePhone(to);
  if (!phone) throw Object.assign(new Error('invalid_recipient'), { code: 'invalid_recipient' });
  const response = await axios.post(WHATSAPP_API_URL, {
    messaging_product: 'whatsapp', to: phone, text: { body }
  }, {
    headers: { Authorization: `Bearer ${process.env.ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    timeout: 15000
  });
  return response.data?.messages?.[0]?.id || null;
}

async function sendPilotWhatsAppImage(to, link) {
  if (!MVP_LA_FRONTERA_MEDIA_ENABLED) return null;
  const phone = normalizePhone(to);
  if (!phone) throw Object.assign(new Error('invalid_recipient'), { code: 'invalid_recipient' });
  const response = await axios.post(WHATSAPP_API_URL, {
    messaging_product: 'whatsapp', to: phone, image: { link }
  }, {
    headers: { Authorization: `Bearer ${process.env.ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    timeout: 20000
  });
  return response.data?.messages?.[0]?.id || null;
}

async function sendM0ClosedInternalTemplate(to, { name, language, parameters }) {
  const phone = normalizePhone(to);
  if (!phone) throw Object.assign(new Error('invalid_recipient'), { code: 'invalid_recipient' });
  if (!name || !language || !Array.isArray(parameters) || parameters.length !== 5) {
    throw Object.assign(new Error('invalid_internal_template'), { code: 'invalid_internal_template' });
  }
  const response = await axios.post(WHATSAPP_API_URL, {
    messaging_product: 'whatsapp', to: phone, type: 'template',
    template: { name, language: { code: language }, components: [{ type: 'body',
      parameters: parameters.map((text) => ({ type: 'text', text })) }] }
  }, {
    headers: { Authorization: `Bearer ${process.env.ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    timeout: 15000
  });
  return response.data?.messages?.[0]?.id || null;
}

async function sendPilotWhatsAppFlow(to, { flowId, flowToken, firstScreen, ctaText, bodyText, mode }) {
  const phone = normalizePhone(to);
  if (!phone) throw Object.assign(new Error('invalid_recipient'), { code: 'invalid_recipient' });
  if (!flowId) throw Object.assign(new Error('invalid_flow_id'), { code: 'invalid_flow_id' });
  const response = await axios.post(WHATSAPP_API_URL, {
    messaging_product: 'whatsapp', to: phone, type: 'interactive',
    interactive: {
      type: 'flow',
      body: { text: bodyText },
      action: {
        name: 'flow',
        parameters: {
          flow_message_version: '3', flow_token: flowToken, flow_id: flowId,
          // 'draft' lets the two authorized test phones exercise an unpublished
          // Flow before it goes live; omit (undefined) once published so real
          // guests always resolve the published version. The key is
          // "flow_mode" (every sibling key in this object carries the flow_
          // prefix) -- a first attempt using bare "mode" was rejected by Meta
          // with (#131009) Parameter value is not valid.
          ...(mode ? { flow_mode: mode } : {}),
          flow_cta: ctaText, flow_action: 'navigate',
          flow_action_payload: { screen: firstScreen, data: {} }
        }
      }
    }
  }, {
    headers: { Authorization: `Bearer ${process.env.ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    timeout: 15000
  });
  return response.data?.messages?.[0]?.id || null;
}

async function sendPilotWhatsAppTemplate(to, templateName, parameters, documentProviderReference = null) {
  const phone = normalizePhone(to);
  if (!phone) throw Object.assign(new Error('invalid_recipient'), { code: 'invalid_recipient' });
  const components = [];
  if (documentProviderReference) {
    components.push({ type: 'header', parameters: [{ type: 'document', document: { id: documentProviderReference } }] });
  }
  components.push({
    type: 'body',
    parameters: parameters.map((value) => ({ type: 'text', text: String(value) }))
  });
  const response = await axios.post(WHATSAPP_API_URL, {
    messaging_product: 'whatsapp',
    to: phone,
    type: 'template',
    template: { name: templateName, language: { code: 'es_CO' }, components }
  }, {
    headers: { Authorization: `Bearer ${process.env.ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    timeout: 15000
  });
  return response.data?.messages?.[0]?.id || null;
}

async function syncPilotLeadToBrain(lead) {
  const headers = {};
  if (process.env.BRAIN_SERVICE_TOKEN) headers['X-Brain-Service-Token'] = process.env.BRAIN_SERVICE_TOKEN;
  await axios.post(`${BRAIN_URL}/lead/upsert`, lead, { timeout: 10000, headers });
}

const pilotOrchestrator = new PilotOrchestrator({
  pms: pmsPilotClient,
  ai: pilotAi,
  brainSync: syncPilotLeadToBrain,
  sendText: sendPilotWhatsAppText,
  sendImage: sendPilotWhatsAppImage,
  context: {
    organizationKey: PILOT_ORGANIZATION_KEY,
    verticalKey: PILOT_VERTICAL_KEY,
    channelKey: 'whatsapp',
    channelAccountKey: PILOT_CHANNEL_ACCOUNT_KEY || null,
    conversationKey: (phone) => `whatsapp:${crypto.createHmac(
      'sha256',
      process.env.PILOT_CONVERSATION_SALT || process.env.PILOT_SAFETY_SALT || PMS_LITE_WEBHOOK_SECRET
    ).update(String(phone)).digest('hex')}`
  },
  logger: console
});

const m0ClosedPilot = createM0ClosedPilotDispatcher({
  config: {
    enabled: M0_CLOSED_PILOT_ENABLED,
    guestPhone: M0_CLOSED_PILOT_GUEST_PHONE,
    internalPhone: M0_CLOSED_PILOT_INTERNAL_PHONE,
    allowlist: PMS_LITE_ALLOWLIST_PHONES,
    metaSignatureRequired: META_SIGNATURE_REQUIRED,
    pmsM0Enabled: PMS_LITE_M0_ENABLED,
    controlledIngressEnabled: PMS_LITE_CONTROLLED_INGRESS_ENABLED,
    pmsConfigured: Boolean(PMS_LITE_ENABLED && PMS_LITE_BASE_URL && PMS_LITE_WEBHOOK_SECRET),
    receiptsEnabled: M0_CLOSED_PILOT_RECEIPTS_ENABLED,
    internalTemplateName: M0_CLOSED_PILOT_INTERNAL_TEMPLATE_NAME,
    internalTemplateLanguage: M0_CLOSED_PILOT_INTERNAL_TEMPLATE_LANGUAGE,
    flow: { enabled: M0_CLOSED_PILOT_FLOW_ENABLED, flowId: M0_CLOSED_PILOT_FLOW_ID,
      firstScreen: M0_CLOSED_PILOT_FLOW_FIRST_SCREEN, mode: M0_CLOSED_PILOT_FLOW_MODE || null,
      testAllowlist: M0_CLOSED_PILOT_FLOW_TEST_ALLOWLIST_PHONES }
  },
  pms: pmsPilotClient,
  sendText: sendPilotWhatsAppText,
  sendTemplate: sendM0ClosedInternalTemplate,
  sendFlow: sendPilotWhatsAppFlow,
  logger: console
});

const m0DeliveryReceipts = createM0DeliveryReceiptHandler({
  config: { enabled: M0_CLOSED_PILOT_RECEIPTS_ENABLED,
    guestPhone: M0_CLOSED_PILOT_GUEST_PHONE, internalPhone: M0_CLOSED_PILOT_INTERNAL_PHONE,
    allowlist: PMS_LITE_ALLOWLIST_PHONES, metaSignatureRequired: META_SIGNATURE_REQUIRED,
    pmsConfigured: Boolean(PMS_LITE_ENABLED && PMS_LITE_BASE_URL && PMS_LITE_WEBHOOK_SECRET) },
  pms: pmsPilotClient,
  logger: console
});

const m0CommercialResponder = createM0CommercialResponder({
  capture: (payload) => pmsWarmup.run(() => pilotOrchestrator.capture(payload)),
  ai: pilotAi,
  closedPilot: m0ClosedPilot,
  pms: pmsPilotClient,
  logger: console
});

let m0AttestationFreshUntil = 0;
let m0AttestationPromise = null;
async function ensureM0RuntimeAttestation() {
  if (!PMS_LITE_M0_ENABLED) return null;
  if (Date.now() < m0AttestationFreshUntil) return { status: 'fresh' };
  if (m0AttestationPromise) return m0AttestationPromise;
  m0AttestationPromise = pmsPilotClient.attestM0({
    component: 'whatsapp_webhook',
    m0_enabled: true,
    controlled_ingress_enabled: PMS_LITE_CONTROLLED_INGRESS_ENABLED,
    meta_signature_required: META_SIGNATURE_REQUIRED,
    notice_version: CONSENT_NOTICE_VERSION,
    notice_text_hash: CONSENT_NOTICE_HASH
  }).then(async (result) => {
    await pmsPilotClient.registerOwnerAuthority({
      identity_reference: 'jose_manuel_gomez',
      apartment_codes: ['LF-210', 'LF-404', 'LF-1208']
    });
    m0AttestationFreshUntil = Date.now() + 5 * 60_000;
    return result;
  }).finally(() => { m0AttestationPromise = null; });
  return m0AttestationPromise;
}

async function runM0OperatorProposalRelay() {
  // Deliberately inert unless the operator supplies the short-lived v2 trigger.
  // This prevents any legacy environment values from repeating a request at restart.
  if (M0_OPERATOR_PROPOSAL_RELAY_VERSION !== 'v2') return null;
  if (!PMS_LITE_M0_ENABLED || !PMS_LITE_BASE_URL || !PMS_LITE_WEBHOOK_SECRET) {
    throw new Error('m0_operator_proposal_not_ready');
  }
  const requestId = (process.env.M0_OPERATOR_PROPOSAL_REQUEST_ID || '').trim();
  const checkIn = (process.env.M0_OPERATOR_PROPOSAL_CHECK_IN || '').trim();
  const checkOut = (process.env.M0_OPERATOR_PROPOSAL_CHECK_OUT || '').trim();
  const guests = Number(process.env.M0_OPERATOR_PROPOSAL_GUESTS || 0);
  const apartmentCode = (process.env.M0_OPERATOR_PROPOSAL_APARTMENT_CODE || '').trim();
  if (!/^[a-zA-Z0-9_.:-]{8,120}$/.test(requestId)
    || !/^\d{4}-\d{2}-\d{2}$/.test(checkIn)
    || !/^\d{4}-\d{2}-\d{2}$/.test(checkOut)
    || !Number.isInteger(guests) || guests < 1 || guests > 12
    || !['LF-210', 'LF-404', 'LF-1208'].includes(apartmentCode)) {
    throw new Error('m0_operator_proposal_invalid_request');
  }
  const result = await pmsPilotClient.requestLatestSupervisedProposals({
    request_id: requestId, check_in: checkIn, check_out: checkOut, guests, apartment_code: apartmentCode
  });
  console.log('[m0-operator-proposal] completed', {
    action: result?.action || null,
    proposal_count: Array.isArray(result?.proposals) ? result.proposals.length : null,
    apartment_codes: Array.isArray(result?.proposals) ? result.proposals.map((item) => item.apartment_code) : [],
    calendar_sync: result?.calendar_sync || null,
    messages_sent: result?.messages_sent ?? null
  });
  return result;
}

async function runM0OperatorAvailabilityCertificationRelay() {
  // A one-shot, versioned operator gate: it cannot run accidentally from legacy values.
  if (M0_OPERATOR_AVAILABILITY_CERTIFICATION_VERSION !== 'v1') return null;
  if (!PMS_LITE_M0_ENABLED || !PMS_LITE_BASE_URL || !PMS_LITE_WEBHOOK_SECRET) {
    throw new Error('m0_operator_availability_certification_not_ready');
  }
  const requestId = (process.env.M0_OPERATOR_AVAILABILITY_CERTIFICATION_REQUEST_ID || '').trim();
  const start = (process.env.M0_OPERATOR_AVAILABILITY_CERTIFICATION_START || '').trim();
  const endExclusive = (process.env.M0_OPERATOR_AVAILABILITY_CERTIFICATION_END_EXCLUSIVE || '').trim();
  const sourceReference = (process.env.M0_OPERATOR_AVAILABILITY_CERTIFICATION_SOURCE_REFERENCE || '').trim();
  if (!/^[a-zA-Z0-9_.:-]{8,120}$/.test(requestId)
    || !/^\d{4}-\d{2}-\d{2}$/.test(start)
    || !/^\d{4}-\d{2}-\d{2}$/.test(endExclusive)
    || sourceReference.length < 10 || sourceReference.length > 200) {
    throw new Error('m0_operator_availability_certification_invalid_request');
  }
  const result = await pmsPilotClient.registerOperationalAvailabilityCertification({
    request_id: requestId,
    window: { start, end_exclusive: endExclusive },
    source_reference: sourceReference,
    certified_by: 'jose_manuel',
    certified_by_role: 'administrador',
    units: ['LF-210', 'LF-404', 'LF-1208'].map((apartment_code) => ({ apartment_code, zero_blocks_confirmed: true }))
  });
  console.log('[m0-operator-availability-certification] completed', {
    window: result?.window || null,
    scope: result?.scope || [],
    certification_count: Array.isArray(result?.results) ? result.results.length : null,
    messages_sent: result?.messages_sent ?? null,
    external_calls_performed: result?.external_calls_performed ?? null
  });
  return result;
}

async function runM0OperatorPreReservationRelay() {
  // This one-shot gate creates only an internal pre-reservation.  The PMS
  // keeps owner notification held and requires later Airbnb verification.
  if (M0_OPERATOR_PRERESERVATION_RELAY_VERSION !== 'v1') return null;
  if (!PMS_LITE_M0_ENABLED || !PMS_LITE_BASE_URL || !PMS_LITE_WEBHOOK_SECRET) {
    throw new Error('m0_operator_pre_reservation_not_ready');
  }
  const requestId = (process.env.M0_OPERATOR_PRERESERVATION_REQUEST_ID || '').trim();
  const apartmentCode = (process.env.M0_OPERATOR_PRERESERVATION_APARTMENT_CODE || '').trim();
  if (!/^[a-zA-Z0-9_.:-]{8,120}$/.test(requestId) || !['LF-210', 'LF-404', 'LF-1208'].includes(apartmentCode)) {
    throw new Error('m0_operator_pre_reservation_invalid_request');
  }
  const result = await pmsPilotClient.createLatestSupervisedPreReservation({
    request_id: requestId, apartment_code: apartmentCode
  });
  console.log('[m0-operator-pre-reservation] completed', {
    pre_reservation_id: result?.pre_reservation_id || null,
    state: result?.state || null,
    airbnb_verification_required: result?.airbnb_verification_required ?? null,
    owner_notification_held: result?.owner_notification_held ?? null,
    messages_sent: result?.messages_sent ?? null,
    external_calls_performed: result?.external_calls_performed ?? null
  });
  return result;
}

const supervisedOutboundAdapter = new SupervisedOutboundAdapter({
  pms: pmsPilotClient,
  sendSessionText: sendPilotWhatsAppText,
  sendTemplate: sendPilotWhatsAppTemplate,
  logger: console
});
app.locals.supervisedOutboundAdapter = supervisedOutboundAdapter;

async function runM0OperatorSupervisedOutboundRelay() {
  return runSupervisedReservationConfirmationRelay({
    gateVersion: M0_OPERATOR_SUPERVISED_OUTBOUND_RELAY_VERSION,
    m0Enabled: PMS_LITE_M0_ENABLED,
    pms: pmsPilotClient,
    adapter: supervisedOutboundAdapter,
    allowlist: PMS_LITE_ALLOWLIST_PHONES,
    logger: console
  });
}

async function runM0OperatorRuntimeReactivationRelay() {
  // Explicit, one-shot, operator-gated recovery after a fail-closed deploy.
  // It only changes the M0 runtime control plane; it cannot send a guest
  // message and it leaves the reservation-confirmation relay independently off.
  if (M0_OPERATOR_RUNTIME_REACTIVATION_VERSION !== 'v1') return null;
  if (!PMS_LITE_M0_ENABLED || !PMS_LITE_BASE_URL || !PMS_LITE_WEBHOOK_SECRET) {
    throw new Error('m0_operator_runtime_reactivation_not_ready');
  }
  const commandId = `m0-reactivate-${Date.now()}`;
  const sourceEventHash = crypto.createHash('sha256')
    .update(`F-ALO-001:${commandId}:operator_api`).digest('hex').toUpperCase();
  const result = await pmsPilotClient.setM0RuntimeControl({
    command_id: commandId,
    source_event_hash: sourceEventHash,
    source_type: 'operator_api',
    state: 'active',
    reason_code: 'M0_CONTROLLED_TEST_RESUME',
    occurred_at: new Date().toISOString()
  });
  console.log('[m0-operator-runtime-reactivation] completed', {
    state: result?.state || null,
    status: result?.status || null,
    messages_sent: 0,
    external_calls_performed: 0
  });
  return result;
}

function observeM0Soon(reason) {
  if (!PMS_LITE_M0_ENABLED) return;
  setImmediate(() => { void observeM0({ enabled: true, pms: pmsPilotClient, reason, logger: console }); });
}

startM0ObservationLoop({ enabled: PMS_LITE_M0_ENABLED, observe: async (reason) => {
  await observeM0({ enabled: true, pms: pmsPilotClient, reason, logger: console });
} });

async function enviarWhatsApp(to, body) {
  const phone = normalizePhone(to);
  if (!phone) { console.error('enviarWhatsApp → número inválido:', to); return { sent: false, providerReference: null }; }
  try {
    const response = await axios.post(WHATSAPP_API_URL, {
      messaging_product: 'whatsapp',
      to: phone,
      text: { body }
    }, {
      headers: { Authorization: `Bearer ${process.env.ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
      timeout: 15000
    });
    const providerReference = response?.data?.messages?.[0]?.id || null;
    return { sent: Boolean(providerReference), providerReference };
  } catch (error) {
    console.error('Error enviando WhatsApp:', error?.response?.data || error.message);
    return { sent: false, providerReference: null };
  }
}

async function consultarBrain({ from, text, payload }) {
  try {
    const r = await axios.post(`${BRAIN_URL}/answer`, {
      question: text,
      Telefono: from,
      payload
    }, {
      timeout: 15000
    });
    
    return r.data?.reply_text || null;
  } catch (error) {
    console.error('[brain] Error consultando Brain:', error?.response?.data || error.message);
    return null;
  }
}

function getPmsLiteMessageId(payload) {
  return payload?.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.id || null;
}

function getPmsLiteTimestamp(payload) {
  const ts = payload?.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.timestamp;
  if (!ts) return new Date().toISOString();
  const seconds = Number(ts);
  return Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString() : new Date().toISOString();
}

function getPmsLiteContactName(payload) {
  return payload?.entry?.[0]?.changes?.[0]?.value?.contacts?.[0]?.profile?.name || undefined;
}

function signPmsLitePayload(timestamp, body) {
  if (!PMS_LITE_WEBHOOK_SECRET) return null;
  return crypto
    .createHmac('sha256', PMS_LITE_WEBHOOK_SECRET)
    .update(`${timestamp}.${body}`)
    .digest('hex');
}

async function enviarPmsLiteInbound({ from, text, payload }) {
  const startedAt = Date.now();
  const phoneMasked = maskPhone(from);
  const messageId = getPmsLiteMessageId(payload);
  const ingress=resolvePmsIngress({phone:normalizePhone(from),allowlist:PMS_LITE_ALLOWLIST_PHONES,
    controlledEnabled:PMS_LITE_CONTROLLED_INGRESS_ENABLED,preferControlled:PMS_LITE_M0_ENABLED});

  if (!PMS_LITE_ENABLED) {
    console.log('[pms-lite] skipped_disabled', {
      phone: phoneMasked
    });
    return { captured: false, ingressMode: ingress.mode, reason: 'disabled' };
  }
  if (!PMS_LITE_INBOUND_URL || !PMS_LITE_WEBHOOK_SECRET) {
    console.log('[pms-lite] missing_config', {
      inbound_url_present: Boolean(PMS_LITE_INBOUND_URL),
      webhook_secret_present: Boolean(PMS_LITE_WEBHOOK_SECRET),
      phone: phoneMasked
    });
    return { captured: false, ingressMode: ingress.mode, reason: 'missing_config' };
  }
  if (!ingress.allowed) {
    console.log('[pms-lite] skipped_not_allowlisted', {
      phone: phoneMasked,
      allowlist_count: PMS_LITE_ALLOWLIST_PHONES.length
    });
    return { captured: false, ingressMode: ingress.mode, reason: 'not_allowed' };
  }

  const timestamp = new Date().toISOString();
  const body = {
    telefono: normalizePhone(from),
    nombre: getPmsLiteContactName(payload),
    mensaje: text,
    timestamp: getPmsLiteTimestamp(payload),
    external_message_id: messageId || `wa-${normalizePhone(from)}-${Date.now()}`,
    origen: ingress.origin
  };
  const rawBody = JSON.stringify(body);
  const signature = signPmsLitePayload(timestamp, rawBody);

  try {
    await ensureM0RuntimeAttestation();
    console.log('[pms-lite] posting', {
      phone: phoneMasked,
      message_id_present: Boolean(messageId),
      inbound_url_path: getPmsLiteUrlPath(),
      timeout_ms: PMS_LITE_TIMEOUT_MS,
      ingress_mode: ingress.mode
    });
    const response = await axios.post(PMS_LITE_INBOUND_URL, body, {
      headers: {
        'Content-Type': 'application/json',
        'X-PMS-Timestamp': timestamp,
        'X-PMS-Signature': signature
      },
      timeout: PMS_LITE_TIMEOUT_MS
    });
    console.log('[pms-lite] inbound_ok', {
      status: response?.status,
      duration_ms: Date.now() - startedAt
    });
    return {
      captured: true,
      ingressMode: ingress.mode,
      deduplicated: response?.data?.data?.deduplicated === true,
      newlyEnrolled: response?.data?.data?.newly_enrolled === true,
      leadId: response?.data?.data?.lead?.id || null,
      interactionId: response?.data?.data?.interaction?.id || null,
      consentNotice: response?.data?.data?.consent_notice || null,
      consentActive: response?.data?.data?.consent_active === true
    };
  } catch (error) {
    const timedOut = error?.code === 'ECONNABORTED' || String(error?.message || '').toLowerCase().includes('timeout');
    if (timedOut) {
      console.log('[pms-lite] inbound_timeout', {
        code: error?.code,
        duration_ms: Date.now() - startedAt
      });
      return { captured: false, ingressMode: ingress.mode, reason: 'timeout' };
    }
    if (error?.response) {
      if(error.response.status===409&&ingress.mode==='controlled_cohort') {
        console.log('[pms-lite] controlled_cap_reached',{duration_ms:Date.now()-startedAt});
        return { captured: false, ingressMode: ingress.mode, reason: 'cap_reached' };
      }
      console.log('[pms-lite] inbound_http_error', {
        status: error.response.status,
        code: error?.code,
        remote_code: error?.response?.data?.error?.code || error?.response?.data?.error || null,
        duration_ms: Date.now() - startedAt
      });
      return { captured: false, ingressMode: ingress.mode, reason: 'http_error' };
    }
    console.log('[pms-lite] inbound_error', {
      code: error?.code,
      duration_ms: Date.now() - startedAt
    });
    return { captured: false, ingressMode: ingress.mode, reason: 'network_error' };
  }
}

async function enviarUbicacion(to, lat, lng, name, address = '') {
  const phone = normalizePhone(to);
  if (!phone) return;
  try {
    await axios.post(WHATSAPP_API_URL, {
      messaging_product: 'whatsapp',
      to: phone,
      location: {
        latitude: String(lat),
        longitude: String(lng),
        name,
        address
      }
    }, {
      headers: { Authorization: `Bearer ${process.env.ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
      timeout: 15000
    });
  } catch (error) {
    console.error('Error enviando ubicación:', error?.response?.data || error.message);
  }
}

async function consultarChatGPT(pregunta) {
  if (!process.env.OPENAI_API_KEY) return 'Gracias por tu mensaje.';
  const r = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: 'Eres el asistente de Mio La Frontera (Medellín). Responde claro, amable y breve. Si no sabes la respuesta, di que lo consultarás con el equipo humano.' },
      { role: 'user', content: pregunta }
    ],
    temperature: 0.4,
    max_tokens: 300
  });
  return r.choices[0]?.message?.content?.trim() || 'Gracias por tu mensaje.';
}

// ===============================
// Google Sheets helpers
// ===============================
async function getSheetsClient() {
  const auth = new google.auth.GoogleAuth({
    credentials: GOOGLE_CREDS,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly']
  });
  return google.sheets({ version: 'v4', auth });
}

/** Lee la fila de un apartamento y la devuelve como objeto {header: value} */
async function obtenerFilaPorApartamento(apto) {
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.SPREADSHEET_ID,
    range: process.env.SHEETS_RANGE || 'Caracteristicas!A:Z'
  });
  const rows = res.data.values || [];
  if (rows.length < 2) return null;

  const headers = rows[0].map(h => String(h || '').trim());
  // Asumimos columna A = Apto, columna B = Estado (si existe)
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const obj = {};
    headers.forEach((h, idx) => { obj[h] = row[idx]; });
    const numero = String(row[0] || '').trim();
    const estado = String(row[1] || '').trim().toLowerCase();
    if (numero === String(apto).trim() && (!estado || estado === 'activo')) {
      return obj;
    }
  }
  return null;
}

function extractWifi(row) {
  const ssid = row?.SSID || row?.Red || row?.red || row?.WifiRed || row?.WIFI_RED || '';
  const password = row?.WiFi || row?.wifi || row?.ClaveWiFi || row?.CLAVE_WIFI || row?.Password || '';
  return { ssid, password };
}

function extractHowTo(row) {
  return {
    calentador: row?.Calentador || row?.calentador || '',
    ducha: row?.Ducha || '',
    cocina: row?.Cocina || '',
    tv: row?.TV || row?.Televisor || '',
    otros: row?.Notas || row?.Instrucciones || ''
  };
}

// ===============================
// Webhook verification (GET /webhook)
// ===============================
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'dev-verify-token';
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

// ===============================
// Extraer texto de distintos tipos
// ===============================
function getIncomingText(payload) {
  const msg = payload?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
  if (!msg) return { from: null, text: null };
  const from = msg.from;

  if (msg.text?.body) return { from, text: msg.text.body.trim() };
  if (msg.interactive?.button_reply?.title) return { from, text: msg.interactive.button_reply.title.trim() };
  if (msg.interactive?.list_reply?.title) return { from, text: msg.interactive.list_reply.title.trim() };
  return { from, text: null };
}

// ===============================
// Menú (1–9)
// ===============================
const MENU_TXT = [
  '1) Reservas, disponibilidad y tarifas',
  '2) Reconfirmar reserva, pago anticipo, formas de pago',
  '3) Horarios Check In / Out',
  '4) Ubicación GPS e Indicaciones para Ingreso',
  '5) Reglas de la casa',
  '6) Clave Wifi',
  '7) Funcionamiento apartamento',
  '8) Encuesta Satisfacción',
  '9) Otras Preguntas'
].join('\n');

async function enviarMenu(to) {
  await enviarWhatsApp(to, [
    '¡Hola! 👋 Soy el asistente de Mio La Frontera.',
    'Elige una opción:',
    MENU_TXT
  ].join('\n'));
}

// ===============================
// Opción 1: Flujo de reserva
// ===============================
const DATE_RE = /^(\d{4}-\d{2}-\d{2})$/;

const sessions = new Map(); // key: from => { step, draft }
function getSession(id) { if (!sessions.has(id)) sessions.set(id, { step: 'idle', draft: {} }); return sessions.get(id); }
function resetSession(id) { sessions.set(id, { step: 'idle', draft: {} }); }

async function startBookingFlow(from) {
  const s = getSession(from);
  s.step = 'ask_checkin';
  s.draft = {};
  await enviarWhatsApp(from, 'Perfecto 🗓️\nIndícame la fecha de *check-in* en formato YYYY-MM-DD (ej: 2025-09-03)');
}

async function handleBookingFlow(from, text) {
  const s = getSession(from);
  const t = (text || '').trim();

  if (s.step === 'ask_checkin') {
    if (!DATE_RE.test(t)) return enviarWhatsApp(from, 'Formato inválido. Usa YYYY-MM-DD. Ej: 2025-09-03');
    s.draft.checkin = t;
    s.step = 'ask_checkout';
    return enviarWhatsApp(from, 'Gracias. Ahora la fecha de *check-out* (YYYY-MM-DD)');
  }

  if (s.step === 'ask_checkout') {
    if (!DATE_RE.test(t)) return enviarWhatsApp(from, 'Formato inválido. Usa YYYY-MM-DD. Ej: 2025-09-06');
    if (new Date(t) <= new Date(s.draft.checkin)) return enviarWhatsApp(from, 'El check-out debe ser posterior al check-in. Intenta nuevamente.');
    s.draft.checkout = t;
    s.step = 'ask_people';
    return enviarWhatsApp(from, '¿Para cuántas personas? (ej: 1, 2, 3...)');
  }

  if (s.step === 'ask_people') {
    const n = parseInt(t.replace(/[^\d]/g, ''), 10);
    if (!n || n < 1 || n > 6) return enviarWhatsApp(from, 'Indica un número entre 1 y 6, por favor.');
    s.draft.people = n;

    // Buscar disponibilidad y ENVIAR LINK + OPCIONES
    s.step = 'await_apto_or_done';
    await enviarWhatsApp(from, 'Un momento, verifico disponibilidad y tarifas...');
    const r = await checkAvailabilityAndRate(s.draft);

    const sample = (r.options || []).slice(0, 3).map(o =>
      `• ${o.apto} — ${o.title} — ${o.from ? `desde ${formatCOP(o.from)} ${o.currency}` : 'precio en pantalla'}`
    ).join('\n');

    const msg = [
      r.available ? '¡Tenemos disponibilidad! ✅' : 'Por ahora no vemos disponibilidad en nuestras pruebas.',
      `Fechas: ${s.draft.checkin} → ${s.draft.checkout} (x${s.draft.people})`,
      '',
      'Puedes ver y reservar aquí:',
      r.search_url,
      sample ? `\nOpciones:\n${sample}` : '',
      '',
      'Si prefieres que yo la haga, dime el número del apartamento (por ejemplo “1208”).'
    ].filter(Boolean).join('\n');

    return enviarWhatsApp(from, msg);
  }

  // Esperamos que el huésped diga "1208" o que indique que reserva por el link
  if (s.step === 'await_apto_or_done') {
    const apto = parseAptoFromText(t);

    // Si dice que la hace por el link
    if (/reserv(ar|o|é)|link|yo lo hago/i.test(t) && !apto) {
      resetSession(from);
      await enviarWhatsApp(from, 'Perfecto. Si necesitas ayuda con el proceso, estoy aquí. 😉');
      return enviarMenu(from);
    }

    if (!apto) {
      return enviarWhatsApp(from, 'Dime el número del apartamento para reservar (ej: “1208”).');
    }

    // Tenemos apto → pedir datos
    s.draft.apto = apto;
    s.step = 'ask_name';
    return enviarWhatsApp(from, `Perfecto, reservaré el ${apto}.\nPor favor, envíame tu *Nombre* (solo nombres).`);
  }

  if (s.step === 'ask_name') {
    s.draft.name = t.slice(0, 60);
    s.step = 'ask_lastname';
    return enviarWhatsApp(from, 'Ahora tu *Apellido*:');
  }

  if (s.step === 'ask_lastname') {
    s.draft.lastname = t.slice(0, 60);
    s.step = 'ask_country';
    return enviarWhatsApp(from, '¿País? (ej: Colombia)');
  }

  if (s.step === 'ask_country') {
    s.draft.country = t.slice(0, 80);
    s.step = 'ask_phone';
    return enviarWhatsApp(from, '¿Teléfono (con indicativo si es fuera de Colombia)?');
  }

  if (s.step === 'ask_phone') {
    const digits = t.replace(/[^\d]/g, '');
    if (digits.length < 7) return enviarWhatsApp(from, 'Teléfono inválido. Intenta nuevamente.');
    s.draft.phone = digits;
    s.step = 'ask_email';
    return enviarWhatsApp(from, '¿Correo electrónico?');
  }

  if (s.step === 'ask_email') {
    const email = t.trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return enviarWhatsApp(from, 'Correo inválido. Intenta nuevamente.');
    s.draft.email = email;

    // Reservar: seleccionar apto → continuar → completar checkout
    try {
      await enviarWhatsApp(from, 'Procesando tu reserva… un momento por favor.');
      if (typeof selectAndCheckout !== 'function' || typeof createReservation !== 'function') {
        // Sin adapter → comparte link
        await enviarWhatsApp(from, buildSearchUrl({ checkin: s.draft.checkin, checkout: s.draft.checkout, people: s.draft.people }));
        resetSession(from);
        return enviarMenu(from);
      }

      const sel = await selectAndCheckout({
        checkin: s.draft.checkin,
        checkout: s.draft.checkout,
        people: s.draft.people,
        apto: s.draft.apto
      });
      if (!sel?.ok || !sel?.checkout_url) {
        await enviarWhatsApp(from, 'No pude abrir el checkout automáticamente. Te comparto el link con las opciones por si deseas completar desde allí:');
        await enviarWhatsApp(from, buildSearchUrl({ checkin: s.draft.checkin, checkout: s.draft.checkout, people: s.draft.people }));
        resetSession(from);
        return enviarMenu(from);
      }

      const r = await createReservation({
        checkout_url: sel.checkout_url,
        name: s.draft.name,
        lastname: s.draft.lastname,
        country: s.draft.country || 'Colombia',
        email: s.draft.email,
        phone: s.draft.phone,
        payment_method: 'Transferencia'
      });

      await enviarWhatsApp(from, '¡Listo! Tu reserva fue completada ✅\nTe debió llegar un correo de confirmación.');
      resetSession(from);
      return enviarMenu(from);

    } catch (err) {
      await enviarWhatsApp(from, 'Tuvimos un inconveniente completando la reserva. Te comparto el link para que puedas finalizarla directamente:');
      await enviarWhatsApp(from, buildSearchUrl({ checkin: s.draft.checkin, checkout: s.draft.checkout, people: s.draft.people }));
      await escalateToHuman(from, { motivo: 'reserva_fallida', draft: s.draft, error: err?.message });
      resetSession(from);
      return enviarMenu(from);
    }
  }
}

// === Integración real con el motor web ===
async function checkAvailabilityAndRate({ checkin, checkout, people }) {
  if (typeof checkAvailability === 'function') {
    try {
      const r = await checkAvailability({ checkin, checkout, people });
      return {
        available: !!r?.available,
        nightly_rate: r?.nightly_rate ?? null,
        total: r?.total ?? null,
        currency: r?.currency ?? 'COP',
        room_name: r?.room_name ?? '',
        search_url: r?.search_url ?? buildSearchUrl({ checkin, checkout, people }),
        options: r?.options ?? []
      };
    } catch {
      // Falla interna → devolvemos link para que el bot pueda seguir
      return {
        available: false,
        nightly_rate: null,
        total: null,
        currency: 'COP',
        room_name: '',
        search_url: buildSearchUrl({ checkin, checkout, people }),
        options: []
      };
    }
  }
  // Fallback mock si no hay adapter
  console.warn('[booking] usando mock de disponibilidad');
  return {
    available: true,
    nightly_rate: 180000,
    total: 540000,
    currency: 'COP',
    room_name: '',
    search_url: buildSearchUrl({ checkin, checkout, people }),
    options: []
  };
}

// ===============================
// Otras opciones (2–9)
// ===============================
async function manejarOpcion(from, n, textoCrudo) {
  // Chequeo de banderas aquí también por consistencia
  if (!FEATURES[String(n)]) {
    await enviarWhatsApp(from, `Esa opción está en construcción. Activas: ${enabledList()}.`);
    return enviarMenu(from);
  }

  switch (n) {
    case 1:
      return startBookingFlow(from);

    case 2:
      return enviarWhatsApp(from,
        '🧾 *Reconfirmar / Anticipo / Formas de pago*\n' +
        '— Para reconfirmar tu reserva responde con tu número de reserva.\n' +
        '— Anticipo: 30–50% según fecha; saldo al check-in.\n' +
        '— Formas de pago: transferencia, tarjeta (link), efectivo.\n' +
        '¿Deseas que te envíe el link de pago?');

    case 3:
      return enviarWhatsApp(from,
        '⏰ *Horarios*\n' +
        'Check-in: 15:00 — 22:00\n' +
        'Check-out: hasta 11:00\n' +
        'Ingresos fuera de horario: avísanos para coordinar.');

    case 4: {
      if (process.env.GPS_LAT && process.env.GPS_LNG && process.env.GPS_NAME) {
        await enviarUbicacion(from, process.env.GPS_LAT, process.env.GPS_LNG, process.env.GPS_NAME, 'Ingreso principal');
        return enviarWhatsApp(from,
          '📍 *Indicaciones de ingreso*\n' +
          'Al llegar, sigue la señalización hacia recepción / portería y menciona tu reserva.');
      } else {
        return enviarWhatsApp(from,
          '📍 *Ubicación e ingreso*\n' +
          'Estamos en La Frontera, El Poblado. Si necesitas el pin GPS exacto, avísame y te envío el link.');
      }
    }

    case 5:
      return enviarWhatsApp(from,
        '📘 *Reglas de la casa*\n' +
        '— No fumar dentro del apartamento.\n' +
        '— No fiestas.\n' +
        '— Respeta horarios de silencio.\n' +
        `Política de datos: ${process.env.POLITICA_URL}`);

    case 6: { // Clave WiFi
      const m = textoCrudo.match(/^6(?:\s*[-–>→]?\s*(\d{2,4}))?$/);
      if (!m || !m[1]) return enviarWhatsApp(from, 'Dime el número de apartamento (ej: 109)');
      const apto = m[1];
      const row = await obtenerFilaPorApartamento(apto);
      if (!row) return enviarWhatsApp(from, `No encontré el apto ${apto}. ¿Puedes confirmarlo?`);
      const { ssid, password } = extractWifi(row);
      return enviarWhatsApp(from,
        `🔐 *WiFi Apto ${apto}*\n` +
        (ssid ? `• Red: ${ssid}\n` : '') +
        (password ? `• Clave: ${password}\n` : ''));
    }

    case 7: { // Funcionamiento apartamento
      const m = textoCrudo.match(/^7(?:\s*[-–>→]?\s*(\d{2,4}))?$/);
      if (!m || !m[1]) return enviarWhatsApp(from, 'Dime el número de apartamento (ej: 109)');
      const apto = m[1];
      const row = await obtenerFilaPorApartamento(apto);
      if (!row) return enviarWhatsApp(from, `No encontré el apto ${apto}.`);
      const how = extractHowTo(row);

      const msgs = [`🛠️ *Funcionamiento Apto ${apto}*`];
      if (how.calentador) msgs.push(`• Calentador: ${how.calentador}`);
      if (how.ducha) msgs.push(`• Ducha: ${how.ducha}`);
      if (how.cocina) msgs.push(`• Cocina: ${how.cocina}`);
      if (how.tv) msgs.push(`• TV: ${how.tv}`);
      if (how.otros) msgs.push(`• Otros: ${how.otros}`);
      return enviarWhatsApp(from, msgs.join('\n'));
    }

    case 8:
      return enviarWhatsApp(from, `📝 *Encuesta de Satisfacción*\nNos ayudas 1 minuto: ${process.env.GOOGLE_FORMS_ENCUESTA}`);

    case 9:
      return enviarWhatsApp(from, 'Cuéntame tu pregunta en texto o audio. Intentaré ayudarte; si es necesario, te conecto con un humano.');
  }
}

async function escalateToHuman(from, payload) {
  const admin = process.env.ADMIN_WA_NUMBER;
  if (!admin) return;
  const msg = `Escalado desde ${from}:\n${typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2)}`;
  await enviarWhatsApp(admin, msg);
}

// ===============================
// Webhook listener (POST /webhook)
// ===============================
app.post('/webhook', async (req, res) => {
  try {
    const metaAuth = validateMetaSignature({
      rawBody: req.rawBody,
      signatureHeader: req.get('X-Hub-Signature-256'),
      appSecret: process.env.META_APP_SECRET,
      required: META_SIGNATURE_REQUIRED
    });
    if (!metaAuth.ok) {
      console.warn('[webhook] meta_signature_rejected', { code: metaAuth.error });
      return res.status(metaAuth.status).json({ error: metaAuth.error });
    }

    const metaStatuses = extractMetaStatuses(req.body);
    if (metaStatuses.length) {
      try {
        const receipts = await m0DeliveryReceipts.capture(metaStatuses);
        if (receipts.processed || receipts.quarantined) console.info('[m0-delivery] receipts_persisted', {
          processed: receipts.processed, quarantined: receipts.quarantined,
          statuses: receipts.results.map((item) => item.provider_status),
          outcomes: receipts.results.map((item) => item.reason_code)
        });
      } catch (error) {
        console.error('[m0-delivery] receipt_persistence_failed', { code: error?.code || 'm0_delivery_receipt_failed' });
        return res.sendStatus(503);
      }
    }

    const metaMessages = extractMetaMessages(req.body);
    if (M0_CLOSED_PILOT_ENABLED) {
      if (!metaMessages.length) return res.sendStatus(200);
      const pendingCommercial = [];
      try {
        await pmsWarmup.waitUntilReady();
        for (const incoming of metaMessages) {
          if (M0_AUDIO_TRANSCRIPTION_ENABLED && incoming.messageType === 'audio' && incoming.audio?.id && !incoming.text
            && isAllowlisted(incoming.from, M0_AUDIO_TRANSCRIPTION_ALLOWLIST_PHONES)) {
            try {
              incoming.text = await inboundAudioTranscriber.transcribe(incoming.audio.id);
              console.info('[m0-audio] transcribed', { phone: maskPilotPhone(incoming.from), chars: incoming.text.length });
            } catch (error) {
              console.error('[m0-audio] transcription_failed', { phone: maskPilotPhone(incoming.from), code: error?.message || 'unknown' });
            }
          }
          if (incoming.flow?.responseJson && !incoming.text) {
            try {
              incoming.text = flowResponseToText(parseFlowResponse(incoming.flow.responseJson));
              console.info('[m0-flow] completed', { phone: maskPilotPhone(incoming.from) });
            } catch (error) {
              console.error('[m0-flow] response_invalid', { phone: maskPilotPhone(incoming.from), code: error?.message || 'unknown' });
            }
          }
          const raw = m0CommercialText(incoming);
          if (m0ClosedPilot.accepts(incoming.from) && !incoming.text && m0ClosedPilot.isControl(incoming.from, raw)) {
            console.warn('[m0-closed] internal_unsupported_quarantined', {
              phone: maskPilotPhone(incoming.from), message_type: incoming.messageType
            });
            continue;
          }
          if (!m0ClosedPilot.accepts(incoming.from) || m0ClosedPilot.isControl(incoming.from, raw)) {
            const closed = await m0ClosedPilot.process({ phone: incoming.from, text: raw,
              messageId: incoming.messageId, occurredAt: incoming.timestamp });
            if (closed.quarantined) console.warn('[m0-closed] phone_quarantined', { phone: maskPilotPhone(incoming.from) });
            else console.info('[m0-closed] control_processed', { case_key: closed.result?.case_key || null,
              state: closed.result?.state || null, deduplicated: closed.result?.deduplicated === true,
              deliveries: closed.deliveries?.map((item) => item.status) || [] });
            continue;
          }
          if (!incoming.messageId) {
            console.error('[m0-commercial] capture_not_ready', { message_id_present: false,
              phone: maskPilotPhone(incoming.from) });
            return res.sendStatus(503);
          }
          const closed = await m0CommercialResponder.captureAndAcknowledge({
            from: normalizePhone(incoming.from), text: raw, messageId: incoming.messageId,
            timestamp: incoming.timestamp, name: incoming.name
          });
          console.info('[m0-commercial] inbound_captured', {
            deduplicated: closed.capture_result?.deduplicated === true,
            processing_claimed: closed.processing_claimed,
            acknowledgement_queued: closed.acknowledgement_outboxes.length,
            capture_ms: closed.timings.capture_ms,
            acknowledge_ms: closed.timings.acknowledge_ms,
            error_code: closed.error_code || null
          });
          pendingCommercial.push({ incoming, raw, closed });
        }
        res.sendStatus(200);
        setImmediate(async () => {
          const today = new Intl.DateTimeFormat('en-CA', {
            timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit'
          }).format(new Date());
          for (const { incoming, raw, closed } of pendingCommercial) {
            const acknowledgementDeliveries = await m0CommercialResponder
              .deliverAcknowledgement(closed.acknowledgement_outboxes);
            console.info('[m0-commercial] acknowledgement_completed', {
              deliveries: acknowledgementDeliveries.map((item) => item.status)
            });
            const processed = await m0CommercialResponder.processCaptured({
              from: normalizePhone(incoming.from), text: raw, messageId: incoming.messageId, today,
              context: closed.context, processingClaimed: closed.processing_claimed
            });
            console.info('[m0-commercial] processing_completed', {
              ok: processed.ok, skipped: processed.skipped || null, fallback: processed.fallback === true,
              action: processed.completed?.result?.action || null,
              response_ms: processed.timings?.response_ms || null,
              code: processed.code || null
            });
          }
        });
        return;
      } catch (error) {
        console.error('[m0-closed] processing_failed', { code: error?.code || 'm0_closed_processing_failed',
          status: error?.response?.status || null });
        return res.sendStatus(503);
      }
    }

    const { from, text } = metaMessages[0] || getIncomingText(req.body) || {};
    if (!from) return res.sendStatus(200);

    // Normaliza input de texto
    const raw = (text || '').trim();
    if (!raw) return res.sendStatus(200);

    const m0Control = resolveM0ControlCommand({ enabled: PMS_LITE_M0_ENABLED, phone: from,
      managerPhone: process.env.ADMIN_WA_NUMBER, text: raw, messageId: getPmsLiteMessageId(req.body),
      occurredAt: getPmsLiteTimestamp(req.body) });
    if (m0Control) {
      try {
        const result = await pmsPilotClient.setM0RuntimeControl(m0Control);
        console.warn('[m0-control] operator_stop_processed', {
          state: result?.state || m0Control.state,
          command_id: m0Control.command_id,
          status: result?.status || null,
          deduplicated: result?.deduplicated === true
        });
        observeM0Soon('m0_control_changed');
        return res.sendStatus(200);
      } catch (error) {
        console.error('[m0-control] operator_stop_persistence_failed', {
          command_id: m0Control.command_id,
          status: error?.response?.status || null,
          code: error?.code || 'm0_control_persistence_failed'
        });
        return res.sendStatus(503);
      }
    }

    const webhookRoute = selectWebhookRoute({
      phone: from,
      pmsEnabled: PMS_LITE_ENABLED,
      mvpEnabled: MVP_LA_FRONTERA_ENABLED,
      m0Enabled: PMS_LITE_M0_ENABLED,
      quarantineAllowlist: PMS_LITE_ALLOWLIST_PHONES,
      pilotAllowlist: MVP_LA_FRONTERA_ALLOWLIST_PHONES
    });

    if (webhookRoute.action === 'quarantine') {
      if (PHASE2C_PHONE_TEST_ENABLED) {
        const capture = phase2cPhoneTestCapture.capture({
          phone: from,
          text: raw,
          messageId: getPmsLiteMessageId(req.body)
        });
        const log = {
          captured: capture.captured,
          reason: capture.reason || null,
          role: capture.role || null,
          command: capture.command || null,
          state: capture.state,
          message_id_fingerprint: capture.message_id_fingerprint || null
        };
        if (capture.captured) console.info('[phase2c-phone-test] command_received', log);
        else console.warn('[phase2c-phone-test] command_rejected', log);
      }
      console.info('[pilot] quarantined_disabled', {
        phone: maskPilotPhone(from),
        message_id_present: Boolean(getPmsLiteMessageId(req.body))
      });
      return res.sendStatus(webhookRoute.status);
    }

    if (webhookRoute.action === 'pilot') {
      const ready = PMS_LITE_ENABLED && PMS_LITE_BASE_URL && PMS_LITE_INBOUND_URL
        && PMS_LITE_WEBHOOK_SECRET && MVP_LA_FRONTERA_ALLOWLIST_PHONES.length > 0;
      const messageId = getPmsLiteMessageId(req.body);
      if (!ready || !messageId) {
        console.error('[pilot] capture_not_ready', {
          ready: Boolean(ready), message_id_present: Boolean(messageId), phone: maskPilotPhone(from)
        });
        return res.sendStatus(503);
      }
      pmsWarmup.trigger();
      void pilotTypingIndicator.show(messageId);
      let captureResult;
      try {
        captureResult = await pilotOrchestrator.capture({
          from: normalizePhone(from), text: raw, messageId,
          timestamp: getPmsLiteTimestamp(req.body), name: getPmsLiteContactName(req.body)
        });
      } catch (error) {
        console.error('[pilot] durable_capture_failed', {
          status: error?.response?.status || null,
          code: error?.code || 'capture_failed',
          phone: maskPilotPhone(from)
        });
        return res.sendStatus(503);
      }

      res.sendStatus(200);
      setImmediate(async () => {
        await pilotWaitAck.afterCapture({ captureResult, recipient: normalizePhone(from) });
        const today = new Intl.DateTimeFormat('en-CA', {
          timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit'
        }).format(new Date());
        await pilotOrchestrator.processCaptured({
          from: normalizePhone(from), text: raw, messageId, today
        });
      });
      return;
    }

    const pmsCapture = await enviarPmsLiteInbound({
      from,
      text: raw,
      payload: req.body
    });
    if (pmsCapture?.captured) observeM0Soon('inbound_captured');
    const m0 = decideM0Response({
      enabled: PMS_LITE_M0_ENABLED,
      ingressMode: pmsCapture?.ingressMode,
      captured: pmsCapture?.captured,
      deduplicated: pmsCapture?.deduplicated,
      newlyEnrolled: pmsCapture?.newlyEnrolled,
      noticePending: pmsCapture?.consentNotice?.status === 'pending',
      consentActive: pmsCapture?.consentActive === true,
      text: raw
    });
    if (m0.handled) {
      if (m0.response) {
        if (!pmsCapture?.interactionId || !m0.responseKind) {
          console.error('[m0] governed_outbound_context_missing');
          return res.sendStatus(503);
        }
        const delivery = await sendGovernedM0({ pms: pmsPilotClient,
          interactionId: pmsCapture.interactionId, responseKind: m0.responseKind,
          response: m0.response, recipient: from, sendText: sendPilotWhatsAppText,
          observe: observeM0Soon, logger: console });
        if (!delivery.sent) {
          console.error('[m0] human_fallback_required', {
            interaction_id: pmsCapture.interactionId,
            outbound_status: delivery.status || 'unknown'
          });
        }
        if (!delivery.sent && delivery.status !== 'failed' && delivery.status !== 'submission_unknown') {
          return res.sendStatus(503);
        }
      }
      return res.sendStatus(200);
    }
    const brainReply = await consultarBrain({
      from,
      text: raw,
      payload: req.body
    });

    if (brainReply) {
      await enviarWhatsApp(from, brainReply);
      return res.sendStatus(200);
    }
    const t = raw;
    const tl = t.toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, ''); // quita tildes
    const s = getSession(from); // { step: 'idle' | ... }

    // 1) Flujo en curso: prioriza manejo de estado
    if (s.step && s.step !== 'idle') {
      await handleBookingFlow(from, t);
      return res.sendStatus(200);
    }

    // 2) Saludos o pedido de menú → siempre muestra menú (sin cambiar estado)
    const isGreeting = /^(hola|buenas|buenos dias|buenas tardes|buenas noches|hi|hello)\b/.test(tl);
    if (isGreeting || tl === 'menu' || tl === 'menú') {
      await enviarMenu(from);
      return res.sendStatus(200);
    }

    // 3) Router NUMÉRICO determinista (permite "6 109" o "6->109")
    const m = tl.match(/^([1-9])(?:\s*[-–>→]?\s*(\d{2,4}))?$/);
    if (m) {
      const option = parseInt(m[1], 10);
      if (!FEATURES[String(option)]) {
        await enviarWhatsApp(from, `Esa opción está en construcción. Activas: ${enabledList()}.`);
        await enviarMenu(from);
        return res.sendStatus(200);
      }
      await manejarOpcion(from, option, t);
      return res.sendStatus(200);
    }

    // 4) Fallback controlado: ayuda + menú (ANTES de LLM)
    await enviarWhatsApp(from, 'No reconocí tu mensaje. Escribe "menu" para ver las opciones.');
    await enviarMenu(from);

    // 5) (Opcional) LLM como último recurso — comentado por seguridad de flujo
    /*
    try {
      const reply = await consultarChatGPT(t);
      if (reply && typeof reply === 'string' && reply.trim()) {
        await enviarWhatsApp(from, reply.trim());
      }
    } catch (e) {
      console.error('Error consultando GPT:', e?.response?.data || e.message);
      await enviarWhatsApp(from, 'Te conecto con un humano en breve.');
      await escalateToHuman(from, { motivo: 'gpt_fallback_error', text: t });
    }
    */

    return res.sendStatus(200);
  } catch (err) {
    console.error('Error en /webhook:', { code: err?.code || 'webhook_error', status: err?.response?.status || null });
    // Mejor 200 que 5xx para evitar reintentos de Meta
    return res.sendStatus(200);
  }
});

// ===============================
// Health & debug
// ===============================
app.get('/health', (_req, res) => res.json({
  ok: true,
  service: 'whatsapp-webhook',
  pilot_la_frontera: {
    enabled: MVP_LA_FRONTERA_ENABLED,
    allowlist_count: MVP_LA_FRONTERA_ALLOWLIST_PHONES.length,
    controlled_ingress_enabled: PMS_LITE_CONTROLLED_INGRESS_ENABLED,
    m0_enabled: PMS_LITE_M0_ENABLED,
    m0_closed_pilot: m0ClosedPilot.status(),
    m0_delivery_receipts: m0DeliveryReceipts.status(),
    m0_manual_commercial_actions: true,
    durable_capture_enabled: PMS_LITE_ENABLED,
    media_enabled: MVP_LA_FRONTERA_MEDIA_ENABLED,
    meta_signature_required: META_SIGNATURE_REQUIRED,
    supervised_outbound_adapter: {
      installed: Boolean(app.locals.supervisedOutboundAdapter),
      active: M0_OPERATOR_SUPERVISED_OUTBOUND_RELAY_VERSION === 'v1',
      automatic_retry_on_unknown: false,
      document_header_fail_closed: true
    }
  },
  phase2c_phone_test: {
    ...phase2cPhoneTestCapture.status()
  }
}));

app.use('/debug', (req, res, next) => {
  if (!DEBUG_ENDPOINTS_ENABLED) return res.status(404).json({ error: 'not_found' });
  return next();
});

app.use('/booking', (req, res, next) => {
  if (!BOOKING_ENDPOINTS_ENABLED) return res.status(404).json({ error: 'not_found' });
  return next();
});

app.get('/debug/sheets', async (req, res) => {
  try {
    const apto = String(req.query.apto || '').trim();
    if (!apto) return res.status(400).json({ ok: false, error: 'apto_required' });
    const row = await obtenerFilaPorApartamento(apto);
    return res.json({
      ok: true,
      apto,
      row,
      spreadsheetId: process.env.SPREADSHEET_ID,
      range: process.env.SHEETS_RANGE || 'Caracteristicas!A:Z'
    });
  } catch (e) {
    console.error('[debug/sheets] error:', e?.response?.data || e?.message || e);
    return res.status(500).json({ ok: false, error: 'sheets_failed' });
  }
});

// === Rutas de prueba Booking ===
app.get('/debug/booking/search', async (req, res) => {
  try {
    const { checkin, checkout, people = '2' } = req.query;
    if (typeof checkAvailability !== 'function') {
      return res.json({ ok: true, r: { available: true, search_url: buildSearchUrl({ checkin, checkout, people: parseInt(people, 10) }) } });
    }
    const r = await checkAvailability({
      checkin,
      checkout,
      people: parseInt(people, 10)
    });
    return res.json({ ok: true, r });
  } catch (e) {
    console.error('[search] error', e);
    const { checkin, checkout, people = '2' } = req.query;
    return res.json({ ok: true, r: { available: false, search_url: buildSearchUrl({ checkin, checkout, people: parseInt(people, 10) }) } });
  }
});

// Debug disponibilidad (motor web)
app.get('/debug/booking/availability', async (req, res) => {
  try {
    const { checkin, checkout, people = 2 } = req.query;
    if (!checkin || !checkout) return res.status(400).json({ ok: false, error: 'checkin_checkout_required' });
    const r = await checkAvailabilityAndRate({ checkin, checkout, people: parseInt(people, 10) || 2 });
    return res.json({ ok: true, r });
  } catch (e) {
    console.error('[debug/booking/availability]', e?.stack || e?.message || e);
    const { checkin, checkout, people = 2 } = req.query;
    return res.json({ ok: true, r: { available: false, search_url: buildSearchUrl({ checkin, checkout, people: parseInt(people, 10) || 2 }) } });
  }
});

// Confirmar reserva automática si el adapter lo soporta
app.post('/booking/confirm', async (req, res) => {
  try {
    if (typeof createReservation !== 'function') {
      return res.status(501).json({ ok: false, error: 'adapter_not_installed' });
    }
    const {
      checkout_url,
      name,
      lastname,
      country = 'Colombia',
      email,
      phone,
      payment_method = 'Transferencia'
    } = req.body || {};
    const r = await createReservation({ checkout_url, name, lastname, country, email, phone, payment_method });
    return res.json({ ok: true, ...r });
  } catch (e) {
    console.error('[booking/confirm]', e?.message || e);
    return res.status(500).json({ ok: false, error: 'booking_failed' });
  }
});

// Reservar por número de apto (flujo asistido)
app.post('/debug/booking/reserve', async (req, res) => {
  try {
    const {
      checkin, checkout, people = 2, apto,
      name, lastname, country = 'Colombia', email, phone, payment_method = 'Transferencia'
    } = req.body || {};
    if (!apto) return res.status(400).json({ ok: false, error: 'apto_required' });
    if (!name || !lastname || !email || !phone) {
      return res.status(400).json({ ok: false, error: 'missing_fields', needed: ['name', 'lastname', 'email', 'phone'] });
    }

    if (typeof selectAndCheckout !== 'function' || typeof createReservation !== 'function') {
      return res.json({ ok: false, error: 'adapter_not_installed', search_url: buildSearchUrl({ checkin, checkout, people }) });
    }

    const sel = await selectAndCheckout({ checkin, checkout, people, apto });
    if (!sel.ok || !sel.checkout_url) {
      return res.status(400).json({ ok: false, error: sel?.error || 'select_failed', search_url: sel?.search_url || buildSearchUrl({ checkin, checkout, people }) });
    }

    const r = await createReservation({
      checkout_url: sel.checkout_url,
      name, lastname, country, email, phone, payment_method
    });

    return res.json({ ok: true, r, checkout_url: sel.checkout_url });
  } catch (e) {
    console.error('[reserve] error', e);
    return res.status(500).json({ ok: false, error: 'reserve_failed', message: e?.message });
  }
});

// ===============================
// Start server (Render: 0.0.0.0 + $PORT)
// ===============================
let pilotRecoveryRunning = false;
async function recoverPilotQueues() {
  if (pilotRecoveryRunning || !PMS_LITE_ENABLED ||
    (!MVP_LA_FRONTERA_ENABLED && !M0_CLOSED_PILOT_ENABLED)) return;
  pilotRecoveryRunning = true;
  try {
    const today = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(new Date());
    if (M0_CLOSED_PILOT_ENABLED) {
      const processing = await pmsPilotClient.retryableClosedPilotCommercial(5);
      for (const record of processing || []) {
        const begin = await m0ClosedPilot.beginCommercial({
          phone: record.telefono,
          messageId: record.external_message_id,
          occurredAt: new Date(record.occurred_at).toISOString()
        });
        await m0CommercialResponder.processCaptured({
          from: record.telefono, text: record.mensaje, messageId: record.external_message_id,
          today, context: begin.result?.context || {},
          processingClaimed: begin.result?.processing_claimed === true
        });
      }
    }
    if (MVP_LA_FRONTERA_ENABLED) {
      const [processing, outbound] = await Promise.all([
        pmsPilotClient.retryableProcessing(5),
        pmsPilotClient.retryableOutbound(5)
      ]);
      for (const record of processing || []) {
        await pilotOrchestrator.processCaptured({
          from: record.telefono, text: record.mensaje,
          messageId: record.external_message_id, today
        });
      }
      for (const record of outbound || []) {
        await pilotOrchestrator.deliverClaimed({
          outboxId: record.outbox_id, recipient: record.recipient_phone
        });
      }
    }
  } catch (error) {
    console.error('[pilot] recovery_poll_failed', {
      status: error?.response?.status || null,
      code: error?.code || 'recovery_failed'
    });
  } finally {
    pilotRecoveryRunning = false;
  }
}

if (MVP_LA_FRONTERA_ENABLED || PMS_LITE_M0_ENABLED) {
  const recoveryTimer = setInterval(recoverPilotQueues, Number(process.env.MVP_RECOVERY_INTERVAL_MS || 60000));
  recoveryTimer.unref();
}

const PORT = process.env.PORT || 3021;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor iniciado en el puerto ${PORT}`);
  if (PMS_LITE_M0_ENABLED || PMS_LITE_STARTUP_PREFLIGHT_ENABLED) {
    setImmediate(async () => {
      try {
        if (M0_CLOSED_PILOT_ENABLED) await pmsWarmup.waitUntilReady({ force: true });
        await ensureM0RuntimeAttestation();
        await runM0OperatorAvailabilityCertificationRelay();
        await runM0OperatorProposalRelay();
        await runM0OperatorPreReservationRelay();
        await runM0OperatorRuntimeReactivationRelay();
        await runM0OperatorSupervisedOutboundRelay();
        observeM0Soon('startup_relays_completed');
        if (PMS_LITE_STARTUP_PREFLIGHT_ENABLED) {
          const result = await runStartupPreflight({
            http: axios,
            pms: pmsPilotClient,
            baseUrl: PMS_LITE_BASE_URL
          });
          console.info('[pms-preflight] result', result);
        }
      } catch (error) {
        console.error('[pms-preflight] failed', {
          status: error?.response?.status || null,
          code: error?.code || 'preflight_failed',
          remote_code: error?.response?.data?.error?.code || error?.response?.data?.error || null
        });
      }
    });
  }
});
