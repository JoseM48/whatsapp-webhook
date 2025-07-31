const express = require("express");
const bodyParser = require("body-parser");

const app = express();
app.use(bodyParser.json());

const VERIFY_TOKEN = "miverificacion"; // Cámbialo por el que usarás en Meta

// Endpoint para la verificación
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

// Endpoint para recibir mensajes
app.post("/webhook", (req, res) => {
  const body = req.body;
  console.log(JSON.stringify(body, null, 2));
  res.sendStatus(200);
});

// Puerto para Render
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log("Servidor escuchando en el puerto", port);
});
