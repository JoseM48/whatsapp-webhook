const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");

const app = express();
app.use(bodyParser.json());

const VERIFY_TOKEN = "miverificacion";
const WHATSAPP_API_URL = "https://graph.facebook.com/v17.0/677794848759133/messages";
const ACCESS_TOKEN = "EAAUfFpnLVusBPB5FazeTYxc3K10IDETZAXxZBp2WSgGQ8SOTP3uYkRHd4AvwR7CF1uOCjwYpyp4FhrTc6ozV4zCB5R8bLveaW6hkn9Ct8CwspZBwDomPDNOMhHcX4Hhk7oYQRIBTPwrmqeu1dFkpPaKY7FX3mh6qz03jfqZB5th6vIIHZANfB8rtsmetCqlcDhSrZAZCrYBpgGcEmIcdRtNaXaMH1qc9gWYj1Y2IETA5gZDZD"; // Reemplaza por tu token de acceso real

// --- Endpoint para verificación inicial del webhook ---
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

// --- Endpoint para recibir mensajes entrantes ---
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

// --- Generador de respuesta ---
async function generarRespuesta(texto, numero) {
  const mensaje = texto.trim();

  let respuesta;

  if (mensaje === "1") {
    respuesta = "Por favor indícame el número de tu apartamento para darte la clave WiFi.";
    // Aquí luego conectaremos a Google Sheets
  } else if (mensaje === "2") {
    respuesta = "El check in es desde las 3 pm 🕒 y el check out hasta las 11 am 🕚. Recepción 24 h.";
  } else if (mensaje === "3") {
    respuesta = `Puedes pagar por transferencia Bancolombia 90700002147 (Versadaa) o con este link: https://checkout.wompi.co/l/CR3cEA 💳`;
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

  // Enviar mensaje de vuelta
  await axios.post(
    WHATSAPP_API_URL,
    {
      messaging_product: "whatsapp",
      to: numero,
      text: { body: respuesta }
    },
    {
      headers: {
        Authorization: `Bearer ${ACCESS_TOKEN}`,
        "Content-Type": "application/json"
      }
    }
  );
}

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log("Servidor escuchando en el puerto", port);
});
