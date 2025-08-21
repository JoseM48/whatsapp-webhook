// index.js
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const express = require("express");
const axios = require("axios");
const { google } = require("googleapis");
const { OpenAI } = require("openai");

// ===== Logs de env críticos (sin exponer valores)
console.log("ENV CHECK →", {
  ACCESS_TOKEN: !!process.env.ACCESS_TOKEN,
  VERIFY_TOKEN: !!process.env.VERIFY_TOKEN,
  PHONE_NUMBER_ID: !!process.env.PHONE_NUMBER_ID,
  OPENAI_API_KEY: !!process.env.OPENAI_API_KEY,
  SPREADSHEET_ID: !!process.env.SPREADSHEET_ID,
});

// ===== Carga robusta de credenciales Google (ruta, JSON inline o archivo local)
function loadGoogleCreds() {
  const fromEnvPath = (process.env.GOOGLE_APPLICATION_CREDENTIALS || "").trim();
  if (fromEnvPath && fs.existsSync(fromEnvPath)) {
    console.log("[google-creds] usando ruta GOOGLE_APPLICATION_CREDENTIALS:", fromEnvPath);
    return JSON.parse(fs.readFileSync(fromEnvPath, "utf8"));
  }
  const fromEnvJson = (process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON || "").trim();
  if (fromEnvJson) {
    console.log("[google-creds] usando JSON inline de GOOGLE_APPLICATION_CREDENTIALS_JSON");
    return JSON.parse(fromEnvJson);
  }
  const localPath = path.resolve(__dirname, "google-creds.json");
  if (fs.existsSync(localPath)) {
    console.log("[google-creds] usando archivo local:", localPath);
    return JSON.parse(fs.readFileSync(localPath, "utf8"));
  }
  throw new Error("google_creds_missing");
}
let GOOGLE_CREDS = null;
try {
  GOOGLE_CREDS = loadGoogleCreds();
} catch (e) {
  console.warn("[google-creds] no cargadas aún:", e.message);
}

// ===== OpenAI
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ===== Config
const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3021;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "dev-verify-token";
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const WHATSAPP_API_URL = `https://graph.facebook.com/v17.0/${process.env.PHONE_NUMBER_ID}/messages`;

// ===== Sheets: rango configurable y normalizador
// Cambia en ENV si la pestaña se llama distinto
const SHEETS_RANGE = process.env.SHEETS_RANGE || "Maestro Mio Bot La Frontera!A:D";
function norm(s = "") {
  return String(s || "")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().trim().replace(/\s+/g, " ");
}

// Estados simples por usuario
const aptoSeekers = Object.create(null);
const repromptCount = Object.create(null);

// ===== Utils
function onlyDigits(s = "") {
  return (s || "").replace(/[^\d]/g, "");
}
function normalizePhone(raw, defaultCc = "57") {
  const digits = onlyDigits(raw);
  if (!digits) return null;
  if (digits.length >= 11 && digits.length <= 15) return digits; // ya incluye CC
  if (digits.length === 10) return defaultCc + digits;           // agrega CC CO
  return digits;
}

// ===== WhatsApp: enviar texto
async function enviarWhatsApp(to, body) {
  const phone = normalizePhone(to);
  if (!phone) {
    console.error("enviarWhatsApp → número inválido:", to);
    return;
  }
  try {
    await axios.post(
      WHATSAPP_API_URL,
      {
        messaging_product: "whatsapp",
        to: phone,
        type: "text",
        text: { body },
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.ACCESS_TOKEN}`,
          "Content-Type": "application/json",
        },
        timeout: 15000,
      }
    );
  } catch (error) {
    console.error("Error enviando WhatsApp:", error?.response?.data || error.message);
  }
}

// ===== OpenAI (respuesta breve)
async function consultarChatGPT(pregunta) {
  const r = await openai.chat.completions.create({
    model: "gpt-4",
    messages: [
      {
        role: "system",
        content:
          "Eres el asistente del hotel Mio La Frontera en Medellín. Responde claro, amable y breve. " +
          "Si no sabes la respuesta, di que lo consultarás con el equipo humano.",
      },
      { role: "user", content: pregunta },
    ],
    temperature: 0.4,
    max_tokens: 300,
  });
  return r.choices[0]?.message?.content?.trim() || "Gracias por tu mensaje.";
}

// ===== Google Sheets (usa SHEETS_RANGE y coincidencia robusta)
async function obtenerWifiPorApartamento(apto) {
  if (!GOOGLE_CREDS) throw new Error("google_creds_missing");
  const auth = new google.auth.GoogleAuth({
    credentials: GOOGLE_CREDS,
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });
  const sheets = google.sheets({ version: "v4", auth });
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: SHEETS_RANGE, // <— configurable por ENV
  });
  const rows = res.data.values || [];
  if (rows.length <= 1) return null;

  const target = norm(apto);
  for (let i = 1; i < rows.length; i++) {
    const [a, est, red, clave] = rows[i];
    const aptoCell = norm(a);
    const estadoCell = norm(est);
    const isActivo = estadoCell.startsWith("activo"); // “Activo”, “ACTIVO”, etc.
    if (aptoCell === target && isActivo) {
      return { red, clave };
    }
  }
  return null;
}

// ===== Health
app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "whatsapp-webhook" });
});

// ===== Webhook verification (GET)
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// ===== Extraer texto de diferentes tipos
function getIncomingText(payload) {
  const msg = payload?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
  if (!msg) return { from: null, text: null };
  const from = msg.from;
  if (msg.text?.body) return { from, text: msg.text.body.trim() };
  if (msg.interactive?.button_reply?.title)
    return { from, text: msg.interactive.button_reply.title.trim() };
  if (msg.interactive?.list_reply?.title)
    return { from, text: msg.interactive.list_reply.title.trim() };
  return { from, text: null };
}

// ===== Webhook listener (POST)
app.post("/webhook", (req, res) => {
  try {
    const { from, text } = getIncomingText(req.body);
    if (from && text) {
      generarRespuesta(text, from).catch((err) =>
        console.error("Error procesando mensaje:", err)
      );
    }
    // Responder 200 SIEMPRE para evitar reintentos de Meta
    return res.sendStatus(200);
  } catch (err) {
    console.error("Error en /webhook:", err);
    return res.sendStatus(200);
  }
});

// ===== Bot logic
async function generarRespuesta(texto, numero) {
  let respuesta = "";

  if (texto === "1") {
    aptoSeekers[numero] = true;
    respuesta = "Por favor indícame el número de tu apartamento para darte la clave WiFi.";
  } else if (aptoSeekers[numero]) {
    try {
      const datos = await obtenerWifiPorApartamento(texto);
      respuesta = datos
        ? `✅ Apartamento ${texto}\nRed WiFi: ${datos.red}\nClave: ${datos.clave}`
        : `No encontré información para el apartamento ${texto}. ¿Podrías verificar el número?`;
    } catch (e) {
      console.error("Sheets error:", e?.response?.data || e?.message || e);
      respuesta = "No pude consultar el WiFi ahora mismo. Te apoyo con un humano.";
    } finally {
      delete aptoSeekers[numero];
      repromptCount[numero] = 0;
    }
  } else if (texto === "2") {
    respuesta = "Horarios: check-in desde 3 pm y check-out hasta 11 am.";
  } else if (texto === "3") {
    respuesta = "Puedes pagar vía transferencia (Bancolombia 9070…) o con este enlace: …";
  } else if (texto === "4") {
    respuesta = "Servicios: early check-in, late-check-out, upgrades, guardado de maletas.";
  } else if (texto === "5") {
    respuesta = "Reglas: no fiestas, reportar daños, salidas tarde sin aviso tienen multa.";
  } else if (texto === "6") {
    respuesta = "Te pondremos en contacto con un humano en breve.";
  } else {
    try {
      respuesta = await consultarChatGPT(texto);
    } catch (e) {
      console.error("Error consultando GPT:", e?.response?.data || e?.message || e);
      respuesta = "No entendí tu mensaje.";
    }
    // Repregunta una vez a los 60s
    if (!repromptCount[numero]) repromptCount[numero] = 0;
    if (repromptCount[numero] < 1) {
      repromptCount[numero]++;
      setTimeout(() => enviarWhatsApp(numero, "¿Aún estás ahí? 😊"), 60_000);
    }
  }

  await enviarWhatsApp(numero, respuesta);
  console.log("Respondido:", { to: numero, texto, respuesta });
  return respuesta;
}

// ===== Debug Sheets (existente)
app.get("/debug/sheets", async (req, res) => {
  try {
    const apto = String(req.query.apto || "").trim();
    if (!apto) return res.status(400).json({ ok: false, error: "apto_required" });
    const data = await obtenerWifiPorApartamento(apto);
    return res.json({ ok: true, apto, data, spreadsheetId: SPREADSHEET_ID, range: SHEETS_RANGE });
  } catch (e) {
    console.error("[debug/sheets] error:", e?.response?.data || e?.message || e);
    return res.status(500).json({ ok: false, error: "sheets_failed" });
  }
});

// ===== NUEVOS endpoints de debug
app.get("/debug/sheets/preview", async (_req, res) => {
  try {
    if (!GOOGLE_CREDS) return res.status(500).json({ ok: false, error: "google_creds_missing" });
    const auth = new google.auth.GoogleAuth({
      credentials: GOOGLE_CREDS,
      scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
    });
    const sheets = google.sheets({ version: "v4", auth });
    const r = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: SHEETS_RANGE,
    });
    const rows = r.data.values || [];
    res.json({
      ok: true,
      range: SHEETS_RANGE,
      headers: rows[0] || [],
      sample: rows.slice(1, 11),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || "preview_failed" });
  }
});

app.get("/debug/sheets/find", async (req, res) => {
  try {
    const apto = String(req.query.apto || "").trim();
    if (!apto) return res.status(400).json({ ok: false, error: "apto_required" });
    if (!GOOGLE_CREDS) return res.status(500).json({ ok: false, error: "google_creds_missing" });

    const auth = new google.auth.GoogleAuth({
      credentials: GOOGLE_CREDS,
      scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
    });
    const sheets = google.sheets({ version: "v4", auth });
    const r = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: SHEETS_RANGE,
    });
    const rows = r.data.values || [];
    const target = norm(apto);
    let match = null;
    for (let i = 1; i < rows.length; i++) {
      const [a] = rows[i];
      if (norm(a) === target) { match = rows[i]; break; }
    }
    res.json({ ok: true, range: SHEETS_RANGE, apto, match });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || "find_failed" });
  }
});

// ===== Start server (Render: 0.0.0.0 + $PORT)
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Servidor iniciado en el puerto ${PORT}`);
});
