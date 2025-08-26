// index.js (INTEGRADO CON MOTOR WEB)
// ===============================
// Dependencias y carga de ENV
// ===============================
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const axios = require('axios');
const { FEATURES, enabledList } = require('./config/features.js');
const { google } = require('googleapis');
const { OpenAI } = require('openai');

// Logs de variables críticas (sin exponer valores)
console.log('ENV CHECK →', {
  ACCESS_TOKEN:           process.env.ACCESS_TOKEN ? '✔️' : '❌',
  VERIFY_TOKEN:           process.env.VERIFY_TOKEN ? '✔️' : '❌',
  PHONE_NUMBER_ID:        process.env.PHONE_NUMBER_ID ? '✔️' : '❌',
  OPENAI_API_KEY:         process.env.OPENAI_API_KEY ? '✔️' : '❌',
  SPREADSHEET_ID:         process.env.SPREADSHEET_ID ? '✔️' : '❌',
  ADMIN_WA_NUMBER:        process.env.ADMIN_WA_NUMBER ? '✔️' : '❌',
  POLITICA_URL:           process.env.POLITICA_URL ? '✔️' : '❌',
  GOOGLE_FORMS_ENCUESTA:  process.env.GOOGLE_FORMS_ENCUESTA ? '✔️' : '❌',
  BOOKING_BASE_URL:       process.env.BOOKING_BASE_URL ? '✔️' : '❌',
  GPS_LAT:                process.env.GPS_LAT ? '✔️' : '❌',
  GPS_LNG:                process.env.GPS_LNG ? '✔️' : '❌',
  GPS_NAME:               process.env.GPS_NAME ? '✔️' : '❌',
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
app.use(express.json({ limit: '1mb' }));

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

async function enviarWhatsApp(to, body) {
  const phone = normalizePhone(to);
  if (!phone) { console.error('enviarWhatsApp → número inválido:', to); return; }
  try {
    await axios.post(WHATSAPP_API_URL, {
      messaging_product: 'whatsapp',
      to: phone,
      text: { body }
    }, {
      headers: { Authorization: `Bearer ${process.env.ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
      timeout: 15000
    });
  } catch (error) {
    console.error('Error enviando WhatsApp:', error?.response?.data || error.message);
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
    ducha:      row?.Ducha || '',
    cocina:     row?.Cocina || '',
    tv:         row?.TV || row?.Televisor || '',
    otros:      row?.Notas || row?.Instrucciones || ''
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
  if (msg.interactive?.list_reply?.title)   return { from, text: msg.interactive.list_reply.title.trim() };
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
      if (how.ducha)      msgs.push(`• Ducha: ${how.ducha}`);
      if (how.cocina)     msgs.push(`• Cocina: ${how.cocina}`);
      if (how.tv)         msgs.push(`• TV: ${how.tv}`);
      if (how.otros)      msgs.push(`• Otros: ${how.otros}`);
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
    const { from, text } = getIncomingText(req.body) || {};
    if (!from) return res.sendStatus(200);

    // Normaliza input de texto
    const raw = (text || '').trim();
    if (!raw) return res.sendStatus(200);

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
    console.error('Error en /webhook:', err);
    // Mejor 200 que 5xx para evitar reintentos de Meta
    return res.sendStatus(200);
  }
});

// ===============================
// Health & debug
// ===============================
app.get('/health', (_req, res) => res.json({ ok: true, service: 'whatsapp-webhook' }));

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
      return res.json({ ok: true, r: { available: true, search_url: buildSearchUrl({ checkin, checkout, people: parseInt(people,10) }) }});
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
    return res.json({ ok: true, r: { available: false, search_url: buildSearchUrl({ checkin, checkout, people: parseInt(people,10) }) } });
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
    return res.json({ ok: true, r: { available: false, search_url: buildSearchUrl({ checkin, checkout, people: parseInt(people,10) || 2 }) } });
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
    if (!apto) return res.status(400).json({ ok:false, error:'apto_required' });
    if (!name || !lastname || !email || !phone) {
      return res.status(400).json({ ok:false, error:'missing_fields', needed: ['name','lastname','email','phone'] });
    }

    if (typeof selectAndCheckout !== 'function' || typeof createReservation !== 'function') {
      return res.json({ ok:false, error:'adapter_not_installed', search_url: buildSearchUrl({ checkin, checkout, people }) });
    }

    const sel = await selectAndCheckout({ checkin, checkout, people, apto });
    if (!sel.ok || !sel.checkout_url) {
      return res.status(400).json({ ok:false, error: sel?.error || 'select_failed', search_url: sel?.search_url || buildSearchUrl({ checkin, checkout, people }) });
    }

    const r = await createReservation({
      checkout_url: sel.checkout_url,
      name, lastname, country, email, phone, payment_method
    });

    return res.json({ ok:true, r, checkout_url: sel.checkout_url });
  } catch (e) {
    console.error('[reserve] error', e);
    return res.status(500).json({ ok:false, error:'reserve_failed', message: e?.message });
  }
});

// ===============================
// Start server (Render: 0.0.0.0 + $PORT)
// ===============================
const PORT = process.env.PORT || 3021;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor iniciado en el puerto ${PORT}`);
});
