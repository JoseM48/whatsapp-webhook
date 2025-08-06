require("dotenv").config();
console.log("ACCESS_TOKEN:", process.env.ACCESS_TOKEN ? "✔️ Cargado correctamente" : "❌ No cargado");

const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
const { google } = require("googleapis");
const { OpenAI } = require("openai");
const credentials = require("/etc/secrets/google-creds.json");

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const app = express();
app.use(bodyParser.json());

const VERIFY_TOKEN = "miverificacion";
const WHATSAPP_API_URL = `https://graph.facebook.com/v17.0/${process.env.PHONE_NUMBER_ID}/messages`;

// Mapa para acciones pendientes
const aptoSeekers = {};
const repromptCount = {};

// Función para enviar mensajes por WhatsApp
async function enviarWhatsApp(to, body) {
  try {
    await axios.post(
      WHATSAPP_API_URL,
      {
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { body },
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.ACCESS_TOKEN}`,
          "Content-Type": "application/json",
        },
      }
    );
  } catch (error) {
    console.error("Error enviando mensaje de WhatsApp:", error.response?.data || error.message);
  }
}

// Función GPT con modelo GPT-4
async function consultarChatGPT(pregunta) {
  const respuesta = await openai.chat.completions.create({
    model: "gpt-4",
    messages: [
      {
        role: "system",
        content: "Responde como asistente del hotel Mio La Frontera en Medellín. Responde de forma clara, amable y breve. Si no sabes la respuesta, di que lo consultarás con el equipo humano.",
      },
      {
        role: "user",
        content: pregunta,
      },
    ],
  });

  return respuesta.choices[0].message.content;
}

// Función Sheets
async function obtenerWifiPorApartamento(apto) {
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });

  const sheets = google.sheets({ version: "v4", auth });
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: "Sheet1!A:H",
  });

  const rows = res.data.values || [];
  for (let i = 1; i < rows.length; i++) {
    const [a, est, red, clave] = rows[i];
    if (a?.trim() === apto && est?.toLowerCase() === "activo") {
      return { red, clave };
    }
  }

  return null;
}

// Webhook verification
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode && token === VERIFY_TOKEN) {
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// Webhook listener
app.post("/webhook", async (req, res) => {
  try {
    const msg = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!msg?.text) return res.sendStatus(200);

    const from = msg.from;
    const text = msg.text.body.trim();
    const reply = await generarRespuesta(text, from);
    console.log("Respondido:", reply);
    res.sendStatus(200);
  } catch (err) {
    console.error("Error procesando mensaje:", err);
    res.sendStatus(500);
  }
});

// Lógica del bot
async function generarRespuesta(texto, numero) {
  let respuesta = "";

  if (texto === "1") {
    aptoSeekers[numero] = true;
    respuesta = "Por favor indícame el número de tu apartamento para darte la clave WiFi.";
  } else if (aptoSeekers[numero]) {
    const datos = await obtenerWifiPorApartamento(texto);
    delete aptoSeekers[numero];
    repromptCount[numero] = 0;
    respuesta = datos
      ? `✅ Apartamento ${texto}\nRed WiFi: ${datos.red}\nClave: ${datos.clave}`
      : `No encontré información para el apartamento ${texto}. ¿Podrías verificar el número?`;
  } else if (texto === "2") {
    respuesta = "Horarios: check‑in desde 3 pm y check‑out hasta 11 am.";
  } else if (texto === "3") {
    respuesta = "Puedes pagar vía transferencia (Bancolombia 9070…) o con este enlace: …";
  } else if (texto === "4") {
    respuesta = "Servicios: early check‑in, late‑check‑out, upgrades, guardado de maletas.";
  } else if (texto === "5") {
    respuesta = "Reglas: no fiestas, reportar daños, salidas tarde sin aviso tienen multa.";
  } else if (texto === "6") {
    respuesta = "Te pondremos en contacto con un humano en breve.";
  } else {
    try {
      respuesta = await consultarChatGPT(texto);
    } catch (e) {
      console.error("Error consultando GPT:", e);
      respuesta = `No entendí tu mensaje.`;
    }

    // Repregunta si el usuario no responde en 60 segundos (una sola vez)
    if (!repromptCount[numero]) repromptCount[numero] = 0;
    if (repromptCount[numero] < 1) {
      repromptCount[numero]++;
      setTimeout(() => {
        enviarWhatsApp(numero, "¿Aún estás ahí? 😊");
      }, 60000);
    }
  }

  await enviarWhatsApp(numero, respuesta);
  return respuesta;
}

// Inicia servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Servidor iniciado en el puerto", PORT);
});
