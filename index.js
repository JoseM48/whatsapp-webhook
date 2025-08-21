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
// Si no setean SHEETS_RANGE en Render, usamos tu pestaña "Caracteristicas!A:Z"
const SHEETS_RANGE = process.env.SHEETS_RANGE || "Caracteristicas!A:Z";
function norm(s = "") {
  return String(s || "")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().trim().replace(/\s+/g, " ");
}

// ===== Estados por usuario
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

// --------------------- Sheets helpers genéricos ---------------------
async function cargarTabla() {
  if (!GOOGLE_CREDS) throw new Error("google_creds_missing");
  const auth = new google.auth.GoogleAuth({
    credentials: GOOGLE_CREDS,
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });
  const sheets = google.sheets({ version: "v4", auth });
  const r = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: SHEETS_RANGE,
  });
  const all = r.data.values || [];
  const headersRaw = all[0] || [];
  const headers = headersRaw.map(h => norm(h));
  const indexByHeader = Object.fromEntries(headers.map((h, i) => [h, i]));
  const rows = all.slice(1);
  return { headers, indexByHeader, rows };
}

function findAptoRow(apto, headers, rows) {
  const hAptoIdx = headers.findIndex(h => /aparta?mento/.test(h)); // “Apartamento”
  if (hAptoIdx < 0) return null;
  const target = norm(apto);
  for (const row of rows) {
    const cell = norm(row[hAptoIdx] || "");
    if (cell === target) return row;
  }
  return null;
}

function pickField(row, headers, possibleNames = []) {
  const wanted = possibleNames.map(norm);
  let idx = headers.findIndex(h => wanted.includes(h));
  if (idx >= 0) return row[idx] ?? null;
  idx = headers.findIndex(h => wanted.some(w => h.startsWith(w)));
  if (idx >= 0) return row[idx] ?? null;
  return null;
}

// Lee una fila completa del apto y arma un objeto con campos “claves”
async function obtenerDatosDeApartamento(apto) {
  const { headers, rows } = await cargarTabla();
  const row = findAptoRow(apto, headers, rows);
  if (!row) return null;

  const WIFI_SSID_HEADERS  = ["red wifi actual", "red wifi", "ssid", "red"];
  const WIFI_PASS_HEADERS  = ["clave wifi actual", "clave wifi", "password", "contraseña", "pass"];
  const BEDS_HEADERS       = ["camas/sofocamas", "camas y sofacama", "camas", "camas / sofacamas"];
  const FLOOR_HEADERS      = ["piso", "nivel"];
  const CAPACITY_HEADERS   = ["capacidad"];
  const WASHER_HEADERS     = ["lavadora", "lavadora y secadora"];

  const ssid   = pickField(row, headers, WIFI_SSID_HEADERS);
  const clave  = pickField(row, headers, WIFI_PASS_HEADERS);
  const camas  = pickField(row, headers, BEDS_HEADERS);
  const piso   = pickField(row, headers, FLOOR_HEADERS);
  const cap    = pickField(row, headers, CAPACITY_HEADERS);
  const lava   = pickField(row, headers, WASHER_HEADERS);

  return {
    ssid: ssid || null,
    clave: clave || null,
    camas: camas || null,
    piso: piso || null,
    capacidad: cap || null,
    lavadora: lava || null,
  };
}

// Compat: función antigua que devuelve solo WiFi
async function obtenerWifiPorApartamento(apto) {
  const d = await obtenerDatosDeApartamento(apto);
  if (!d) return null;
  if (!d.ssid && !d.clave) return null;
  return { red: d.ssid, clave: d.clave };
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
      const d = await obtenerDatosDeApartamento(texto);
      if (d && (d.ssid || d.clave)) {
        const extra = [
          d.camas ? `Camas: ${d.camas}` : null,
          d.piso ? `Piso: ${d.piso}` : null,
          d.capacidad ? `Capacidad: ${d.capacidad}` : null,
          d.lavadora ? `Lavadora: ${d.lavadora}` : null,
        ].filter(Boolean).join("\n");
        respuesta =
          `✅ Apartamento ${texto}\n` +
          (d.ssid ? `Red WiFi: ${d.ssid}\n` : "") +
          (d.clave ? `Clave: ${d.clave}\n` : "") +
          (extra ? `${extra}` : "");
      } else {
        respuesta = `No encontré datos para el apartamento ${texto}. ¿Podrías verificar el número?`;
      }
    } catch (e) {
      console.error("Sheets error:", e?.response?.data || e?.message || e);
      respuesta = "No pude consultar la hoja ahora mismo. Te apoyo con un humano.";
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

// ===== Debug Sheets
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

// Vista previa de headers y primeras filas
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

// Fila cruda del apto (para depurar coincidencias)
app.get("/debug/sheets/find", async (req, res) => {
  try {
    const apto = String(req.query.apto || "").trim();
    if (!apto) return res.status(400).json({ ok: false, error: "apto_required" });
    if (!GOOGLE_CREDS) return res.status(500).json({ ok: false, error: "google_creds_missing" });

    const { headers, rows } = await cargarTabla();
    const row = findAptoRow(apto, headers, rows);
    return res.json({ ok: true, range: SHEETS_RANGE, apto, match: row || null, headers });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || "find_failed" });
  }
});

// ===== Start server (Render: 0.0.0.0 + $PORT)
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Servidor iniciado en el puerto ${PORT}`);
});
