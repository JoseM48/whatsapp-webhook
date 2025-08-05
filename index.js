console.log("TOKEN:", process.env.ACCESS_TOKEN);
const { google } = require('googleapis');
const credentials = require("/etc/secrets/google-creds.json"); // JSON desde Secret File
const SPREADSHEET_ID = process.env.SPREADSHEET_ID; // ID del Sheet como variable de entorno

const aptoSeekers = {}; // Guarda los números que esperan dato de apto
const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");

const app = express();
app.use(bodyParser.json());

const VERIFY_TOKEN = "miverificacion";
const WHATSAPP_API_URL = "https://graph.facebook.com/v17.0/677794848759133/messages";

// --- Función auxiliar para buscar en Google Sheets ---
async function obtenerWifiPorApartamento(apto) {
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });

  const sheets = google.sheets({ version: "v4", auth });

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: "Sheet1!A:H", // Apto hasta Lavadora
  });

  const rows = res.data.values || [];
  for (let i = 1; i < rows.length; i++) {
    const fila = rows[i];
    const aptoSheet = fila[0]?.trim();
    const estado = fila[1]?.toLowerCase();
    const red = fila[2];
    const clave = fila[3];

    if (aptoSheet === apto && estado === "activo") {
      return { red, clave };
    }
  }

  return null;
}

// --- Endpoint para verificación del webhook ---
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode && token === VERIFY_TOKEN) {
    console.log("WEBHOOK_VERIFIED");
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// --- Endpoint para mensajes entrantes ---
app.post("/webhook", async (req, res) => {
  const body = req.body;

  try {
    const entry = body.entry?.[0];
    const message = entry?.changes?.[0]?.value?.messages?.[0];
    const from = message?.from;
    const text = message?.text?.body;

    if (text) {
      const reply = await generarRespuesta(text, from);
      console.log("Respondido:", reply);
    }

    res.sendStatus(200);
  } catch (error) {
    console.error("Error procesando mensaje:", error);
    res.sendStatus(500);
  }
});

// --- Generador de respuestas del bot ---
async function generarRespuesta(texto, numero) {
  const mensaje = texto.trim();
  let respuesta;

  if (mensaje === "1") {
    aptoSeekers[numero] = true;
    respuesta = "Por favor indícame el número de tu apartamento para darte la clave WiFi.";
  } else if (aptoSeekers[numero]) {
    const datosWifi = await obtenerWifiPorApartamento(mensaje);
    delete aptoSeekers[numero];

    if (datosWifi) {
      respuesta = `✅ Apartamento ${mensaje}\nRed WiFi: ${datosWifi.red}\nClave: ${datosWifi.clave}`;
    } else {
      respuesta = `No encontré información para el apartamento ${mensaje}. ¿Podrías verificar el número?`;
    }

  } else if (mensaje === "2") {
    respuesta = "El check in es desde las 3 pm 🕒 y el check out hasta las 11 am 🕚. Recepción 24 h.";
  } else if (mensaje === "3") {
    respuesta = "Puedes pagar por transferencia Bancolombia 90700002147 (Versadaa) o con este link: https://checkout.wompi.co/l/CR3cEA 💳";
  } else if (mensaje === "4") {
    respuesta = "Servicios disponibles: early check-in, late check-out, upgrades y guardado de maletas.";
  } else if (mensaje === "5") {
    respuesta = "Reglas: No fiestas, reportar daños, salidas tarde sin aviso generan multa. ¡Te enviamos el resumen si deseas!";
  } else if (mensaje === "6") {
    respuesta = "Te pondremos en contacto con un humano lo más pronto posible 👤";
  } else {
    respuesta = `¡Hola! Soy el asistente de Mio La Frontera 🌟
Estas son las opciones que puedo ayudarte:

1. Clave del WiFi 🔐
2. Horarios de check in / check out 🕒
3. Formas de pago 💵
4. Servicios adicionales 🧺
5. Reglas de la casa 🏠
6. Hablar con un humano 👤

Responde con el número de la opción que necesitas.`;
  }

  // Enviar respuesta a WhatsApp
  await axios.post(
    WHATSAPP_API_URL,
    {
      messaging_product: "whatsapp",
      to: numero,
      text: { body: respuesta }
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.ACCESS_TOKEN}`,
        "Content-Type": "application/json"
      }
    }
  );
}

// --- Iniciar servidor ---
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log("Servidor escuchando en el puerto", port);
});
